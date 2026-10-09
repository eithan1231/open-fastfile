// The resolver: turns a validated, include-expanded statement list into a
// flat, three.js-agnostic `ResolvedWorld` — absolute positions, rotations and
// sizes in metres/radians for every placement, light and trigger. This is a
// pure data transform (no DOM, no three.js) so it can run identically in the
// browser, on a game server and in the headless `pnpm check` CLI.
//
// Axis convention (documented in worlds/AUTHORING.md): +X = east, +Z = south.
//
// A group is the only nesting: a placement's world position is its enclosing
// group's origin plus its own `at:`, rotated into that group's frame. Groups
// resolve depth-first and memoize, with cycle detection, so declaration order
// does not matter.

import type { ObjectNode, PropertyNode, Statement } from "./ast.js";
import { isObjectNode } from "./ast.js";
import type { Diagnostic } from "./diagnostics.js";
import { didYouMean, error, hasErrors, warning } from "./diagnostics.js";
import { validateStatements } from "./schema.js";
import { addVec, boolOf, colorOf, enumOf, findProp, modesOf, numbersOf, refOf, rotateY, rotationOf, stringOf, stringsOf, vec3, vecOf } from "./resolveUtil.js";
import { toMeters, toRadians } from "./units.js";
import { UNASSIGNED_ENTITY_ID } from "./resolved.js";
import type {
  Vec3,
  CatalogEntryRef,
  ResolvedAsset,
  CollideMode,
  ResolvedObject,
  ResolvedBehaviours,
  ResolvedSpawn,
  ResolvedTrigger,
  ResolvedPoint,
  ResolvedSolid,
  UseMode,
  ResolvedLadder,
  ResolvedMantle,
  ResolvedEffect,
  ResolvedSound,
  ResolvedLight,
  ResolvedGrade,
  ResolvedMinimap,
  ResolvedWorld,
  ResolveResult,
} from "./resolved.js";

// ---------------------------------------------------------------------------
// Small geometry + AST helpers
// ---------------------------------------------------------------------------

function collideOf(prop: PropertyNode | undefined): CollideMode {
  const v = prop?.values[0];
  if (v?.kind === "bool") {
    return v.value ? "mesh" : "none";
  }
  if (v?.kind === "ref" && v.path.length === 1) {
    if (v.path[0] === "box") {
      return "box";
    }
    if (v.path[0] === "hull") {
      return "hull";
    }
  }
  return "mesh";
}

const SHAPE_TYPES = new Set(["box", "cylinder", "sphere", "cone", "plane", "torus", "model"]);

// ---------------------------------------------------------------------------
// Resolve context
// ---------------------------------------------------------------------------

interface Scope {
  /** World-space origin this scope's plain `at:` offsets are measured from. */
  origin: Vec3;
  /** Yaw already applied to this scope (from an enclosing rotated group), added to children's own rotation. */
  yaw: number;
}

interface ResolvedPlacement {
  position: Vec3;
  rotation: Vec3;
}

/** The frame a top-level placement sits in: the world origin, unrotated. */
function topLevelScope(): Scope {
  return { origin: vec3(0, 0, 0), yaw: 0 };
}

class ResolveContext {
  diagnostics: Diagnostic[] = [];
  /** Declared `asset` nodes. */
  modelAssets = new Map<string, ResolvedAsset>();
  groupScopes = new Map<ObjectNode, Scope>();
  parentOf = new Map<ObjectNode, ObjectNode | undefined>();
  resolvedObjects = new Map<ObjectNode, ResolvedObject>();
  resolving = new Set<ObjectNode>();
  /**
   * Next `ResolvedObject.id`. Spent in `resolveScopeBody`, which is the one
   * place an object is emitted — not in `resolvePlaceable`, which the anchor
   * graph calls out of order and memoizes, and which would therefore number by
   * anchor-resolution order rather than by declaration order.
   */
  nextEntityId = 0;
  /** Every `target:` read, checked against every tag once all kinds are resolved (`checkTargets`). */
  private targets: { target: string; span: Statement["span"] }[] = [];

  err(message: string, span: Statement["span"], code?: string): void {
    this.diagnostics.push(error(message, span, code));
  }
  warn(message: string, span: Statement["span"], code?: string): void {
    this.diagnostics.push(warning(message, span, code));
  }

  /** A node's `target:`, remembered so `checkTargets` can say when nothing carries it. */
  private targetOf(node: ObjectNode): string | undefined {
    const prop = findProp(node, "target");
    const target = stringOf(prop);
    if (prop && target !== undefined) {
      this.targets.push({ target, span: prop.span });
    }
    return target;
  }

