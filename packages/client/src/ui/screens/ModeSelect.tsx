import { useState } from "preact/hooks";
import { LOBBY_MODES, type LobbyMode, type WorldEntry } from "../../app/uiBridge.js";
import { useUi } from "../context.js";
import { MenuColumn, MenuPanel, MenuScreen, menuStyles, useEscape, type MenuItem } from "../menu/Menu.js";
import { MenuArt } from "./MenuArt.js";
import styles from "./GameSetup.module.css";

/**
 * Game Setup's gametypes, a menu of its own: every one down the column, and the
 * highlighted one's rules in the panel. Choosing one goes back to Game Setup, and
 * so does Esc. Every gametype is offered whatever the map, because choosing one
 * the map is not played in moves the map (`UiCommands.setLobbyMode`).
 */
export function ModeSelect(props: { onBack: () => void }) {
  const { state, commands } = useUi();
  const current = state.lobby.value?.gametype;
  const [highlighted, setHighlighted] = useState<LobbyMode | undefined>(() => LOBBY_MODES.find((mode) => mode.id === current) ?? LOBBY_MODES[0]);
  useEscape(props.onBack);

  const items: MenuItem[] = [
    ...LOBBY_MODES.map((mode): MenuItem => ({
      key: mode.id,
      label: mode.name,
      description: mode.description,
      current: mode.id === current,
      onHighlight: () => setHighlighted(mode),
      onSelect: () => {
        commands.setLobbyMode(mode.id);
        props.onBack();
      },
    })),
    { label: "Back", description: "Back to Game Setup.", divider: true, onSelect: props.onBack },
  ];

  return (
    <MenuScreen>
      <MenuArt />
      <MenuColumn title="Game Mode" items={items} />
      <MenuPanel title={highlighted?.name ?? "Game Mode"}>
        {highlighted && (
          <div class={styles.body}>
            <ModeDetails mode={highlighted} worlds={state.worlds.value} />
            <p class={styles.hint}>
              Choose<span class={menuStyles.key}>Enter</span>
            </p>
          </div>
        )}
      </MenuPanel>
    </MenuScreen>
  );
}

/** What a gametype is, and where it is played. */
export function ModeDetails({ mode, worlds }: { mode: LobbyMode; worlds: readonly WorldEntry[] }) {
  const names = mode.maps?.map((slug) => worlds.find((world) => world.slug === slug)?.name ?? slug);
  return (
    <>
      {mode.description && <p class={styles.desc}>{mode.description}</p>}
      <p class={styles.label}>{names ? `Played on ${names.join(", ")}` : "Played on every map"}</p>
    </>
  );
}
