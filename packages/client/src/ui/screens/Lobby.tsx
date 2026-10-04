import { useEffect, useState } from "preact/hooks";
import type { WorldEntry } from "../../app/uiBridge.js";
import { useUi } from "../context.js";
import { MenuColumn, MenuScreen, MenuPanel, menuStyles, useEscape, type MenuItem } from "../menu/Menu.js";
import { GameSetup, type SetupMenu } from "./GameSetup.js";
import { MapSelect } from "./MapSelect.js";
import { MenuArt } from "./MenuArt.js";
import { ModeSelect } from "./ModeSelect.js";
import styles from "./Lobby.module.css";

/**
 * Where a player waits between rounds, and where a finished round puts them
 * back.
 *
 * **A private match is set up here**, not on the way in, so that everyone
 * already in the lobby watches the host choose rather than arriving at whatever
 * was decided before they were invited. Game Setup, and the Game Mode and Map
 * menus it opens, are each a menu of their own, as Create a Class is; they are
 * the host's, and only while nothing is running.
 */
export function Lobby() {
  const { state } = useUi();
  const lobby = state.lobby.value;
  const [menu, setMenu] = useState<SetupMenu | null>(null);
  const waiting = lobby?.private === true && lobby.host && lobby.startsAt === null && !lobby.playing;
  // A countdown, or the host role moving on, closes Game Setup underneath whoever had it open.
  const open = waiting ? menu : null;

  switch (open) {
    case "setup":
      return <GameSetup onOpen={setMenu} onBack={() => setMenu(null)} />;
    case "mode":
      return <ModeSelect onBack={() => setMenu("setup")} />;
    case "map":
      return <MapSelect onBack={() => setMenu("setup")} />;
    case null:
      return <LobbyMenu onSetup={() => setMenu("setup")} />;
  }
}

/** The lobby's own menu: the match first, then the player, and the roster on the right. */
function LobbyMenu(props: { onSetup: () => void }) {
  const { state, commands } = useUi();
  const lobby = state.lobby.value;
  // Esc leaves: the menu is for players in no lobby, so going back to it is leaving this one.
  useEscape(() => commands.leaveLobby());

  const hosting = lobby?.private === true && lobby.host;
  const waiting = hosting && lobby.startsAt === null && !lobby.playing;
  const match: MenuItem[] = [
    // First, because it is what the host came here to do.
    ...(waiting ? [{ label: "Start Match", description: "Begin the countdown for everyone here.", onSelect: () => commands.startLobby() }] : []),
    ...(waiting ? [{ label: "Game Setup", description: "Choose the game mode, and the map it is played on.", onSelect: props.onSetup }] : []),
    ...(hosting && lobby.startsAt !== null
      ? [{ label: "Cancel", description: "Stop the countdown, to change the game setup.", onSelect: () => commands.endLobby() }]
      : []),
    ...(hosting && lobby.playing
      ? [{ label: "End Match", description: "End the match for everyone and come back here.", onSelect: () => commands.endLobby() }]
      : []),
  ];
  const player: MenuItem[] = [
    { label: "Create a Class", description: "Build the classes you choose from in a match.", onSelect: () => commands.openClasses() },
    { label: "Barracks", description: "Your callsign and emblem, challenges, accolades and prestige." },
  ];
  const items: MenuItem[] = [
    ...match,
    ...player.map((item, i) => (i === 0 && match.length > 0 ? { ...item, divider: true as const } : item)),
    { label: "Leave", description: "Back to the main menu.", onSelect: () => commands.leaveLobby() },
  ];

  const chosen = state.worlds.value.find((world) => world.slug === lobby?.map);

  return (
    <MenuScreen class={styles.screen}>
      <MenuArt />
      <MenuColumn title={lobby?.private ? "Private Match" : "Find Game"} items={items}>
        <MapCard world={chosen} slug={lobby?.map ?? null} />
        {lobby && <p class={styles.cardCategory}>{lobby.mode}</p>}
      </MenuColumn>
      <MenuPanel title={lobby ? `${lobby.players.length} in the lobby` : "Searching"}>
        <div class={styles.body}>
          <Status />
          <Refusal />
          <ol class={styles.players}>
            {(lobby?.players ?? []).map((player) => (
              <li key={player.id} class={styles.player}>
                <span class={styles.name}>{player.username}</span>
                {player.host && <span class={styles.tag}>Host</span>}
              </li>
            ))}
          </ol>
          {lobby?.private && (
            <p class={styles.invite}>
              Invite code<span class={styles.code}>{lobby.code}</span>
            </p>
          )}
        </div>
      </MenuPanel>
      {lobby?.invite && <InviteLink link={lobby.invite} />}
    </MenuScreen>
  );
}

