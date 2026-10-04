import { useComputed, useSignalEffect } from "@preact/signals";
import { useRef } from "preact/hooks";
import type { MinimapInfo } from "../../app/uiBridge.js";
import { useUi } from "../context.js";
import styles from "./Minimap.module.css";

/**
 * The map around the player, turned so they always face up: the image turns
 * and slides under a fixed arrow. Shown while walking in a world that has a
 * `minimap`.
 */
export function Minimap() {
  const { minimap } = useUi().state;
  const map = minimap.map.value;
  // Only whether there is a pose re-renders this; the pose itself changes every frame.
  const walking = useComputed(() => minimap.pose.value !== null).value;
  if (!map) {
    return null;
  }
  return (
    <div class={styles.frame} hidden={!walking} data-testid="minimap">
      <MapImage map={map} />
      <svg class={styles.player} viewBox="-10 -10 20 20" aria-hidden="true">
        <path d="M0 -8 L6.5 7 L0 3.5 L-6.5 7 Z" />
      </svg>
    </div>
  );
}

/**
 * Follows the pose outside Preact's render: the effect writes the transform
 * straight to the image. Its own component so the effect starts once the image
 * exists. The image's top-left corner sits at the frame's centre (the CSS), so
 * sliding it by the pose's share of its own size brings the player's spot there.
 */
function MapImage({ map }: { map: MinimapInfo }) {
  const pose = useUi().state.minimap.pose;
  const image = useRef<HTMLImageElement>(null);
  useSignalEffect(() => {
    const p = pose.value;
    if (p && image.current) {
      image.current.style.transform = `rotate(${p.rotation}rad) translate(${-p.u * 100}%, ${-p.v * 100}%)`;
    }
  });
  return (
    <img ref={image} class={styles.map} src={map.image} alt="" draggable={false} style={{ width: `${map.width * 100}%`, height: `${map.height * 100}%` }} />
  );
}