  /**
   * A `target` naming a tag no node carries. A warning, not an error: the world
   * still loads and means something, and a script reading the link gets an empty
   * set — but it is almost always a typo or a node lost in a re-export.
   */
  checkTargets(tags: ReadonlySet<string>): void {
    for (const { target, span } of this.targets) {
      if (!tags.has(target)) {
        this.warn(`"target" names tag "${target}", which no node carries${didYouMean(target, tags)}`, span, "unknown-target");
      }
    }
  }

  buildAssets(nodes: ObjectNode[]): void {
    for (const node of nodes) {
      const name = node.name!;
      const source = stringOf(findProp(node, "source"))!;
      const until = numbersOf(findProp(node, "until"), (v) => v)[0];
      const hullProp = findProp(node, "hull");
      const hull = numbersOf(hullProp, (v) => v)[0];
      // `hull` was an index into a LOD chain; with one mesh per asset, 0 is the only level.
      if (hull !== undefined && hull !== 0) {
        this.err(`asset "${name}" has "hull: ${hull}", but an asset has one mesh: use "hull: 0"`, hullProp!.span, "bad-hull-index");
      }
      const catalogProp = findProp(node, "catalog");
      const catalog = catalogProp === undefined ? undefined : this.catalogRefOf(name, stringOf(catalogProp)!, catalogProp.span);
      this.modelAssets.set(name, { name, source, catalog, until, hull });
    }
  }

