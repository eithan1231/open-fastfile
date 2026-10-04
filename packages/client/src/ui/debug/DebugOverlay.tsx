import { useUi } from "../context.js";
import styles from "./DebugOverlay.module.css";

/** Development readouts: render stats, the inspector panel and its crosshair. */
export function DebugOverlay() {
  return (
    <>
      <Stats />
      <Inspector />
      <Crosshair />
    </>
  );
}

// Separate components so a 10 Hz stats update re-renders only the stats.

function Stats() {
  const stats = useUi().state.debug.stats.value;
  if (!stats) {
    return null;
  }
  return (
    <div class={styles.stats}>
      <div>{stats.primary.join("  ·  ")}</div>
      {stats.secondary.length > 0 && <div>{stats.secondary.join("  ·  ")}</div>}
    </div>
  );
}

function Inspector() {
  const pick = useUi().state.debug.inspector.value;
  if (pick === undefined) {
    return null;
  }
  return (
    <div class={styles.inspector}>
      <div class={styles.title} data-pinned={pick?.pinned ?? false} data-collider={pick?.collider ?? false}>
        {pick?.title ?? "Inspector"}
      </div>
      {pick && <dl class={styles.rows}>{pick.rows.flatMap(([key, value]) => [<dt key={`${key}-k`}>{key}</dt>, <dd key={`${key}-v`}>{value}</dd>])}</dl>}
      <div class={styles.hint}>{pick?.hint ?? "Point at something. Click to pin it."}</div>
    </div>
  );
}

function Crosshair() {
  return useUi().state.debug.crosshair.value ? <div class={styles.crosshair} /> : null;
}
