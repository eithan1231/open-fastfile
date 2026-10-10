// The contract between the app and the UI. The app writes these signals and
// the UI renders them; the UI acts only through `UiCommands`. Plain data only:
// no three.js objects cross this line. This is the one module src/ui/ may
// import from the rest of the codebase (enforced in eslint.config.js).

import { signal, type Signal } from "@preact/signals-core";
import { QUALITY_LEVELS, type QualityLevel } from "../engine/qualityLevel.js";
import { DEFAULT_SENSITIVITY, SENSITIVITY_RANGE } from "../input/sensitivity.js";
import { AUDIO_CHANNELS, defaultAudioSettings, type AudioSettings, type Channel } from "../engine/audio/mixer.js";
import { defaultLoadouts, LOADOUT_COUNT, LOADOUT_GAMES, MAX_LOADOUT_ATTACHMENTS, type Loadout } from "@3d/shared/sim/loadout.js";
import { CATEGORY_LABEL, CATEGORY_SLOT, WEAPON_CATEGORIES, type WeaponCategory } from "@3d/shared/sim/weaponCategory.js";

export type { Loadout, WeaponCategory };
/** Re-exported through the bridge, which is the only module src/ui/ may import from the rest of the codebase. */
export { CATEGORY_LABEL, CATEGORY_SLOT, LOADOUT_COUNT, LOADOUT_GAMES, MAX_LOADOUT_ATTACHMENTS, WEAPON_CATEGORIES };

export { LOBBY_MODES, type LobbyMode, type MenuBackdrop } from "./lobbyModes.js";

export type { QualityLevel };
/** The engine's cycle order, re-exported: src/ui/ reaches the rest of the codebase only through this module. */
export const QUALITY_CHOICES: readonly QualityLevel[] = QUALITY_LEVELS;

/** What the mouse sensitivity slider may ask for. See input/sensitivity.ts for the units. */
export const SENSITIVITY_LIMITS = SENSITIVITY_RANGE;

export type AudioChannel = Channel;
export type { AudioSettings };
/** The mixer's channels, re-exported: src/ui/ reaches the rest of the codebase only through this module. */
export const AUDIO_CHANNEL_CHOICES: readonly AudioChannel[] = AUDIO_CHANNELS;
/** What each channel is called on screen. The engine's names are what the code calls them. */
export const AUDIO_CHANNEL_LABELS: Record<AudioChannel, string> = {
  sfx: "Effects",
  footsteps: "Footsteps",
  ambience: "Ambience",
  voice: "Voice",
  ui: "Interface",
};

/** `elsewhere`: another tab is playing as this player, and this one has stood down. */
export type Screen = "auth" | "menu" | "lobby" | "classes" | "loading" | "world" | "error" | "elsewhere";

/**
 * Why the in-match class menu is up: `spawn` before a player's first spawn, which
 * they cannot play past without choosing; `change` from the pause menu, which
 * takes effect at their next spawn.
 */
export type ClassChoice = "spawn" | "change";

/** One attachment a weapon offers, named for a player rather than for the game's localisation table. */
export interface UiAttachment {
  id: string;
  name: string;
}

/** One weapon a class may name. `kind` is the source game's own category (`rifle`, `smg`, ...). */
export interface UiWeapon {
  /** The catalogue id, which is what a class stores. */
  id: string;
  name: string;
  game: string;
  kind: string;
  slot: "primary" | "secondary" | null;
  /** Where Create a Class lists it; null for a weapon it does not offer (sim/weaponCategory.ts). */
  category: WeaponCategory | null;
  attachments: UiAttachment[];
}

/** A signed-in player, as the UI knows them. */
export interface UserInfo {
  id: string;
  username: string;
}

/** One player in the lobby list. */
export interface LobbyPlayerInfo {
  id: string;
  username: string;
  host: boolean;
}

/**
 * The lobby the player is standing in, between rounds. `null` map and `startsAt`
 * mean it is still waiting: nothing is chosen and no countdown is running.
 */
export interface LobbyInfo {
  /** Also the invite code, for a private lobby. */
  code: string;
  private: boolean;
  map: string | null;
  /** The rules it will be played by, as a player reads them ("Free Roam", "Chase"). */
  mode: string;
  /** The same, by id: one of `LOBBY_MODES`, or an id this build does not know. */
  gametype: string;
  /** Whether its game is running — the player is in the world, not here. */
  playing: boolean;
  /**
   * When the round starts, as an absolute time (`Date.now()` units). The UI
   * counts down to it itself rather than being told the remaining seconds sixty
   * times, or once a second, from the other end.
   */
  startsAt: number | null;
  players: LobbyPlayerInfo[];
  /** Whether this player is its host, and so may start it. The api hands the role on when a host leaves. */
  host: boolean;
  /** A link that joins this lobby, for a private one. */
  invite: string | null;
}

