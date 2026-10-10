// What the player holds, drawn: the world's view hands, the weapons they carry
// and the one in hand, and following a swap. The pass that draws it is
// engine/viewmodel.ts; this decides what it is given.
//
// Outlives a world, but everything it draws belongs to the world that was
// mounted when it was armed: the models are that session's assets, and the
// lights are copies of that world's. `drop` lets go of all of it.

import type * as THREE from "three";
import type { CastChoice } from "@3d/shared/game/cast.js";
import type { Player } from "@3d/shared/sim/player.js";
import type { WeaponId } from "@3d/shared/sim/weaponRegistry.js";
import type { Animator } from "../engine/animator.js";
import type { FirstPersonControls } from "../engine/controls/firstPerson.js";
import type { Viewer } from "../engine/viewer.js";
import { copyLights, type Viewmodel } from "../engine/viewmodel.js";
import { attachmentModelUrl, overlayImageUrl, weaponModelUrl } from "../net/catalog.js";
import type { AssetStore, GltfAsset } from "../scene/assets.js";
import { buildViewmodelRig, type FittedAttachment } from "../scene/viewmodel.js";
import type { GameContent } from "./content.js";

export class WeaponViewmodel {
  /** The dev toggle; the hands are also hidden outside walk mode. */
  shown = true;
  private assets: AssetStore | undefined;
  /** The world's view hands, worn by whichever weapon is in hand. */
  private hands: GltfAsset | undefined;
  /** Copies of the world's lights for the viewmodel's own pass, made once per world. */
  private lights: THREE.Light[] = [];
  /** Every carried weapon's models, by `rigKey`, so a swap redraws without a fetch. */
  private readonly carried = new Map<string, { weapon: GltfAsset; attachments: FittedAttachment[] }>();
  /** The `rigKey` currently drawn, or null for empty hands. What `followSwap` compares against. */
  private drawn: string | null = null;
  /**
   * The `Player.armed` count whose weapons have been fetched and drawn. A server
   * handing over weapons mid-life — a respawn, a class taking effect, a script's
   * `arm` — reaches this end as a new count in a snapshot, and `followSwap` is
   * what notices.
   */
  private armedSeen = -1;

  constructor(
    private readonly viewer: Viewer,
    private readonly viewmodel: Viewmodel,
    private readonly firstPerson: FirstPersonControls,
    private readonly animator: Animator,
    private readonly content: GameContent,
  ) {}

  private get player(): Player {
    return this.firstPerson.player;
  }

  /**
   * Arm the player in a newly mounted world and draw what they hold. `root` is
   * the built world, its matrices final, whose lights the hands are lit by.
   * `raise` plays the weapon coming up, as equipping does (Player.equip): not
   * for a held pose, which is a screenshot and would hold its first frame, nor
   * a hot reload, which keeps going. Returns what they ended up carrying, for
   * the log, or undefined if nothing could be drawn.
   */
  async arm(assets: AssetStore, hands: GltfAsset, root: THREE.Object3D, cast: CastChoice, raise: boolean): Promise<string | undefined> {
    this.assets = assets;
    this.hands = hands;
    this.lights = copyLights(root);
    // The player's class wins, and the gametype's default is what a player
    // with no class — or one naming nothing this catalogue holds — falls back
    // to. Something names a weapon so that walking into a world armed is not
    // conditional on having built a class.
    const carried = this.carry(cast.defaultWeapon);
    this.armedSeen = this.player.armed;
    await this.fetchCarried();
    return this.showHeld({ ready: !raise }) ? carried : undefined;
  }

  /**
   * Redraw if the player is holding something other than what is drawn: a swap,
   * or weapons a server handed over. Cheap when neither, which is every frame but
   * one.
   *
   * Handed-over weapons may not have been fetched — a class chosen in the match,
   * a script's rocket launcher — so they are fetched first and drawn when they
   * arrive, unless something newer was handed over meanwhile.
   */
  followSwap(): void {
    const player = this.player;
    if (this.hands && player.armed !== this.armedSeen) {
      const armed = (this.armedSeen = player.armed);
      void this.fetchCarried().then(() => {
        if (this.hands && this.armedSeen === armed) {
          this.showHeld();
        }
      });
      return;
    }
    if (this.drawn !== null && rigKey(player.weaponId, player.fitted) !== this.drawn) {
      this.showHeld();
    }
  }

