// The class menu's weapon preview: the bridge between "show me iw5/iw5_m4_mp
// with an ACOG" and a rig turning in a canvas.
//
// Everything three.js lives below this (engine/weaponPreview.ts) and everything
// the UI knows lives above it (a weapon id, some attachment ids, and an element
// to draw into). What is left here is the part neither can do: fetching the
// models and asking the catalogue what a fitted weapon actually is.
//
// The renderer and its assets are built on first use and thrown away when the
// menu puts the preview away, because a weapon GLB is a couple of megabytes and
// a browsing player will look at a dozen. They are kept for as long as the
// preview is on screen, so flicking between two weapons re-fetches neither.

import type { WeaponDef } from "@3d/shared/sim/weaponDef.js";
import { fittedSlots, resolveWeapon, splitWeaponKey, WeaponRegistry } from "@3d/shared/sim/weaponRegistry.js";
import { WeaponPreview } from "../engine/weaponPreview.js";
import { attachmentModelUrl, weaponModelUrl } from "../net/catalog.js";
import { AssetStore } from "../scene/assets.js";
import type { FittedAttachment } from "../scene/viewmodel.js";

export class WeaponPreviews {
  private weapons = new WeaponRegistry([]);
  private preview: WeaponPreview | undefined;
  private assets: AssetStore | undefined;
  private host: HTMLElement | undefined;
  /** The newest request. An older fetch that finishes late must not draw over it. */
  private generation = 0;

  setWeapons(weapons: WeaponRegistry): void {
    this.weapons = weapons;
  }

  /**
   * Show a weapon in `host`, or put the preview away when `host` is null.
   *
   * Awaits its own models, so a caller that does not care may drop the promise —
   * a preview that arrives a moment after the click is what a menu does.
   */
  async show(host: HTMLElement | null, weapon: string | null, attachments: readonly string[]): Promise<void> {
    const mine = ++this.generation;
    if (host === null) {
      this.close();
      return;
    }

    this.preview ??= new WeaponPreview();
    this.assets ??= new AssetStore();
    if (this.host !== host) {
      host.appendChild(this.preview.canvas);
      this.host = host;
    }

    const parts = await this.load(weapon, attachments);
    if (mine !== this.generation || !this.preview) {
      return; // a newer request won, or the menu closed while this was loading
    }
    if (!parts) {
      this.preview.clear();
      return;
    }
    this.preview.show(parts.asset, parts.def, parts.attachments);
  }

  /** The weapon's model, its fitted definition, and a model for each attachment that has one. */
  private async load(weapon: string | null, attachments: readonly string[]) {
    const entry = this.weapons.entry(weapon);
    const url = weapon === null ? undefined : weaponModelUrl(weapon);
    if (!entry || url === undefined || !this.assets) {
      return undefined;
    }

    const fitted = fittedSlots(entry, attachments);
    const def: WeaponDef = resolveWeapon(entry, fitted);
    const game = splitWeaponKey(entry.game + "/" + entry.id)?.game ?? entry.game;
    const wanted = entry.attachments.filter((_, slot) => fitted.includes(slot));

    const [asset, ...models] = await Promise.all([
      this.assets.gltf(url),
      ...wanted.map((a) => (a.model ? this.assets!.gltf(attachmentModelUrl(game, a.model)) : Promise.resolve(undefined))),
    ]);
    if (!asset) {
      return undefined;
    }
    return { asset, def, attachments: wanted.map((entryFor, i): FittedAttachment => ({ entry: entryFor, asset: models[i] })) };
  }

  private close(): void {
    this.preview?.dispose();
    this.assets?.dispose();
    this.preview = this.assets = this.host = undefined;
  }
}
