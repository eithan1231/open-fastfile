import { useUi } from "../context.js";
import { MenuColumn, type MenuItem, MenuScreen, menuStyles } from "../menu/Menu.js";
import { MenuArt } from "./MenuArt.js";
import styles from "./MainMenu.module.css";

/**
 * The title screen. Find Game queues for a match; Private Match picks the map
 * for a lobby only the people you give the code to can join. Both end up on the
 * same lobby screen — the difference is who fills it.
 */
export function MainMenu() {
  const { commands } = useUi();
  const items: MenuItem[] = [
    { label: "Find Game", description: "Look for a match with other players.", onSelect: () => commands.findGame() },
    { label: "Private Match", description: "Make a lobby and invite people to it.", onSelect: () => commands.createPrivateLobby() },
    { label: "Create a Class", description: "Build the classes you choose from in a match.", onSelect: () => commands.openClasses() },
    { label: "Callsign", description: "Choose your title and emblem." },
    { label: "Barracks", description: "Challenges, accolades, prestige and leaderboards." },
  ];
  return (
    <MenuScreen class={styles.screen}>
      <MenuArt />
      <MenuColumn title="Multiplayer" items={items} />
      <button class={menuStyles.corner}>
        <svg viewBox="1 0 24 24" fill-rule="evenodd" aria-hidden="true">
          <path d="M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3.3h-4l-.4 2.6a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.4 7.4 0 0 0 1.7 1l.4 2.6h4l.4-2.6a7.4 7.4 0 0 0 1.7-1l2.5 1 2-3.5ZM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z" />
        </svg>
        Settings
      </button>
    </MenuScreen>
  );
}
