import { useSignalEffect } from "@preact/signals";
import { useRef } from "preact/hooks";
import { useUi } from "../context.js";
import styles from "./PauseMap.module.css";

/**
 * The whole map, as authored, with the player on it. The HUD map turns under
 * the player; this one stays still and turns the arrow instead, by the
 * opposite of the HUD's turn.
 */
export function PauseMap() {
  const map = useUi().state.minimap.map.value;
  if (!map) {
    return null;
  }
  return (
    <div class={styles.frame} style={{ aspectRatio: `${map.width} / ${map.height}` }} data-testid="pause-map">
      <img class={styles.map} src={map.image} alt="" draggable={false} />
      <Marker />
    </div>
  );
}

/** Written outside Preact's render, like the HUD map, since the pose is a per-frame signal. Off the map, it waits at the edge. */
function Marker() {
  const pose = useUi().state.minimap.pose;
  const marker = useRef<HTMLDivElement>(null);
  useSignalEffect(() => {
    const p = pose.value;
    const el = marker.current;
    if (!el) {
      return;
    }
    el.hidden = !p;
    if (!p) {
      return;
    }
    el.style.left = `${clamp01(p.u) * 100}%`;
    el.style.top = `${clamp01(p.v) * 100}%`;
    el.style.setProperty("--heading", `${-p.rotation}rad`);
  });
  return (
    <div ref={marker} class={styles.marker} hidden>
      <svg class={styles.player} viewBox="-10 -10 20 20" aria-hidden="true">
        <path d="M0 -8 L6.5 7 L0 3.5 L-6.5 7 Z" />
      </svg>
    </div>
  );
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
