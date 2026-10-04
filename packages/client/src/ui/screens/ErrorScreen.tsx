import { useUi } from "../context.js";
import styles from "./ErrorScreen.module.css";

/** A world that failed to load or validate, shown exactly as `pnpm check` would print it. */
export function ErrorScreen() {
  const { state, commands } = useUi();
  const error = state.error.value;
  if (!error) {
    return null;
  }
  return (
    <div class={styles.overlay} role="alert">
      <div class={styles.header}>
        <span class={styles.title}>{error.title}</span>
        <button class={styles.back} onClick={() => commands.returnToMenu()}>
          Back to menu
        </button>
      </div>
      {error.watching && <div class={styles.hint}>Fix the world file and save: this updates automatically.</div>}
      <pre class={styles.detail}>{error.detail}</pre>
    </div>
  );
}