export interface WorldEntry {
  slug: string;
  name: string;
  description?: string;
  category?: string;
  thumbnail?: string;
}

/** The world being loaded, and how far along. */
export interface LoadingInfo {
  world: WorldEntry;
  /** The load step running now. */
  step: string;
  /** 0..1, by steps done. */
  progress: number;
}

/**
 * The game is paused under a prompt over the live world, waiting for a click
 * (or key press) to capture the mouse, which browsers only allow from one.
 * "play": the world has just loaded. "resume": Esc closed the pause menu, but
 * the browser would not re-capture the mouse from an Esc. "joining": a match's
 * world is up and its game server has not yet said who this player is — there is
 * nothing to click, because nobody plays before choosing a class.
 */
export type Prompt = "play" | "resume" | "joining";

export interface ErrorInfo {
  title: string;
  /** Preformatted, monospace: diagnostics exactly as `pnpm check` prints them. */
  detail: string;
  /** Whether the app will retry by itself when the files change (dev hot reload). */
  watching: boolean;
}

/** One line of the controls help. */
export interface ControlHint {
  label: string;
  keys: string;
  dev: boolean;
}

/** The debug readout, refreshed a few times a second. Each entry is one " · "-separated segment. */
export interface DebugStats {
  primary: string[];
  secondary: string[];
}

/** What the inspector says about the thing under the cursor (or pinned). */
export interface PickInfo {
  title: string;
  rows: [string, string][];
  hint: string;
  pinned: boolean;
  /** A collision stand-in rather than the thing itself: drawn in the collider colour. */
  collider: boolean;
}

/** The HUD map's image. The map is square; the image's size is a fraction of its side. */
export interface MinimapInfo {
  image: string;
  width: number;
  height: number;
}

/** Where the player stands on the minimap image. Written every frame the player moves or turns. */
export interface MinimapPose {
  /** 0..1 across the image from its left edge. */
  u: number;
  /** 0..1 down the image from its top edge. */
  v: number;
  /** Radians clockwise to turn the image by, so the player faces up. */
  rotation: number;
}

/**
 * The player's own state, as the HUD shows it.
 *
 * Every number here is the **server's**, not this client's prediction of it
 * (`app/hud.ts`). Health especially: nothing local ever takes it off, so a client
 * that read its own copy would show a full bar to a player being shot at until
 * the correction arrived.
 */
export interface HudPlayerInfo {
  health: number;
  /** `CombatRules.maxHealth`, from `joined`: the bar's denominator. */
  maxHealth: number;
  dead: boolean;
  /**
   * Seconds until they are put back, while dead — or null where the gametype
   * brings the dead back itself (`CombatRules.respawnDelay`), when there is no
   * countdown to show.
   */
  respawnIn: number | null;
  /** What they are holding. null: empty-handed. */
  weapon: { name: string; ammo: number; reloading: boolean } | null;
}

/** One of the gametype's counters, as the HUD shows it: its declared name and the server's value. */
export interface HudCounter {
  name: string;
  value: number;
}

/**
 * The last hit the server confirmed. `id` is its event id, so a new number is a
 * new marker — which is what the UI keys its flash on, rather than a timestamp it
 * would have to be told to forget.
 */
export interface HitMarkerInfo {
  id: number;
  /** It killed them, which is drawn differently. */
  lethal: boolean;
}

/** One line of the kill feed. Names are resolved from the lobby; an unknown id shows as itself. */
export interface KillFeedEntry {
  id: number;
  /** null: nobody else did it — the world, or their own hand. Such a line is a suicide, and says how in `how`. */
  killer: string | null;
  victim: string;
  /** A suicide's cause in words ("fell out of the world"); null on a line with a killer to name. */
  how: string | null;
  /** This player is in it, so the line is theirs to notice. */
  mine: boolean;
}

/**
 * What the player would use if they pressed the use key now, and what the
 * gametype's script says about it. Worked out in the browser every frame
 * (`app/useFocus.ts`); nothing here came over the wire.
 */
export interface UseFocusInfo {
  /** The prompt, with `{key}` where the key's name goes. null: in focus, and the script shows nothing. */
  text: string | null;
  /** The name of the key use is bound to, as the controls help spells it ("F"). */
  key: string;
  /** Which thing, for the dev overlay: a trigger or a solid by its place in the world's list, and its tags. */
  thing: { kind: "trigger" | "solid"; index: number; tags: readonly string[] };
}

