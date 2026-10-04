import { useUi } from "../context.js";
import styles from "./UsePrompt.module.css";

/**
 * "Press F to open the door": what the use key would do now, under the
 * crosshair, as Call of Duty puts its hint. The text is the gametype script's
 * and `{key}` in it is the bound key, drawn as a key. Nothing while paused.
 *
 * In a development build the focused thing is named beneath it — a trigger or a
 * solid by its place in the world, and its tags — even when the script shows no
 * prompt, so "why is nothing offered here" has an answer on screen.
 */
export function UsePrompt() {
  const { state } = useUi();
  const focus = state.hud.use.value;
  if (!focus || state.paused.value) {
    return null;
  }
  const dev = state.debug.enabled.value;
  if (focus.text === null && !dev) {
    return null;
  }
  const parts = focus.text?.split("{key}") ?? [];
  return (
    <div class={styles.prompt} role="status" data-testid="use-prompt">
      {focus.text !== null && (
        <div class={styles.text}>
          {parts.map((part, i) => (
            <span key={i}>
              {i > 0 && <kbd class={styles.key}>{focus.key}</kbd>}
              {part}
            </span>
          ))}
        </div>
      )}
      {dev && (
        <div class={styles.dev}>
          {focus.thing.kind} {focus.thing.index}
          {focus.thing.tags.length > 0 && ` · ${focus.thing.tags.join(" ")}`}
        </div>
      )}
    </div>
  );
}
