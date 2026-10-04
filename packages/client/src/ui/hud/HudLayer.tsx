import { useUi } from "../context.js";
import styles from "./HudLayer.module.css";
import { KillFeed } from "./KillFeed.js";
import { Minimap } from "./Minimap.js";
import { Reticle } from "./Reticle.js";
import { UsePrompt } from "./UsePrompt.js";
import { Counters, Points } from "./Tally.js";
import { Ammo, Health } from "./Vitals.js";

/**
 * The in-game HUD. Each widget (minimap, weapon, score, connection status)
 * goes in one region. The layer passes clicks through to the game; a widget
 * that needs the pointer sets `pointer-events: auto` on itself.
 *
 * The reticle belongs to none of them: the crosshair and the hit marker are at
 * the middle of the screen, which is where the camera points rather than a
 * corner to lay things out in.
 */
export function HudLayer() {
  return (
    <div class={styles.layer}>
      <div class={styles.topLeft} data-region="top-left">
        <Minimap />
      </div>
      <div class={styles.topRight} data-region="top-right">
        <KillFeed />
      </div>
      <div class={styles.bottomLeft} data-region="bottom-left">
        <Counters />
        <Health />
      </div>
      <div class={styles.bottomCenter} data-region="bottom-center" />
      <div class={styles.bottomRight} data-region="bottom-right">
        <Points />
        <Ammo />
      </div>
      <Reticle />
      <UsePrompt />
      <Toast />
    </div>
  );
}

function Toast() {
  const toast = useUi().state.toast.value;
  return toast ? (
    <div class={styles.toast} role="status">
      {toast}
    </div>
  ) : null;
}