  /** The hands follow the local player: its weapon, which stepped with it, and its movement. */
  update(dt: number, walking: boolean): void {
    this.followSwap();
    const vm = this.viewmodel;
    vm.visible = this.shown && walking;
    vm.paused = this.animator.paused; // a held pose holds the arms too
    vm.update(dt, { camera: this.viewer.camera, turn: this.firstPerson.turn, movement: this.player.movement });
    const zoom = walking ? vm.zoom : 1;
    this.viewer.setZoom(zoom);
    // The aim is scaled by the same number the view is, so a scope does not cost
    // its own magnification in precision. See FirstPersonControls.zoom.
    this.firstPerson.setZoom(zoom);
  }

  /** Let go of everything the mounted world lent: the rig, the models, the lights, and the weapon itself. */
  drop(): void {
    this.viewmodel.clear();
    this.player.equip(undefined);
    this.carried.clear();
    this.hands = undefined;
    this.lights = [];
    this.assets = undefined;
    this.drawn = null;
  }

  /**
   * Equip the player: their class, or the gametype's default when the class arms
   * them with nothing this catalogue holds.
   */
  private carry(fallback: WeaponId | null): string {
    const player = this.player;
    const loadout = this.content.loadout();
    player.equipLoadout(loadout);
    if (player.weaponId !== null) {
      return `class ${loadout.name}`;
    }
    if (fallback === null) {
      return "nothing (this gametype names no default weapon)";
    }
    player.equipById(fallback);
    return player.weaponId === null ? `nothing ("${fallback}" is not in the catalogue)` : fallback;
  }

  /**
   * Fetch a model for every weapon the player carries and everything fitted to
   * it, so a swap draws immediately rather than after a round trip.
   *
   * Both weapons, not just the one in hand: the second is one keypress away, and
   * a two-megabyte fetch between the putaway and the raise would show as the
   * hands coming up empty.
   */
  private async fetchCarried(): Promise<void> {
    const wanted = this.player.carrying.filter((held) => held.id !== null);
    await Promise.all(wanted.map((held) => this.fetchWeapon(held.id!, held.fitted)));
  }

  private async fetchWeapon(id: WeaponId, fitted: readonly number[]): Promise<void> {
    const assets = this.assets;
    const entry = this.content.weapons.entry(id);
    const url = weaponModelUrl(id);
    if (!assets || !entry || url === undefined || this.carried.has(rigKey(id, fitted))) {
      return;
    }
    const wanted = entry.attachments.filter((_, slot) => fitted.includes(slot));
    const [weapon, ...models] = await Promise.all([
      assets.gltf(url),
      ...wanted.map((a) => (a.model ? assets.gltf(attachmentModelUrl(entry.game, a.model)) : Promise.resolve(undefined))),
    ]);
    // A world left while this was on its way: its store has freed these.
    if (weapon && this.assets === assets) {
      this.carried.set(rigKey(id, fitted), { weapon, attachments: wanted.map((entryFor, i) => ({ entry: entryFor, asset: models[i] })) });
    }
  }

  /**
   * Draw whatever the player is holding now.
   *
   * The rig is per weapon *and* per fitted set, so it is rebuilt rather than
   * re-posed — `Viewmodel.clear` disposes the skeletons of the one it had.
   */
  private showHeld(options: { ready?: boolean } = {}): boolean {
    const player = this.player;
    const weapon = player.weapon;
    const parts = this.carried.get(rigKey(player.weaponId, player.fitted));
    if (!weapon || !parts || !this.hands || !this.assets) {
      this.drawn = null;
      this.viewmodel.clear();
      return false;
    }
    try {
      const rig = buildViewmodelRig(parts.weapon, this.hands, { def: weapon.def, attachments: parts.attachments });
      // The scope picture is read from the *resolved* definition, not the GLB's:
      // it is what a fitted optic changes, and an ACOG on a sniper rifle removes.
      const overlay = weapon.def.adsOverlay;
      this.viewmodel.attach(rig, this.lights, weapon, overlay ? this.assets.picture(overlayImageUrl(weapon.def.game, overlay)) : undefined);
      // Joined the pass's scene after the quality level was applied to it.
      this.viewer.applyQualityTo(rig.root);
      this.drawn = rigKey(player.weaponId, player.fitted);
      if (options.ready) {
        weapon.ready();
      }
      return true;
    } catch (e) {
      const id = player.weaponId;
      // Unarmed rather than holding a weapon nobody can see fire.
      this.drop();
      console.warn(`[viewmodel] ${id ?? "?"}: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }
}

/** A rig is per weapon *and* per fitted set: the same gun with an ACOG is a different thing to draw. */
function rigKey(id: WeaponId | null, fitted: readonly number[]): string {
  return `${id ?? ""}|${fitted.join(",")}`;
}
