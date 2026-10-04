import { describe, expect, it } from "vitest";
import { parseWorldFile } from "../src/dsl/parser.js";
import { resolveWorld } from "../src/dsl/resolve.js";
import { hasErrors } from "../src/dsl/diagnostics.js";
import { indexWorld, objectAt, worldObjects } from "../src/worlds/worldIndex.js";
import { UNASSIGNED_ENTITY_ID } from "../src/dsl/resolved.js";

function resolveOk(source: string) {
  const { ast, diagnostics } = parseWorldFile(source);
  expect(diagnostics).toHaveLength(0);
  const result = resolveWorld(ast.statements);
  if (hasErrors(result.diagnostics)) {
    throw new Error("unexpected errors: " + result.diagnostics.map((d) => d.message).join("; "));
  }
  return result.world!;
}

// Declaration order, which is the order resolveScopeBody emits in and the order
// a human reading the file would predict — groups depth-first, in place.
const WORLD = `
  asset a { source: "a.glb" }
  group near {
    model one { asset: a, at: 0 0 0, size: 1 1 1, tag: "crate" }
    model two { asset: a, at: 2 0 0, size: 1 1 1, tag: "crate" }
  }
  group outside { at: 9 0 0
    model three { asset: a, at: 0 0 0, size: 1 1 1 }
    model four { asset: a, at: 1 0 0, size: 1 1 1, tag: "crate" }
  }
`;

describe("entity ids", () => {
  it("are dense, unique and start at zero", () => {
    const objects = worldObjects(resolveOk(WORLD));
    expect(objects.map((o) => o.id)).toEqual(objects.map((_, i) => i));
  });

  it("follow declaration order, descending into a group in place", () => {
    const index = indexWorld(resolveOk(WORLD));
    expect(index.objects.map((o) => o.name)).toEqual(["one", "two", "three", "four"]);
  });

  it("are identical across two resolves of the same source", () => {
    const a = indexWorld(resolveOk(WORLD));
    const b = indexWorld(resolveOk(WORLD));
    expect([...a.byName]).toEqual([...b.byName]);
  });

  /**
   * A group's origin is resolved (and memoized) before its children, so a
   * counter in resolvePlaceable would number the group itself. Ids are spent on
   * emission instead, which is what keeps them in declaration order.
   */
  it("are spent on emission, not on placement", () => {
    const index = indexWorld(
      resolveOk(`
        asset a { source: "a.glb" }
        group g { at: 4 0 0
          model first { asset: a, at: 0 0 0, size: 1 1 1 }
          model second { asset: a, at: 1 0 0, size: 1 1 1 }
        }
      `),
    );
    expect(index.byName.get("first")).toBe(0);
    expect(index.byName.get("second")).toBe(1);
  });

  it("never leave the sentinel on an emitted object", () => {
    for (const object of worldObjects(resolveOk(WORLD))) {
      expect(object.id).not.toBe(UNASSIGNED_ENTITY_ID);
    }
  });
});

describe("indexWorld", () => {
  it("addresses one object by its authored name", () => {
    const index = indexWorld(resolveOk(WORLD));
    expect(objectAt(index, index.byName.get("three")!)?.name).toBe("three");
  });

  it("addresses a whole set by tag, across groups and top level", () => {
    const index = indexWorld(resolveOk(WORLD));
    const tagged = index.byTag.get("crate")!.map((id) => objectAt(index, id)?.name);
    expect(tagged).toEqual(["one", "two", "four"]);
  });

  it("has no entry for an id no object carries", () => {
    const index = indexWorld(resolveOk(WORLD));
    expect(objectAt(index, 99)).toBeUndefined();
  });
});