/**
 * Copy Invite Link, in the corner rather than in the column: it is something you
 * do for other people, not a step in setting the match up.
 *
 * The clipboard only exists in a secure context — https, or localhost — so a page
 * opened by LAN address has none. Then the link is shown above the button,
 * selectable whole, to be copied by hand.
 */
function InviteLink({ link }: { link: string }) {
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  useEffect(() => {
    setCopied(null);
  }, [link]);
  useEffect(() => {
    if (copied !== "yes") {
      return;
    }
    const timer = setTimeout(() => setCopied(null), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    if (!navigator.clipboard) {
      setCopied("no");
      return;
    }
    navigator.clipboard.writeText(link).then(
      () => setCopied("yes"),
      () => setCopied("no"),
    );
  };

  return (
    <>
      {copied === "no" && <p class={styles.link}>{link}</p>}
      <button class={menuStyles.corner} onClick={copy}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z" />
        </svg>
        {copied === "yes" ? "Invite Link Copied" : "Copy Invite Link"}
      </button>
    </>
  );
}

/** How long the button says it copied before it goes back to offering to. */
const COPIED_MS = 2500;

/**
 * The map this lobby is on, at the foot of the column: its name, then its
 * picture. Named above rather than below because the name is the thing being
 * decided and the picture is what confirms it.
 */
function MapCard({ world, slug }: { world: WorldEntry | undefined; slug: string | null }) {
  if (slug === null) {
    return <p class={styles.nomap}>No map chosen yet.</p>;
  }
  return (
    <figure class={styles.card}>
      <figcaption class={styles.cardName}>{world?.name ?? slug}</figcaption>
      <div class={styles.thumb}>{world?.thumbnail && <img src={world.thumbnail} alt="" />}</div>
      {world?.category && <p class={styles.cardCategory}>{world.category}</p>}
    </figure>
  );
}

/**
 * Why the last thing this player asked for was refused, in the api's own words.
 *
 * Beside the status rather than instead of it: the lobby has not changed, and
 * "no server for that map" is the answer to what you just pressed, not what the
 * room is doing. Cleared when you ask for anything else.
 */
function Refusal() {
  const { state } = useUi();
  const refused = state.lobbyError.value;
  return refused === null ? null : (
    <p class={styles.refused} role="alert">
      {refused}
    </p>
  );
}

/** What the lobby is waiting for. Its own component so only it re-renders each second. */
function Status() {
  const { state } = useUi();
  const lobby = state.lobby.value;

  if (!lobby) {
    return <p class={styles.status}>{state.searching.value ? "Looking for a game…" : "Joining…"}</p>;
  }
  if (lobby.playing) {
    return <p class={styles.status}>{lobby.private ? "Match in progress. The host can end it." : "Match in progress."}</p>;
  }
  if (lobby.startsAt !== null) {
    return <Countdown startsAt={lobby.startsAt} />;
  }
  if (lobby.private) {
    return <p class={styles.status}>{lobby.map === null ? "Waiting for the host to choose a map." : "Waiting for the host."}</p>;
  }
  return <p class={styles.status}>Waiting for more players…</p>;
}

/**
 * Ticks itself once a second off the absolute instant the api sent, rather than
 * being told the remaining seconds from the other end. Alone in its own
 * component so the roster beside it is not re-rendered thirty times.
 */
function Countdown({ startsAt }: { startsAt: number }) {
  const [left, setLeft] = useState(() => remaining(startsAt));
  useEffect(() => {
    setLeft(remaining(startsAt));
    const timer = setInterval(() => setLeft(remaining(startsAt)), 1000);
    return () => clearInterval(timer);
  }, [startsAt]);

  return (
    <p class={styles.status}>
      Starting in<span class={styles.clock}>{format(left)}</span>
    </p>
  );
}

const remaining = (startsAt: number): number => Math.max(0, Math.round((startsAt - Date.now()) / 1000));

const format = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
