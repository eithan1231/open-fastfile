import { useEffect } from "preact/hooks";
import type { Prompt } from "../../app/uiBridge.js";
import { useUi } from "../context.js";
import { MenuScreen, menuStyles } from "../menu/Menu.js";
import styles from "./PlayPrompt.module.css";

/**
 * Over the live world, waiting for the click (or Enter) that captures the
 * mouse: after loading, and after Esc left the pause menu without it. Esc
 * opens the pause menu instead (App). In a match it first waits for the game
 * server instead ("joining"), and a click there does nothing — the class menu
 * comes up by itself, and nobody plays before choosing one.
 */
export function PlayPrompt({ prompt }: { prompt: Prompt }) {
  const { state, commands } = useUi();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        commands.resume();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [commands]);
  const label = prompt === "play" ? "Click to play" : prompt === "resume" ? "Click to resume" : "Joining the match…";
  return (
    <MenuScreen class={styles.prompt} role="dialog" aria-label={label} onClick={() => commands.resume()}>
      {prompt !== "resume" && state.worldName.value && <p class={styles.world}>{state.worldName.value}</p>}
      <p class={styles.label}>{label}</p>
      <p class={styles.hint}>
        Menu<span class={menuStyles.key}>Esc</span>
      </p>
    </MenuScreen>
  );
}
