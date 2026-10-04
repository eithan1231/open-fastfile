import { LOBBY_MODES } from "../../app/uiBridge.js";
import { useUi } from "../context.js";
import { MenuColumn, MenuPanel, MenuScreen, useEscape, type MenuItem } from "../menu/Menu.js";
import { MapPreview } from "./MapSelect.js";
import { MenuArt } from "./MenuArt.js";
import { ModeDetails } from "./ModeSelect.js";
import styles from "./GameSetup.module.css";

/** Which of Game Setup's menus is showing: its own, or one of the two it opens. */
export type SetupMenu = "setup" | "mode" | "map";

/**
 * A private lobby's Game Setup, a menu of its own: the gametype first, since it
 * decides which maps there are to choose from, then the map. Each opens a menu of
 * its own in turn, and the panel shows what is chosen now.
 */
export function GameSetup(props: { onOpen: (menu: SetupMenu) => void; onBack: () => void }) {
  const { state } = useUi();
  const lobby = state.lobby.value;
  const mode = LOBBY_MODES.find((one) => one.id === lobby?.gametype);
  const world = state.worlds.value.find((one) => one.slug === lobby?.map);
  useEscape(props.onBack);

  const items: MenuItem[] = [
    { label: "Game Mode", description: `The rules this match is played by. Now: ${lobby?.mode ?? "none"}.`, onSelect: () => props.onOpen("mode") },
    {
      label: "Map",
      description: `Where this match is played. Now: ${world?.name ?? lobby?.map ?? "none chosen"}.`,
      onSelect: () => props.onOpen("map"),
    },
    { label: "Back", description: "Back to the lobby.", divider: true, onSelect: props.onBack },
  ];

  return (
    <MenuScreen>
      <MenuArt />
      <MenuColumn title="Game Setup" items={items} />
      <MenuPanel title="Game Setup">
        <div class={styles.body}>
          <h3 class={styles.label}>Game Mode</h3>
          <p class={styles.value}>{lobby?.mode ?? "—"}</p>
          {mode && <ModeDetails mode={mode} worlds={state.worlds.value} />}
          <h3 class={`${styles.label} ${styles.gap}`}>Map</h3>
          <p class={styles.value}>{world?.name ?? lobby?.map ?? "None chosen"}</p>
          {world && <MapPreview key={world.slug} world={world} hint={false} />}
        </div>
      </MenuPanel>
    </MenuScreen>
  );
}
