import { useUi } from "../context.js";
import { MenuColumn, MenuPanel, MenuScreen, type MenuItem } from "../menu/Menu.js";
import { MenuArt } from "./MenuArt.js";
import styles from "./Elsewhere.module.css";

/**
 * This player opened the game in another tab, and that one is playing now.
 *
 * One tab at a time is the api's rule (it keeps one event stream per player), so
 * this one has let go of its lobby and its match, and stays out until asked back.
 * Play Here takes the player from the other tab the same way it was taken from
 * this one.
 */
export function Elsewhere() {
  const { commands } = useUi();
  const items: MenuItem[] = [
    { label: "Play Here", description: "Use this tab instead. The other one stops.", onSelect: () => commands.playHere() },
    { label: "Sign Out", description: "Sign out of this browser.", onSelect: () => commands.signOut() },
  ];
  return (
    <MenuScreen class={styles.screen}>
      <MenuArt />
      <MenuColumn title="Multiplayer" items={items} />
      <MenuPanel title="Open in another tab">
        <p class={styles.body}>The game is open somewhere else, and only one tab can play at a time.</p>
      </MenuPanel>
    </MenuScreen>
  );
}
