import { useUi } from "../context.js";
import { MenuColumn, MenuPanel, MenuScreen, useEscape, type MenuItem } from "../menu/Menu.js";
import { classSummary } from "./classes.js";
import styles from "./PauseMenu.module.css";

/**
 * Which class to play, chosen in the match: on joining, before the player is in
 * the world at all, and from the pause menu after.
 *
 * The choice is sent by number and the game server looks the class up in its own
 * copy of this player's classes, so there is nothing here to trust. A change made
 * while alive is held by the server until the next spawn — this screen only says
 * so, it does not decide it.
 */
export function ChooseClass() {
  const { state, commands } = useUi();
  const choice = state.classChoice.value;
  const playing = state.playingClass.value;
  const pending = state.pendingClass.value;
  const weapons = state.weapons.value;
  // On joining there is nothing to go back to: Esc does nothing, and Leave Game is the way out.
  useEscape(choice === "change" ? () => commands.closeClassChoice() : undefined);

  const items: MenuItem[] = [
    ...state.loadouts.value.map((loadout, index): MenuItem => ({
      key: `class-${index}`,
      label: loadout.name + (index === pending ? " (next)" : index === playing ? " (current)" : ""),
      description: classSummary(loadout, weapons),
      onSelect: () => commands.chooseClass(index),
    })),
    choice === "spawn"
      ? { label: "Leave Game", description: "Back to the main menu.", onSelect: () => commands.returnToMenu() }
      : { label: "Back", description: "Back to the pause menu.", onSelect: () => commands.closeClassChoice() },
  ];
  return (
    <MenuScreen class={styles.screen} role="dialog" aria-label="Choose Class">
      <MenuColumn title="Choose Class" items={items} />
      <MenuPanel title={state.worldName.value ?? "Choose Class"}>
        {choice === "change" && <p class={styles.note}>A new class takes effect when you next spawn.</p>}
      </MenuPanel>
    </MenuScreen>
  );
}