export interface UiState {
  screen: Signal<Screen>;
  worlds: Signal<WorldEntry[]>;
  /** null: signed out. Multiplayer needs a player; the world does not. */
  user: Signal<UserInfo | null>;
  /** What went wrong with the last sign-in or registration, for the form to show. */
  authError: Signal<string | null>;
  /** Whether a sign-in is in flight, so the form can refuse to be submitted twice. */
  authBusy: Signal<boolean>;
  /** Every weapon a class may name, ready to list. Empty until the catalogue arrives. */
  weapons: Signal<UiWeapon[]>;
  /** The player's five classes. The api's copy: a save answers with all five and this is replaced. */
  loadouts: Signal<Loadout[]>;
  /**
   * The class last chosen in a match, which the in-match menu offers first and a
   * world walked offline is armed with.
   */
  selectedLoadout: Signal<number>;
  /** null: the in-match class menu is not up. */
  classChoice: Signal<ClassChoice | null>;
  /** The class this player is playing in a match, by index; null outside one, or before they have chosen. */
  playingClass: Signal<number | null>;
  /** A class chosen mid-life, waiting for the next spawn; null when there is none. */
  pendingClass: Signal<number | null>;
  /**
   * Whether the pause menu may offer the class menu: in a match whose gametype
   * lets players choose (`joined.classes`), once this player is in it.
   */
  canChooseClass: Signal<boolean>;
  /** null: not looking for a game. */
  lobby: Signal<LobbyInfo | null>;
  /**
   * Why the last matchmaking command was refused, for the lobby to show. The api
   * answers these in words ("no server for that map"), and without them pressing
   * Start Match against an empty fleet looks like a button that does nothing.
   */
  lobbyError: Signal<string | null>;
  /** Queued, but not in a lobby yet. */
  searching: Signal<boolean>;
  /** The display name of the world that is up, if any. */
  worldName: Signal<string | null>;
  loading: Signal<LoadingInfo | null>;
  /** null: nothing to click; the pause menu shows if paused. */
  prompt: Signal<Prompt | null>;
  error: Signal<ErrorInfo | null>;
  /** In a world, the game is paused (pointer unlocked in walk mode, or the menu opened in the dollhouse). */
  paused: Signal<boolean>;
  quality: Signal<QualityLevel>;
  /** Mouse sensitivity, in the units input/sensitivity.ts defines (CoD's). */
  sensitivity: Signal<number>;
  /** Volumes and the mute, 0..1. The app's copy of the mixer, replaced whenever it changes. */
  audio: Signal<AudioSettings>;
  controls: Signal<ControlHint[]>;
  /** A transient message, e.g. a dev toggle's confirmation. */
  toast: Signal<string | null>;
  minimap: {
    /** null: the world has no `minimap`. */
    map: Signal<MinimapInfo | null>;
    /** null: not walking, so there is no player to place. */
    pose: Signal<MinimapPose | null>;
  };
  hud: {
    /** null: not walking, so there is nobody to draw a crosshair for. */
    player: Signal<HudPlayerInfo | null>;
    /**
     * How wide the crosshair should stand open: the radius of the cone this
     * player's next round may leave in, **as a fraction of half the viewport's
     * height**, so the widget needs no camera and no field of view to draw it.
     *
     * The one number here that is this client's own *prediction* rather than the
     * server's answer, and deliberately: it is a pure function of inputs this
     * browser already has, the server re-simulates it to the same value, and a
     * crosshair that waited a round trip to open would be showing the player
     * their accuracy as it was a tenth of a second ago. Health and ammunition
     * are the opposite case and are not predicted (app/hud.ts).
     */
    cone: Signal<number>;
    /**
     * How far down the sights the player is, 0 to 1 — the weapon's own `ads`
     * fraction, predicted here for the same reason the cone is.
     *
     * The crosshair is drawn from it and nothing else is: aiming replaces the
     * crosshair with the weapon's sights, so a crosshair still on screen at a
     * full aim is a second, wrong reticle floating over the real one.
     */
    ads: Signal<number>;
    /** null: nothing hit since the world was entered. The widget fades its own flash. */
    hit: Signal<HitMarkerInfo | null>;
    /** Newest first, oldest dropped by age (`app/hud.ts`). */
    feed: Signal<KillFeedEntry[]>;
    /** null: nothing usable in focus, or not walking. */
    use: Signal<UseFocusInfo | null>;
    /**
     * This player's purse, as the server's last snapshot has it; null where the
     * gametype keeps none (`GametypeDecl.points`), or outside a match.
     */
    points: Signal<number | null>;
    /** The gametype's counters, in its declaration's order; empty where it declares none. */
    counters: Signal<HudCounter[]>;
  };
  debug: {
    /** Whether dev panels are available at all (development builds). */
    enabled: Signal<boolean>;
    stats: Signal<DebugStats | null>;
    /** undefined: inspector off; null: on, nothing picked. */
    inspector: Signal<PickInfo | null | undefined>;
    crosshair: Signal<boolean>;
  };
}

