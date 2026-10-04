import { useUi } from "../context.js";
import styles from "./Tally.module.css";

/**
 * The gametype's counters, bottom left above the health bar. Each is its
 * declared name over the server's value; a gametype that declares none draws
 * nothing.
 */
export function Counters() {
  const counters = useUi().state.hud.counters.value;
  if (counters.length === 0) {
    return null;
  }
  return (
    <div class={styles.counters} data-testid="hud-counters">
      {counters.map((counter) => (
        <div key={counter.name} class={styles.counter}>
          <span class={styles.label}>{counter.name}</span>
          <span class={styles.value}>{counter.value}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * This player's purse, bottom right above the magazine. The server's number;
 * nothing in a gametype that keeps no points.
 */
export function Points() {
  const points = useUi().state.hud.points.value;
  if (points === null) {
    return null;
  }
  return (
    <div class={styles.points} data-testid="hud-points">
      {points}
    </div>
  );
}
