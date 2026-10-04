import { LOBBY_MODES, type MenuBackdrop } from "../../app/uiBridge.js";
import { useUi } from "../context.js";
import generic from "../art/menu-generic.jpg";
import zombies from "../art/menu-zombies.jpg";
import styles from "./MenuArt.module.css";

const PICTURES: Record<MenuBackdrop, string> = { generic, zombies };

/**
 * The menus' backdrop, chosen by the lobby's gametype: Zombies has its own
 * picture, and everything else — no lobby included — the soldier. Both are
 * always in the page and crossfade, so changing the mode never shows a frame of
 * nothing while the other one decodes.
 */
export function MenuArt() {
  const { state } = useUi();
  const gametype = state.lobby.value?.gametype;
  const shown = LOBBY_MODES.find((mode) => mode.id === gametype)?.backdrop ?? "generic";
  return (
    <div class={styles.art} aria-hidden="true">
      {(Object.keys(PICTURES) as MenuBackdrop[]).map((backdrop) => (
        <img key={backdrop} src={PICTURES[backdrop]} alt="" class={`${styles.picture} ${backdrop === shown ? styles.shown : ""}`} />
      ))}
      <div class={styles.shade} />
    </div>
  );
}
