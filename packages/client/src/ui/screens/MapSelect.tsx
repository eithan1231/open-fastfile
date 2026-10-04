import { useState } from "preact/hooks";
import { LOBBY_MODES, type WorldEntry } from "../../app/uiBridge.js";
import { useUi } from "../context.js";
import { MenuColumn, MenuPanel, MenuScreen, menuStyles, useEscape, type MenuItem } from "../menu/Menu.js";
import { MenuArt } from "./MenuArt.js";
import styles from "./MapSelect.module.css";

const GAMES = ["MW2", "MW3", "BO"];
const MODES = ["Multiplayer", "Special Ops", "Campaign", "Zombies"];
const UNCATEGORISED = "Other";

/** Sort key for a category: imported games in release order, then everything else by name, "Other" last. */
function rank(category: string): [number, number, string] {
  const [game, ...rest] = category.split(" ");
  const g = GAMES.indexOf(game ?? "");
  const m = MODES.indexOf(rest.join(" "));
  if (g !== -1 && m !== -1) {
    return [g, m, ""];
  }
  return [category === UNCATEGORISED ? 2 * GAMES.length : GAMES.length, 0, category];
}

export function groupWorlds(worlds: WorldEntry[]): [string, WorldEntry[]][] {
  const groups = new Map<string, WorldEntry[]>();
  for (const world of worlds) {
    const key = world.category?.trim() || UNCATEGORISED;
    const list = groups.get(key) ?? [];
    list.push(world);
    groups.set(key, list);
  }
  const compare = (a: string, b: string) => {
    const [ra, rb] = [rank(a), rank(b)];
    return ra[0] - rb[0] || ra[1] - rb[1] || ra[2].localeCompare(rb[2]);
  };
  return [...groups.entries()].sort(([a], [b]) => compare(a, b)).map(([name, entries]) => [name, [...entries].sort((x, y) => x.name.localeCompare(y.name))]);
}

/** The worlds a gametype is played on: every one, unless it names them. */
export function worldsFor(worlds: WorldEntry[], gametype: string | undefined): WorldEntry[] {
  const maps = LOBBY_MODES.find((mode) => mode.id === gametype)?.maps ?? null;
  return maps === null ? worlds : worlds.filter((world) => maps.includes(world.slug));
}

/**
 * Game Setup's map list, a menu of its own: every world the lobby's gametype is
 * played on, grouped by game down the column, and the highlighted one's picture
 * in the panel. Choosing one goes back to Game Setup, and so does Esc.
 */
export function MapSelect(props: { onBack: () => void }) {
  const { state, commands } = useUi();
  const lobby = state.lobby.value;
  const worlds = worldsFor(state.worlds.value, lobby?.gametype);
  const [highlighted, setHighlighted] = useState<WorldEntry | undefined>(() => worlds.find((world) => world.slug === lobby?.map) ?? worlds[0]);
  useEscape(props.onBack);

  const items: MenuItem[] = [
    ...groupWorlds(worlds).flatMap(([category, entries]) =>
      entries.map((world, i): MenuItem => ({
        key: world.slug,
        label: world.name,
        description: world.description ?? category,
        current: world.slug === lobby?.map,
        divider: i === 0 ? category : undefined,
        onHighlight: () => setHighlighted(world),
        onSelect: () => {
          commands.setLobbyMap(world.slug);
          props.onBack();
        },
      })),
    ),
    { label: "Back", description: "Back to Game Setup.", divider: true, onSelect: props.onBack },
  ];

  return (
    <MenuScreen>
      <MenuArt />
      <MenuColumn title="Map" items={items} />
      <MenuPanel title={highlighted?.name ?? "Map"}>
        {worlds.length === 0 ? (
          <p class={styles.empty}>No worlds found under worlds/. Create a folder with a world.world file to get started (see worlds/AUTHORING.md).</p>
        ) : (
          highlighted && <MapPreview key={highlighted.slug} world={highlighted} />
        )}
      </MenuPanel>
    </MenuScreen>
  );
}

/** A world's picture and what it is. Keyed by world, so the image is hidden again until the next one loads. */
export function MapPreview({ world, hint = true }: { world: WorldEntry; hint?: boolean }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <div class={styles.preview}>
      <div class={styles.thumb}>
        {world.thumbnail && <img src={world.thumbnail} alt="" class={loaded ? styles.loaded : undefined} onLoad={() => setLoaded(true)} />}
      </div>
      {world.category && <p class={styles.category}>{world.category}</p>}
      {world.description && <p class={styles.desc}>{world.description}</p>}
      {hint && (
        <p class={styles.hint}>
          Choose<span class={menuStyles.key}>Enter</span>
        </p>
      )}
    </div>
  );
}