export interface UiCommands {
  enterWorld(slug: string): void;
  returnToMenu(): void;
  /** Play: from a prompt or the pause menu. Captures the mouse in walk mode, so it must be called from a click or key press. */
  resume(): void;
  setQuality(level: QualityLevel): void;
  /** Aim slower or faster, and remember it. Clamped to SENSITIVITY_LIMITS by the app. */
  setSensitivity(value: number): void;
  /** Turn the master or one channel up or down, 0..1. Remembered per browser. */
  setAudioVolume(channel: AudioChannel | "master", value: number): void;
  setAudioMuted(muted: boolean): void;

  /**
   * Draw `weapon` with `attachments` into `host`, turning, until this is called
   * again — or with a null host, which puts the preview away.
   *
   * A DOM element crosses the bridge here, which nothing else does. The app owns
   * the canvas and the renderer behind it (engine/weaponPreview.ts) because the
   * UI may hold no three.js; the UI owns where on the page it goes, because the
   * app has no business knowing that. An element is the smallest thing that says
   * only that.
   */
  previewWeapon(host: HTMLElement | null, weapon: string | null, attachments: readonly string[]): void;

  /** Save one class. The api answers with all five, reconciled, and the signals are replaced from that. */
  saveLoadout(index: number, loadout: Loadout): void;
  /** Open Create a Class, remembering where from so Back returns there. */
  openClasses(): void;
  closeClasses(): void;
  /** In a match: play this class — now, before the first spawn, or from the next spawn. */
  chooseClass(index: number): void;
  /** In a match, from the pause menu: open or close the class menu. */
  openClassChoice(): void;
  closeClassChoice(): void;

  signIn(username: string, password: string): void;
  register(username: string, password: string): void;
  signOut(): void;

  /** Join the queue. The lobby arrives on the event stream, not from here. */
  findGame(): void;
  /** A private lobby, for people you invite by its code. The map is chosen inside it. */
  createPrivateLobby(): void;
  /** Choose the lobby's map. The host's; the api refuses anyone else. */
  setLobbyMap(map: string): void;
  /**
   * Choose the lobby's gametype. The host's; the api refuses anyone else. On a map
   * the gametype is not played on, the map moves to the first one it is.
   */
  setLobbyMode(id: string): void;
  joinLobby(code: string): void;
  /** Arm the countdown. The host only; the api refuses anyone else. */
  startLobby(): void;
  /** Stop a private lobby's countdown, or end its running match for everyone. The host only. */
  endLobby(): void;
  /** Take the player back from the tab that displaced this one. */
  playHere(): void;
  /** Out of the queue and out of any lobby, back to the menu. */
  leaveLobby(): void;
}

export function createUiState(): UiState {
  return {
    screen: signal<Screen>("menu"),
    worlds: signal<WorldEntry[]>([]),
    user: signal(null),
    authError: signal(null),
    authBusy: signal(false),
    weapons: signal<UiWeapon[]>([]),
    loadouts: signal<Loadout[]>(defaultLoadouts()),
    selectedLoadout: signal(0),
    classChoice: signal(null),
    playingClass: signal(null),
    pendingClass: signal(null),
    canChooseClass: signal(false),
    lobby: signal(null),
    lobbyError: signal(null),
    searching: signal(false),
    worldName: signal(null),
    loading: signal(null),
    prompt: signal(null),
    error: signal(null),
    paused: signal(false),
    quality: signal<QualityLevel>("high"),
    sensitivity: signal(DEFAULT_SENSITIVITY),
    audio: signal(defaultAudioSettings()),
    controls: signal<ControlHint[]>([]),
    toast: signal(null),
    minimap: {
      map: signal(null),
      pose: signal(null),
    },
    hud: {
      player: signal(null),
      cone: signal(0),
      ads: signal(0),
      hit: signal(null),
      feed: signal<KillFeedEntry[]>([]),
      use: signal(null),
      points: signal(null),
      counters: signal<HudCounter[]>([]),
    },
    debug: {
      enabled: signal(false),
      stats: signal(null),
      inspector: signal(undefined),
      crosshair: signal(false),
    },
  };
}