  /**
   * `<kind>/<game>/<id>` as three segments, or undefined with a diagnostic.
   *
   * The shape only. Whether the catalogue actually holds the entry is nobody's
   * business here: a world resolves identically in a browser, on a game server and
   * in `pnpm check`, and only some of those have ever seen a catalogue. The same
   * division a weapon id has always had.
   */
  private catalogRefOf(name: string, value: string, span: Statement["span"]): CatalogEntryRef | undefined {
    const parts = value.split("/");
    if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
      this.err(`asset "${name}" has "catalog: ${value}", which is not a catalogue entry "<kind>/<game>/<id>"`, span, "bad-catalog-ref");
      return undefined;
    }
    const [kind, game, id] = parts as [string, string, string];
    return { kind, game, id };
  }

  checkAssetRef(path: string[] | undefined, span: Statement["span"]): string | undefined {
    if (!path) {
      return undefined;
    }
    if (path.length !== 1) {
      this.err(`asset reference must be a plain name, found "${path.join(".")}"`, span, "bad-asset-ref");
      return undefined;
    }
    const name = path[0]!;
    if (!this.modelAssets.has(name)) {
      this.err(`unknown asset "${name}"${didYouMean(name, this.modelAssets.keys())}`, span, "unknown-asset");
      return undefined;
    }
    return name;
  }

  private scopeFor(parent: ObjectNode | undefined): Scope {
    if (!parent) {
      return topLevelScope();
    }
    // parent is a group: resolve it (as a synthetic placeable) to get its world origin + yaw.
    return this.resolveGroupOrigin(parent);
  }

  private resolveGroupOrigin(group: ObjectNode): Scope {
    const cacheKey = group;
    const cached = this.groupScopes.get(cacheKey);
    if (cached) {
      return cached;
    }

    if (this.resolving.has(group)) {
      this.err(`circular placement reference involving group "${group.name ?? "<anonymous>"}"`, group.typeSpan, "circular-reference");
      return topLevelScope();
    }
    this.resolving.add(group);

    const grandparent: ObjectNode | undefined = this.parentOf.get(group);
    const outerScope = this.scopeFor(grandparent);
    const placement = this.placementFor(group, outerScope);

    const scope: Scope = { origin: placement.position, yaw: outerScope.yaw + placement.rotation.y };
    this.resolving.delete(group);
    this.groupScopes.set(cacheKey, scope);
    return scope;
  }

  // -- placement -----------------------------------------------------------

  /** Compute world position + rotation for a placeable node within `scope`. */
  private placementFor(node: ObjectNode, scope: Scope): ResolvedPlacement {
    const explicitRotation = rotationOf(findProp(node, "rotate"), toRadians);

    // `at` is a local (x,y,z) offset from the scope origin, rotated into the
    // scope's frame if it sits inside a rotated group.
    const local = vecOf(findProp(node, "at"), toMeters);
    const worldOffset = rotateY(local, scope.yaw);
    return { position: addVec(scope.origin, worldOffset), rotation: vec3(explicitRotation.x, scope.yaw + explicitRotation.y, explicitRotation.z) };
  }

  private sizeAndScaleFor(node: ObjectNode): { size: Vec3; scale: Vec3 } {
    const sizeProp = findProp(node, "size");
    const n = numbersOf(sizeProp, toMeters);
    let size: Vec3;
    if (n.length === 0) {
      this.warn(`"${node.type}"${node.name ? ` ${node.name}` : ""} has no size, defaulting to 1x1x1m`, node.typeSpan, "missing-size");
      size = vec3(1, 1, 1);
    } else if (node.type === "sphere" && n.length === 1) {
      size = vec3(n[0]!, n[0]!, n[0]!);
    } else if (node.type === "plane" || node.type === "torus") {
      size = vec3(n[0] ?? 1, n[1] ?? n[0] ?? 1, n[1] ?? n[0] ?? 1);
    } else {
      size = vec3(n[0] ?? 1, n[1] ?? n[0] ?? 1, n[2] ?? n[0] ?? 1);
    }

    const scaleProp = findProp(node, "scale");
    const sVals = numbersOf(scaleProp, (v) => v);
    let scale: Vec3;
    if (sVals.length === 0) {
      scale = vec3(1, 1, 1);
    } else if (sVals.length === 1) {
      scale = vec3(sVals[0]!, sVals[0]!, sVals[0]!);
    } else if (sVals.length === 3) {
      scale = vec3(sVals[0]!, sVals[1]!, sVals[2]!);
    } else {
      this.err(`"scale" expects 1 or 3 values, found ${sVals.length}`, scaleProp!.span, "bad-scale-arity");
      scale = vec3(1, 1, 1);
    }
    return { size, scale };
  }

  /** Fully resolve a placement (not a group) into a flat ResolvedObject. */
  private resolvePlaceable(node: ObjectNode, scope: Scope): ResolvedObject | undefined {
    if (this.resolving.has(node)) {
      this.err(`circular placement reference involving "${node.name ?? node.type}"`, node.typeSpan, "circular-reference");
      return undefined;
    }
    this.resolving.add(node);

    const { size, scale } = this.sizeAndScaleFor(node);
    const placement = this.placementFor(node, scope);
    const collide = collideOf(findProp(node, "collide"));
    const visible = boolOf(findProp(node, "visible"), true);

    // A `model` is the one shape whose geometry lives outside the file, so the
    // path is required — without it there is nothing to draw at all.
    // schema.ts already rejects a `model` with no `asset:`, so a miss here is
    // a bad *reference* (reported by checkAssetRef), not a missing property.
    const assetProp = node.type === "model" ? findProp(node, "asset") : undefined;
    const asset = assetProp ? this.checkAssetRef(refOf(assetProp), assetProp.span) : undefined;

    // Baked lighting for an imported shell. `model`-only: the texture is
    // sampled through the glTF's own second UV set, which no procedural shape
    // has. schema.ts already restricts both properties to `model`.
    const lightmap = node.type === "model" ? stringOf(findProp(node, "lightmap")) : undefined;
    // Coplanar overlay geometry — an imported map's decal pass. Not a look but a
    // depth-buffer fact: without a bias it and the surface it lies on have equal
    // depth and which one survives is decided by floating-point noise, so the
    // stains flicker in and out as the camera turns.
    const decal = node.type === "model" ? boolOf(findProp(node, "decal"), false) : false;
    const animation = node.type === "model" ? stringOf(findProp(node, "animate")) : undefined;
    const lightmapIntensityProp = findProp(node, "lightmap-intensity");
    const lightmapIntensity = numbersOf(lightmapIntensityProp, (n) => n)[0] ?? 1;
    if (lightmapIntensityProp && !lightmap) {
      this.warn(
        `"lightmap-intensity" has no effect without "lightmap" on "${node.name ?? node.type}"`,
        lightmapIntensityProp.span,
        "unused-lightmap-intensity",
      );
    }

    const object: ResolvedObject = {
      // Spent on emission in `resolveScopeBody`, not here: this runs in anchor
      // order. An object that is built but never emitted keeps the sentinel.
      id: UNASSIGNED_ENTITY_ID,
      name: node.name,
      tags: stringsOf(findProp(node, "tag")),
      modes: modesOf(findProp(node, "mode")),
      asset,
      lightmap,
      lightmapIntensity,
      decal,
      animation,
      position: placement.position,
      rotation: placement.rotation,
      scale,
      size,
      collide,
      visible,
      behaviours: this.resolveBehaviours(node),
    };

    this.resolving.delete(node);
    this.resolvedObjects.set(node, object);
    return object;
  }

  /**
   * The `behaviours` block, if the placement declared one. Each behaviour is its
   * own node, so schema.ts has already checked its properties — this only has to
   * read them.
   */
  private resolveBehaviours(node: ObjectNode): ResolvedBehaviours | undefined {
    const block = node.body.find((s): s is ObjectNode => isObjectNode(s) && s.type === "behaviours");
    if (!block) {
      return undefined;
    }

    const out: ResolvedBehaviours = {};
    for (const stmt of block.body) {
      if (!isObjectNode(stmt)) {
        continue;
      }
      if (stmt.type === "health") {
        const amount = numbersOf(findProp(stmt, "amount"), (n) => n)[0] ?? 0;
        if (amount <= 0) {
          this.err(`"amount" must be greater than zero, not ${amount}`, stmt.span, "bad-health");
          continue;
        }
        out.health = { amount };
      } else if (stmt.type === "destructible") {
        const preset = stringOf(findProp(stmt, "preset"));
        if (preset !== undefined) {
          out.destructible = { preset };
        }
      }
    }

    // An empty block is a no-op rather than an error, but it is always a mistake
    // worth saying out loud: somebody meant to put something in it.
    if (Object.keys(out).length === 0) {
      this.warn(`"behaviours" is empty, so it does nothing`, block.span, "empty-behaviours");
      return undefined;
    }

    return out;
  }

  // -- top-down traversal ---------------------------------------------------

  /** Walk a group body (or the top level), resolving every placement, light and nested group in declaration order. */
  resolveScopeBody(body: Statement[], scope: Scope, out: { objects: ResolvedObject[]; lights: ResolvedLight[] }): void {
    for (const stmt of body) {
      if (!isObjectNode(stmt)) {
        continue;
      }
      if (stmt.type === "door" || stmt.type === "window" || stmt.type === "opening") {
        continue;
      } // handled in phase 1

      if (stmt.type === "group") {
        const inner = this.resolveGroupOrigin(stmt);
        this.resolveScopeBody(stmt.body, inner, out);
        continue;
      }

      if (stmt.type === "light") {
        out.lights.push(this.resolveLight(stmt, scope));
        continue;
      }

      if (SHAPE_TYPES.has(stmt.type) || stmt.type === "stairs" || stmt.type === "wall") {
        let object = this.resolvedObjects.get(stmt);
        if (!object) {
          object = this.resolvePlaceable(stmt, scope);
        }
        if (object) {
          // The single emission point, so this is the single place an id is
          // spent. A memoized object reaches it exactly once.
          object.id = this.nextEntityId++;
          out.objects.push(object);
        }
      }
    }
  }

  /**
   * Every node of one type in a scope, in declaration order, already placed.
   *
   * The mechanical half the placed-node walkers share: descend into groups so a
   * group's origin and yaw apply to what is in it, and compose `at` and `rotate`
   * against that scope. What each node *means* stays with the node — `build`
   * reads its own properties and does its own validation.
   *
   * None of these are `ResolvedObject`s: they have no geometry and nothing draws
   * them, so they are numbered from the same counter but only after every object
   * has an id.
   */
  private resolvePlaced<T>(
    body: Statement[],
    scope: Scope,
    // A union rather than `string`: a typo would otherwise match no node and
    // resolve to an empty list, which is indistinguishable from a world that
    // declared none.
    type: "trigger" | "mantle" | "effect" | "ladder" | "sound",
    out: T[],
    build: (node: ObjectNode, position: Vec3, rotation: Vec3) => T | undefined,
  ): void {
    for (const stmt of body) {
      if (!isObjectNode(stmt)) {
        continue;
      }

      // `resolveGroupOrigin` is memoized, so asking again here is free.
      if (stmt.type === "group") {
        this.resolvePlaced(stmt.body, this.resolveGroupOrigin(stmt), type, out, build);
        continue;
      }

      if (stmt.type !== type) {
        continue;
      }

      const local = vecOf(findProp(stmt, "at"), toMeters);
      const position = addVec(scope.origin, rotateY(local, scope.yaw));
      const rotate = rotationOf(findProp(stmt, "rotate"), toRadians);
      const resolved = build(stmt, position, vec3(rotate.x, scope.yaw + rotate.y, rotate.z));
      if (resolved !== undefined) {
        out.push(resolved);
      }
    }
  }

  /** `trigger` nodes in one scope: a box (`size`) or a sphere (`radius`), never both. */
  resolveTriggers(body: Statement[], scope: Scope, out: ResolvedTrigger[]): void {
    this.resolvePlaced(body, scope, "trigger", out, (stmt, position, rotation) => {
      const sizeProp = findProp(stmt, "size");
      const radiusProp = findProp(stmt, "radius");
      if (sizeProp && radiusProp) {
        this.err(`a trigger is either a box ("size") or a sphere ("radius"), not both`, stmt.span, "trigger-shape");
        return undefined;
      }
      if (!sizeProp && !radiusProp) {
        this.err(`a trigger needs a "size" (a box) or a "radius" (a sphere)`, stmt.span, "trigger-shape");
        return undefined;
      }

      const heightProp = findProp(stmt, "height");
      if (heightProp && !radiusProp) {
        this.warn(`"height" has no effect on a box trigger; its "size" already gives one`, heightProp.span, "unused-height");
      }

      return {
        id: this.nextEntityId++,
        name: stmt.name,
        tags: stringsOf(findProp(stmt, "tag")),
        target: this.targetOf(stmt),
        modes: modesOf(findProp(stmt, "mode")),
        use: enumOf(findProp(stmt, "use")) as UseMode | undefined,
        position,
        yaw: rotation.y,
        size: sizeProp ? vecOf(sizeProp, toMeters) : undefined,
        radius: radiusProp ? numbersOf(radiusProp, toMeters)[0] : undefined,
        height: radiusProp && heightProp ? numbersOf(heightProp, toMeters)[0] : undefined,
      };
    });
  }

  /** `mantle` nodes in one scope: always a box, whose top the simulation reads as a height. */
  resolveMantles(body: Statement[], scope: Scope, out: ResolvedMantle[]): void {
    this.resolvePlaced(body, scope, "mantle", out, (stmt, position, rotation) => {
      const size = vecOf(findProp(stmt, "size"), toMeters);
      if (size.y <= 0) {
        this.err(`a mantle's "size" needs a height: its top is the surface a player ends on`, stmt.span, "mantle-size");
        return undefined;
      }

      return {
        id: this.nextEntityId++,
        name: stmt.name,
        tags: stringsOf(findProp(stmt, "tag")),
        position,
        yaw: rotation.y,
        size,
        kind: enumOf(findProp(stmt, "kind")) as ResolvedMantle["kind"],
      };
    });
  }

  /** `ladder` nodes in one scope: a box, which the world's collision already holds as a wall. */
  resolveLadders(body: Statement[], scope: Scope, out: ResolvedLadder[]): void {
    this.resolvePlaced(body, scope, "ladder", out, (stmt, position, rotation) => {
      const size = vecOf(findProp(stmt, "size"), toMeters);
      if (size.x <= 0 || size.y <= 0 || size.z <= 0) {
        this.err(`a ladder's "size" needs all three extents: the box is the ladder itself`, stmt.span, "ladder-size");
        return undefined;
      }

      return {
        id: this.nextEntityId++,
        name: stmt.name,
        tags: stringsOf(findProp(stmt, "tag")),
        position,
        yaw: rotation.y,
        size,
        face: enumOf(findProp(stmt, "face")) as ResolvedLadder["face"],
      };
    });
  }

  /**
   * `effect` nodes in one scope: where the world plays an effect out of its `fx`
   * library. Unlike the two volumes, an effect is oriented on all three axes — a
   * sand spray is aimed at a surface, not just turned.
   */
  resolveEffects(body: Statement[], scope: Scope, out: ResolvedEffect[]): void {
    this.resolvePlaced(body, scope, "effect", out, (stmt, position, rotation) => ({
      id: this.nextEntityId++,
      name: stmt.name,
      tags: stringsOf(findProp(stmt, "tag")),
      position,
      rotation,
      fx: stringOf(findProp(stmt, "fx"))!,
      delay: numbersOf(findProp(stmt, "delay"), (v) => v)[0] ?? 0,
      repeat: Math.max(numbersOf(findProp(stmt, "repeat"), (v) => v)[0] ?? 0, 0),
    }));
  }

  /**
   * `sound` nodes in one scope: where the world plays one of its aliases.
   *
   * The one placement whose position is optional. A `sound` with no `at` is the
   * world's bed, so the origin the walker worked out for it is dropped rather
   * than carried: inside a group that would be the group's own origin, and a bed
   * that plays from one corner of a map is a map with no ambience.
   */
  resolveSounds(body: Statement[], scope: Scope, hasLibrary: boolean, out: ResolvedSound[]): void {
    let reportedLibrary = false;
    this.resolvePlaced(body, scope, "sound", out, (stmt, position) => {
      const aliasProp = findProp(stmt, "alias")!;
      const alias = refOf(aliasProp);
      if (!alias || alias.length !== 1) {
        this.err(`a sound's "alias" is a plain name, found "${alias?.join(".") ?? ""}"`, aliasProp.span, "bad-alias-ref");
        return undefined;
      }

      // Once per world, not once per placement: a world that forgot its table
      // forgot it for every emitter in it, and an imported map has hundreds.
      if (!hasLibrary && !reportedLibrary) {
        reportedLibrary = true;
        this.err(`"sound" names an alias, but this world declares no "sounds" table to find one in`, stmt.typeSpan, "no-sound-library");
      }

      const rangeProp = findProp(stmt, "range");
      const [near, far] = numbersOf(rangeProp, toMeters);
      // The schema has already required two values, so both are numbers here.
      if (rangeProp && far! < near!) {
        this.err(`a sound's "range" is a reference distance then a maximum, and ${far} is inside ${near}`, rangeProp.span, "sound-bad-range");
        return undefined;
      }

      return {
        id: this.nextEntityId++,
        name: stmt.name,
        tags: stringsOf(findProp(stmt, "tag")),
        // Undefined, not the origin: see ResolvedSound.position.
        position: findProp(stmt, "at") ? position : undefined,
        alias: alias[0]!,
        volume: numbersOf(findProp(stmt, "volume"), (v) => v)[0] ?? 1,
        range: rangeProp ? ([near!, far!] as [number, number]) : undefined,
        delay: numbersOf(findProp(stmt, "delay"), (v) => v)[0] ?? 0,
      };
    });
  }

  /** `point` nodes, top level only: `look` is a world-space point, as a `spawn`'s is. */
  resolvePoints(nodes: ObjectNode[]): ResolvedPoint[] {
    return nodes.map((node) => {
      const position = vecOf(findProp(node, "at"), toMeters);
      const lookProp = findProp(node, "look");
      return {
        id: this.nextEntityId++,
        name: node.name,
        tags: stringsOf(findProp(node, "tag")),
        position,
        look: lookProp ? vecOf(lookProp, toMeters) : addVec(position, vec3(0, 0, -1)),
        target: this.targetOf(node),
        modes: modesOf(findProp(node, "mode")),
      };
    });
  }

  /**
   * `solid` nodes, top level only. A part lives in the world's `collision` glb,
   * so a solid in a world without one names nothing; and one part is one piece
   * of presence, so two solids naming it would disagree about whether it is there.
   */
  resolveSolids(nodes: ObjectNode[], hasCollision: boolean): ResolvedSolid[] {
    if (nodes.length > 0 && !hasCollision) {
      this.err(`"solid" names a part of the world's collision, but this world declares no "collision"`, nodes[0]!.typeSpan, "solid-without-collision");
    }
    const seen = new Set<string>();
    const out: ResolvedSolid[] = [];
    for (const node of nodes) {
      const partProp = findProp(node, "part")!;
      const part = stringOf(partProp)!;
      if (seen.has(part)) {
        this.err(`part "${part}" is already named by another "solid"`, partProp.span, "duplicate-solid-part");
        continue;
      }
      seen.add(part);
      out.push({
        id: this.nextEntityId++,
        name: node.name,
        part,
        tags: stringsOf(findProp(node, "tag")),
        modes: modesOf(findProp(node, "mode")),
        use: enumOf(findProp(node, "use")) as UseMode | undefined,
      });
    }
    return out;
  }

  private resolveLight(node: ObjectNode, scope: Scope): ResolvedLight {
    const type = enumOf(findProp(node, "type"), "point") as ResolvedLight["type"];
    const local = vecOf(findProp(node, "at"), toMeters);
    const position = addVec(scope.origin, rotateY(local, scope.yaw));
    const rotateProp = findProp(node, "rotate");
    const rotation = rotationOf(rotateProp, toRadians);
    const intensity = numbersOf(findProp(node, "intensity"), (v) => v)[0] ?? 1;
    const colorProp = findProp(node, "color");
    const color = colorProp ? colorOf(colorProp, "#ffffff") : undefined;
    const shadows = boolOf(findProp(node, "shadows"), false);
    return {
      name: node.name,
      type,
      position,
      rotation: vec3(rotation.x, scope.yaw + rotation.y, rotation.z),
      aimed: rotateProp !== undefined,
      intensity,
      color,
      shadows,
    };
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function resolveWorld(statements: Statement[]): ResolveResult {
  const schemaDiags = validateStatements(statements);
  if (hasErrors(schemaDiags)) {
    return { diagnostics: schemaDiags };
  }

  const ctx = new ResolveContext();

  const worldNode = statements.find((s): s is ObjectNode => isObjectNode(s) && s.type === "world");
  const assetNodes = statements.filter((s): s is ObjectNode => isObjectNode(s) && s.type === "asset");
  const collisionNode = statements.find((s): s is ObjectNode => isObjectNode(s) && s.type === "collision");
  const navigationNode = statements.find((s): s is ObjectNode => isObjectNode(s) && s.type === "navigation");
  const fxNode = statements.find((s): s is ObjectNode => isObjectNode(s) && s.type === "fx");
  const soundsNode = statements.find((s): s is ObjectNode => isObjectNode(s) && s.type === "sounds");
  const spawnNodes = statements.filter((s): s is ObjectNode => isObjectNode(s) && s.type === "spawn");
  // The fallback is the first spawn that belongs to no particular mode or side,
  // so a world that only declares qualified spawns still has somewhere to put a
  // player.
  const spawnNode = spawnNodes.find((n) => !findProp(n, "mode") && !findProp(n, "team")) ?? spawnNodes[0];
  const gradeNode = statements.find((s): s is ObjectNode => isObjectNode(s) && s.type === "grade");
  const minimapNode = statements.find((s): s is ObjectNode => isObjectNode(s) && s.type === "minimap");

  ctx.buildAssets(assetNodes);

  // Parent pointers before anything is placed: a group's origin is its parent's
  // origin plus its own `at:`, and a nested group has to find its enclosing one.
  const topLevelPlaceables = statements.filter(
    (s): s is ObjectNode => isObjectNode(s) && (s.type === "group" || s.type === "light" || SHAPE_TYPES.has(s.type)),
  );
  registerParents(topLevelPlaceables, undefined, ctx.parentOf);

  const topLevelObjects: ResolvedObject[] = [];
  const allLights: ResolvedLight[] = [];

  const topScope = topLevelScope();
  ctx.resolveScopeBody(topLevelPlaceables, topScope, { objects: topLevelObjects, lights: allLights });

  // After every object, so object ids stay dense from zero and a trigger's id
  // falls past the end of them.
  const triggers: ResolvedTrigger[] = [];
  ctx.resolveTriggers(statements, topScope, triggers);
  const mantles: ResolvedMantle[] = [];
  ctx.resolveMantles(statements, topScope, mantles);
  // Each kind is numbered after every kind older than it, so adding one moves no
  // existing id. Ids cross the wire (net/messages/session.ts), so appending is
  // the only safe place to number a new kind of thing.
  const effects: ResolvedEffect[] = [];
  ctx.resolveEffects(statements, topScope, effects);
  const ladders: ResolvedLadder[] = [];
  ctx.resolveLadders(statements, topScope, ladders);
  const sounds: ResolvedSound[] = [];
  ctx.resolveSounds(statements, topScope, soundsNode !== undefined, sounds);
  const points = ctx.resolvePoints(statements.filter((s): s is ObjectNode => isObjectNode(s) && s.type === "point"));
  const solids = ctx.resolveSolids(
    statements.filter((s): s is ObjectNode => isObjectNode(s) && s.type === "solid"),
    collisionNode !== undefined,
  );

  // After every kind, since a target may name a tag declared anywhere.
  const tagged: readonly { tags: readonly string[] }[][] = [topLevelObjects, triggers, mantles, effects, ladders, sounds, points, solids];
  ctx.checkTargets(new Set(tagged.flat().flatMap((node) => node.tags)));

  const name = stringOf(worldNode && findProp(worldNode, "name"), "Untitled World")!;
  const description = worldNode ? stringOf(findProp(worldNode, "description")) : undefined;
  // The schema's enum has already refused anything but a zone key, so the cast
  // holds; a world that declares none resolves to undefined.
  const game = worldNode ? (enumOf(findProp(worldNode, "game")) as ResolvedWorld["game"]) : undefined;
  const ambient = worldNode ? (findProp(worldNode, "ambient") ? colorOf(findProp(worldNode, "ambient"), "#404040") : undefined) : undefined;
  const sky = worldNode && findProp(worldNode, "sky") ? colorOf(findProp(worldNode, "sky"), "#87b4d8") : undefined;
  const visibility = worldNode ? numbersOf(findProp(worldNode, "visibility"), toMeters)[0] : undefined;
  const exposure = worldNode ? (numbersOf(findProp(worldNode, "exposure"), (n) => n)[0] ?? 1.05) : 1.05;

  // A `grade` with no properties at all is the identity grade, not an error —
  // the defaults below are "tint nothing, desaturate nothing".
  const grade: ResolvedGrade | undefined = gradeNode
    ? {
        lightTint: tintOf(ctx, gradeNode, "light-tint"),
        mediumTint: tintOf(ctx, gradeNode, "medium-tint"),
        darkTint: tintOf(ctx, gradeNode, "dark-tint"),
        desaturation: desaturationOf(ctx, gradeNode, "desaturation"),
        desaturationDark: desaturationOf(ctx, gradeNode, "desaturation-dark"),
        gamma: gammaOf(ctx, gradeNode),
      }
    : undefined;

  /** One `spawn` node's position and facing, by the rules the fallback has always used. */
  const placeSpawn = (node: ObjectNode): { position: Vec3; look: Vec3 } => {
    const position = vecOf(findProp(node, "at"), toMeters, [0, 1.7, 0]);
    const lookProp = findProp(node, "look");
    return { position, look: lookProp ? vecOf(lookProp, toMeters) : addVec(position, vec3(0, 0, -1)) };
  };

  const spawnPoints: ResolvedSpawn[] = spawnNodes.map((node) => ({
    ...placeSpawn(node),
    modes: modesOf(findProp(node, "mode")),
    team: stringOf(findProp(node, "team")),
    start: boolOf(findProp(node, "start"), false),
  }));

  const spawn = spawnNode ? placeSpawn(spawnNode) : { position: vec3(0, 1.7, 0), look: vec3(0, 1.7, -1) };

  const modelAssets: Record<string, ResolvedAsset> = {};
  for (const [k, v] of ctx.modelAssets) {
    modelAssets[k] = v;
  }

  const world: ResolvedWorld = {
    name,
    description,
    game,
    ambient,
    sky,
    visibility,
    exposure,
    grade,
    assets: modelAssets,
    collision: collisionNode ? { source: stringOf(findProp(collisionNode, "source"))! } : undefined,
    navigation: navigationNode ? { source: stringOf(findProp(navigationNode, "source"))! } : undefined,
    fx: fxNode ? { source: stringOf(findProp(fxNode, "source"))! } : undefined,
    effects,
    soundLibrary: soundsNode ? { source: stringOf(findProp(soundsNode, "source"))! } : undefined,
    sounds,
    minimap: minimapNode ? minimapOf(ctx, minimapNode) : undefined,
    lights: allLights,
    topLevelObjects,
    spawn,
    spawnPoints,
    triggers,
    mantles,
    ladders,
    points,
    solids,
  };

  return { world, diagnostics: [...schemaDiags, ...ctx.diagnostics] };
}

/** Metres from the player to the HUD map's edge when a `minimap` gives no `range:`. */
const DEFAULT_MINIMAP_RANGE = 40;

/** Read the `minimap`, whose `source`, `at` and `size` the schema has required. */
function minimapOf(ctx: ResolveContext, node: ObjectNode): ResolvedMinimap {
  const [x = 0, z = 0] = numbersOf(findProp(node, "at"), toMeters);
  const sizeProp = findProp(node, "size")!;
  const [width = 0, depth = 0] = numbersOf(sizeProp, toMeters);
  if (width <= 0 || depth <= 0) {
    ctx.err(`a minimap's "size" must be positive, found ${width} ${depth}`, sizeProp.span, "minimap-bad-size");
  }
  const rangeProp = findProp(node, "range");
  const range = numbersOf(rangeProp, toMeters)[0] ?? DEFAULT_MINIMAP_RANGE;
  if (rangeProp && range <= 0) {
    ctx.err(`a minimap's "range" must be positive, found ${range}`, rangeProp.span, "minimap-bad-range");
  }
  return {
    source: stringOf(findProp(node, "source"))!,
    center: { x, z },
    width,
    depth,
    rotation: rotationOf(findProp(node, "rotate"), toRadians).y,
    range,
  };
}

/**
 * Read one of a `grade`'s tints, warning if it leaves the meaningful range.
 *
 * A tint is an absolute multiplier on a 0..2 scale where 1 is neutral, so a
 * value outside that is almost always a units mistake — an 0..255 colour
 * pasted in, or a percentage. It is a warning rather than an error because
 * nothing breaks: the shader will happily multiply by 30, it will just look
 * like a bug rather than a grade.
 */
function tintOf(ctx: ResolveContext, node: ObjectNode, key: string): Vec3 {
  const prop = findProp(node, key);
  const v = vecOf(prop, (n) => n, [1, 1, 1]);
  if (prop && [v.x, v.y, v.z].some((n) => n < 0 || n > 2)) {
    ctx.warn(`"${key}" values are multipliers on a 0..2 scale where 1 is neutral; ${v.x} ${v.y} ${v.z} is outside it`, prop.span, "tint-out-of-range");
  }
  return v;
}

/**
 * Read one of a `grade`'s desaturation amounts, warning outside 0..4.
 *
 * 0 leaves colour untouched and 1 is fully grey; the scale runs to 4 in the
 * source these values come from, though engine/grade.ts holds at 1
 * (see its comment). Outside 0..4 is a units mistake rather than a strong
 * grade.
 */
function desaturationOf(ctx: ResolveContext, node: ObjectNode, key: string): number {
  const prop = findProp(node, key);
  const v = numbersOf(prop, (n) => n)[0] ?? 0;
  if (prop && (v < 0 || v > 4)) {
    ctx.warn(`"${key}" is a 0..4 amount where 0 leaves colour alone and 1 is fully grey; ${v} is outside it`, prop.span, "desaturation-out-of-range");
  }
  return v;
}

/**
 * Read a `grade`'s gamma, warning outside 0.5..2.5. Zero or below has no
 * meaning as an exponent's reciprocal, so it warns and falls back to neutral
 * rather than reaching the shader as an infinity.
 */
function gammaOf(ctx: ResolveContext, node: ObjectNode): number {
  const prop = findProp(node, "gamma");
  const v = numbersOf(prop, (n) => n)[0] ?? 1;
  if (prop && !(v > 0)) {
    ctx.warn(`"gamma" must be above 0 (1 is neutral); ${v} is ignored`, prop.span, "gamma-out-of-range");
    return 1;
  }
  if (prop && (v < 0.5 || v > 2.5)) {
    ctx.warn(`"gamma" is a curve where 1 is neutral; ${v} is far outside the usual 0.5..2.5`, prop.span, "gamma-out-of-range");
  }
  return v;
}

function registerParents(body: Statement[], parent: ObjectNode | undefined, map: Map<ObjectNode, ObjectNode | undefined>): void {
  for (const stmt of body) {
    if (!isObjectNode(stmt)) {
      continue;
    }
    map.set(stmt, parent);
    if (stmt.type === "group") {
      registerParents(stmt.body, stmt, map);
    }
  }
}
