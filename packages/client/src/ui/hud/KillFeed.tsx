import { useUi } from "../context.js";
import styles from "./KillFeed.module.css";

/**
 * Who killed whom, newest at the top.
 *
 * Every line here arrived as a `death` event the server repeated until it was
 * overwhelmingly likely to have been heard (`@3d/shared/net/messages/events.ts`):
 * unlike a hit marker, a line that never arrives is a permanent lie about the
 * match. A line with no killer is a suicide — the world's doing or their own —
 * and says how instead: "fell out of the world".
 */
export function KillFeed() {
  const feed = useUi().state.hud.feed.value;
  if (feed.length === 0) {
    return null;
  }
  return (
    <ul class={styles.feed} data-testid="kill-feed">
      {feed.map((entry) => (
        <li key={entry.id} class={entry.mine ? styles.lineMine : styles.line}>
          {entry.how === null ? (
            <>
              {entry.killer !== null && <span class={styles.name}>{entry.killer}</span>}
              <span class={styles.verb} aria-label="killed">
                ▸
              </span>
              <span class={styles.name}>{entry.victim}</span>
            </>
          ) : (
            <>
              <span class={styles.verb} aria-hidden="true">
                ☠
              </span>
              <span class={styles.name}>{entry.victim}</span>
              <span class={styles.how}>{entry.how}</span>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
