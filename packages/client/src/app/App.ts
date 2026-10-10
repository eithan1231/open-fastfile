// The application: the objects that live as long as the page (renderer,
// controls, collision, UI), and moving between the menu and a world.

import { formatDiagnosticsAcrossFiles } from "@3d/shared/dsl/diagnostics.js";
import { Animator } from "../engine/animator.js";
import { FxSystem, POSE_TIME } from "../engine/fx/system.js";
import { AudioSystem } from "../engine/audio/system.js";
import { Footsteps } from "../engine/audio/footsteps.js";
import { WeaponAudio } from "../engine/audio/weapons.js";
import { ActorVoices } from "../engine/audio/actors.js";
import { CollisionWorld } from "@3d/shared/collision/world.js";
import { Presence } from "@3d/shared/worlds/presence.js";
import { worldHash } from "@3d/shared/worlds/hash.js";
import { FirstPersonControls } from "../engine/controls/firstPerson.js";
import { DollhouseControls } from "../engine/controls/orbit.js";
import { parsePose, poseOrientation, type Pose } from "../engine/pose.js";
import { nextQualityLevel, QUALITY, type QualityLevel } from "../engine/quality.js";
import { clampSensitivity, loadSensitivity, saveSensitivity } from "../input/sensitivity.js";
import { ShadowFit } from "../engine/shadows.js";
import { Viewer } from "../engine/viewer.js";
import { Viewmodel } from "../engine/viewmodel.js";
import { DEFAULT_BINDINGS, keyLabel, type Action } from "../input/bindings.js";
import { InputManager } from "../input/InputManager.js";
import { contentBounds } from "../scene/scene.js";
import { mountUi } from "../ui/index.js";
import { DevTools, type ViewMode } from "./devTools.js";
import { ClassChoice } from "./classChoice.js";
import { Hud } from "./hud.js";
import { shotSpread } from "@3d/shared/sim/recoil.js";
import { minimapInfo, minimapPose } from "./minimap.js";
import { createUiState, type ControlHint, type ErrorInfo, type UiCommands, type UiState } from "./uiBridge.js";
import { Connection, type MatchTicket } from "../net/connection.js";
import { RemotePlayers } from "../net/remotePlayers.js";
import { Corpses, dropBody } from "../net/corpses.js";
import { ActorsView } from "../net/actors.js";
import type { GameEvent } from "@3d/shared/net/messages/events.js";
import { isBotId } from "@3d/shared/net/messages/fields.js";
import { loadCatalog } from "../net/catalog.js";
import { catalogueViewOf, type CatalogueView } from "@3d/shared/game/catalogueView.js";
import { defaultGametype } from "@3d/shared/game/gametypes/default.js";
import { hashString } from "@3d/shared/game/random.js";
import { gametype } from "@3d/shared/game/gametypes/registry.js";
import type { GametypeDecl } from "@3d/shared/game/gametypes/declaration.js";
import { CATALOG_VERSION, resolveWeapon, WeaponRegistry } from "@3d/shared/sim/weaponRegistry.js";
import type { WeaponDef } from "@3d/shared/sim/weaponDef.js";
import type { PlayerSnapshot } from "@3d/shared/net/messages/snapshot.js";
import type { PlayerState } from "@3d/shared/sim/player.js";
import { defaultLoadout } from "@3d/shared/sim/loadout.js";
import { WeaponPreviews } from "./preview.js";
import { weaponChoices } from "./weaponChoices.js";
import { PlayerSession } from "./session.js";
import { takeInviteCode } from "./invite.js";
import { ClientScripts, type ScriptSurroundings } from "./scripts.js";
import { UseFocus } from "./useFocus.js";
import type { PlayerView } from "@3d/shared/game/context.js";
import { NO_MATCH_VALUES, WorldSession, type Arrival, type Engine, type MatchValues } from "./WorldSession.js";
import { worldAssetPath } from "@3d/shared/protocol/routes/worlds.js";
import { catalogFilePath } from "@3d/shared/protocol/routes/catalog.js";
import { fetchManifest, loadWorldFromServer, worldBaseUrl } from "./worldLoader.js";

/** Seconds a toast stays up: long enough to read, and to retype a pose link the clipboard refused. */
const TOAST_SECONDS = 6;
/** An Esc this soon after pausing is the one that paused, if the browser delivers it after freeing the pointer. */
const ESC_ECHO_MS = 250;
/**
 * How long file changes must stop before a hot reload runs. An exporter writing
 * a world is a burst of hundreds of files; a single edit in an editor is one,
 * and this is short enough that saving still feels immediate.
 */
const RELOAD_QUIET_MS = 200;

/** The catalogue's folder under the worlds root, as the watcher reports a path relative to it. */
const CATALOG_DIR = "catalog";

/**
 * A changed catalogue file as the URL the AssetStore keyed it by.
 *
 * `catalog/<kind>/<game>/<id>/<rest...>` — built with the route's own builder
 * rather than spelled out here, for the reason the world's asset path is: a
 * second spelling of one file silently stops invalidating it.
 */
function catalogUrlOf(relative: string): string | undefined {
  const [dir, kind, game, id, ...rest] = relative.split("/");
  if (dir !== CATALOG_DIR || !kind || !game || !id || rest.length === 0) {
    return undefined;
  }
  return catalogFilePath(kind, game, id, rest.join("/"));
}

/** Degrees to radians, for the two the crosshair's own width needs. */
const DEG = Math.PI / 180;

export class App {
  private readonly viewer: Viewer;
  private readonly input: InputManager;
  private readonly collision = new CollisionWorld();
  /**
   * What this client collides with: the collision as the match has it, whose
   * presence each mount replaces and each snapshot updates. Everything that
   * steps or traces a player reads this rather than `collision`.
   */
  private readonly world = this.collision.view(new Presence(0));
  private readonly animator = new Animator();
  private readonly fx = new FxSystem();
  /** What the world sounds like. Built and running from boot, against a context the browser has not started yet. */
  private readonly audio = new AudioSystem();
  /**
   * Footsteps and landings, worked out from movement rather than sent. Built
   * here because it reads the collision world for what is under a foot, and
   * because a peer's steps come off the snapshot rather than off a frame.
   */
  private readonly footsteps = new Footsteps(this.audio, this.world);
  /**
   * Firing, reloading and a round arriving, worked out from weapon state rather
   * than sent. Beside the footsteps and for the same reasons: it reads the
   * collision world — to trace the round this client has just predicted — and a
   * peer's rounds come off the snapshot rather than off a frame.
   */
  private readonly weaponAudio = new WeaponAudio(this.audio, this.world);
  /** What the actors sound like — a voice, a swing, a death — worked out from their snapshots. */
  private readonly actorVoices = new ActorVoices(this.audio);
  /**
   * The gametype's own client half: what this browser does when the server says
   * something happened. The only thing in the browser handed a `ClientContext`.
   */
  private readonly scripts = new ClientScripts(this.audio);
  /** What the use key would use now, and the prompt the script puts on it. Every frame, predicted. */
  private readonly useFocus: UseFocus;
  /**
   * Who is in the match, the tick it was and the match's own numbers, as of the
   * newest snapshot: what a script's view is built from between announcements.
   * Empty offline.
   */
  private roster: Roster = EMPTY_ROSTER;
  private readonly viewmodel = new Viewmodel();
  /** The dev toggle; the viewmodel is also hidden outside walk mode. */
  private viewmodelShown = true;
  private readonly firstPerson: FirstPersonControls;
  private readonly dollhouse: DollhouseControls;
  private readonly shadowFit = new ShadowFit();
  /** The match, when one is running. Absent, everything below still plays offline. */
  private readonly remotes = new RemotePlayers();
  private readonly corpses = new Corpses();
  /** The creatures the game server runs. Drawn like peers, beside the scene. */
  private readonly actors = new ActorsView();
  private connection: Connection | undefined;
  /**
   * Every weapon this build can name, fetched once at boot. Empty until it
   * arrives and if it never does, which is survivable: a snapshot's weapon index
   * simply resolves to nothing and a peer keeps the weapon it was drawn with.
   */
  private weapons = new WeaponRegistry([]);
  /** The cast the catalogue offers, replaced when the one fetch lands. Empty until then. */
  private catalogue: CatalogueView = catalogueViewOf({ version: CATALOG_VERSION }, new WeaponRegistry([]));
  /** Which gametype is being played. The default until matchmaking names one. */
  private gametype: GametypeDecl = defaultGametype;
  /**
   * The server's tick rate, from `joined`, and what turns a snapshot's tick into
   * the clock a script reads. Zero until a match says otherwise, and then nothing
   * is announcing anything anyway.
   */
  private tickRate = 0;
  private readonly ui: UiState = createUiState();
  /** What the HUD shows, and the one place that decides whose numbers those are. */
  private readonly hud: Hud;
  private readonly classes: ClassChoice;
  /**
   * In a match and not in the world yet: from the moment the map starts loading
   * until a class is chosen, or the server says they are in, or the match is
   * given up on. Nothing may start play meanwhile — `resume` puts the joining
   * prompt back instead — because nobody plays before choosing a class.
   */
  private awaitingSpawn = false;
  private readonly playerSession: PlayerSession;
  private readonly dev: DevTools;
  /** The class menu's turning weapon. Builds its renderer on first use and drops it when the menu closes. */
  private readonly preview = new WeaponPreviews();

  private session: WorldSession | undefined;
  /** The match this player was sent to, while there is one. Survives a hot reload. */
  private ticket: MatchTicket | undefined;
  private mode: ViewMode = "walk";
  /**
   * Loads run one at a time (a save is several watcher events, an export
   * hundreds), and only the newest counts: two mounts interleaving would have
   * one dispose the scene the other is still building, since they share a session.
   */
  private loads: Promise<void> = Promise.resolve();
  private generation = 0;
  /** Pending coalesced hot reload (dev only); see `onSourceChanged`. */
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  /** A pose from the URL, waiting for its world to finish building. */
  private pendingPose: Pose | undefined;
  /** A lobby code from an invite link, waiting for a signed-in player to join it. */
  private pendingJoin: string | undefined;
  private toastTimer: ReturnType<typeof setTimeout> | undefined;
  private pausedAt = 0;

  constructor(container: HTMLElement) {
    this.viewer = new Viewer(container);
    const canvas = this.viewer.renderer.domElement;
    this.input = new InputManager(canvas);
    this.firstPerson = new FirstPersonControls(this.viewer.camera, this.input, this.world);
    this.dollhouse = new DollhouseControls(this.viewer.camera, canvas);
    this.dev = new DevTools({
      viewer: this.viewer,
      collision: this.collision,
      live: this.world,
      firstPerson: this.firstPerson,
      ui: this.ui,
      toast: (text) => this.toast(text),
      root: () => this.session?.root,
      world: () => this.session?.world,
      mode: () => this.mode,
      slug: () => this.session?.slug,
      viewmodel: () => this.viewmodel.describe(),
      audio: () => ({ voices: this.audio.voiceCount, placements: this.audio.ambienceCount.placements }),
      bodies: () => this.remotes.drawnBodies(),
      assets: () => this.session?.assets,
    });
    this.hud = new Hud(this.ui, () => this.weapons);
    this.useFocus = new UseFocus(this.ui, this.scripts, keyLabel(DEFAULT_BINDINGS.use.keys[0]!));
    this.classes = new ClassChoice(this.ui);
    this.playerSession = new PlayerSession(this.ui, {
      onMatchReady: (ticket, map, id) => {
        // Before the world is built: which `mode:` models and solids exist is the
        // gametype's, and `joined` arrives only once the world is up.
        this.gametype = gametype(id) ?? this.gametype;
        void this.enterMatch(ticket, map);
      },
      onRoundOver: () => this.returnToLobby(),
      // The menu is for a player in no lobby. One who is in one — after a reload,
      // or a Find Game that answered with the lobby they were already in — is
      // shown it, rather than a menu whose buttons the api would refuse.
      onLobby: () => {
        if (this.ui.screen.value === "menu") {
          this.ui.screen.value = "lobby";
        }
      },
      // Out of the lobby, so out of its match too. Only then: a world walked
      // offline was never the api's to end.
      onLeft: () => {
        if (this.ticket !== undefined || this.ui.screen.value === "lobby") {
          this.returnToMenu();
        }
      },
      onDisplaced: () => {
        this.ticket = undefined;
        this.teardownWorld();
        this.ui.screen.value = "elsewhere";
      },
    });
    // The listener rides the camera, which is outside the scene and so outside
    // the frozen-matrix rules that apply to everything in it.
    this.audio.attachTo(this.viewer.camera);
    // Beside the world rather than inside it, because the world root's matrices are frozen.
    this.viewer.roots.keep(this.remotes.root, this.audio.root, this.corpses.root, this.actors.root);
    this.viewer.pipeline.use("effects", this.fx.pass);
    this.viewer.pipeline.use("viewmodel", this.viewmodel.pass);
    // The moment this client last drew other players at, so the server can judge a
    // shot against what the shooter actually saw rather than against the present.
    // Peers first; with none, the actors, which are drawn at the same moment.
    this.firstPerson.onTick = (input, dt, claim) => this.connection?.send(input, dt, claim, this.remotes.renderTick() ?? this.actors.renderTick());

    this.ui.debug.enabled.value = import.meta.env.DEV;
    this.ui.controls.value = controlHints();
    mountUi(container, this.ui, this.commands());
    this.bindActions();
    this.viewer.onFrame((dt) => this.frame(dt));
    import.meta.hot?.on("world-source-changed", (data: { path?: string }) => this.onSourceChanged(data.path));
  }

  start(): void {
    this.ui.quality.value = this.viewer.qualityLevel;
    this.ui.audio.value = this.audio.settings;
    this.setSensitivity(loadSensitivity());
    console.info(`[render] ${this.viewer.profiler.describe()}`);
    // Before anything can join: the join carries this catalogue's hash, and a
    // server holding a different one refuses rather than misnaming weapons.
    void loadCatalog().then(({ weapons, catalogue }) => {
      this.weapons = weapons;
      this.catalogue = catalogue;
      this.firstPerson.player.setWeapons(weapons);
      this.preview.setWeapons(weapons);
      this.ui.weapons.value = weaponChoices(weapons);
      console.info(`[net] weapon catalogue: ${weapons.size} weapon(s), ${weapons.hash}`);
    });
    // `#slug@x,y,z,yaw,pitch` goes straight into that world at that camera.
    this.pendingPose = parsePose(location.hash);
    // `?join=CODE` goes straight into that lobby, once there is a player to put there.
    this.pendingJoin = takeInviteCode();
    void this.playerSession.restore().then((signedIn) => {
      if (!signedIn) {
        // The pose is kept: a deep link followed while signed out lands in its
        // world as soon as there is a player to land there.
        this.ui.screen.value = "auth";
        return;
      }
      this.afterSignIn();
    });
  }

  /** The menu, or straight into the lobby or the world a link named. */
  private afterSignIn(): void {
    const join = this.pendingJoin;
    this.pendingJoin = undefined;
    if (join !== undefined) {
      // The manifest too: the lobby shows its map by name and picture.
      void this.fetchWorlds();
      this.ui.screen.value = "lobby";
      this.playerSession.joinLobby(join);
      return;
    }
    const pose = this.pendingPose;
    // The manifest first even so, for the loading screen's picture and details.
    if (pose) {
      void this.fetchWorlds().then(() => this.enterWorld(pose.slug));
    } else {
      void this.showMenu();
    }
  }

  private commands(): UiCommands {
    return {
      enterWorld: (slug) => void this.enterWorld(slug),
      returnToMenu: () => this.returnToMenu(),
      resume: () => this.resume(),
      setQuality: (level) => this.setQuality(level),
      setSensitivity: (value) => this.setSensitivity(value, { save: true }),
      setAudioVolume: (channel, value) => {
        this.audio.setVolume(channel, value);
        this.ui.audio.value = this.audio.settings;
      },
      setAudioMuted: (muted) => {
        this.audio.setMuted(muted);
        this.ui.audio.value = this.audio.settings;
      },

      previewWeapon: (host, weapon, attachments) => void this.preview.show(host, weapon, attachments),
      saveLoadout: (index, loadout) => this.playerSession.saveLoadout(index, loadout),
      openClasses: () => {
        this.ui.screen.value = "classes";
      },
      // Back to wherever Create a Class was opened from, which is the lobby for a
      // player in one: the menu's buttons would all be refused to them.
      closeClasses: () => {
        this.ui.screen.value = this.playerSession.inLobby ? "lobby" : "menu";
      },
      chooseClass: (index) => this.chooseClass(index),
      openClassChoice: () => {
        this.ui.classChoice.value = "change";
      },
      closeClassChoice: () => {
        if (this.ui.classChoice.value === "change") {
          this.ui.classChoice.value = null;
        }
      },

      signIn: (username, password) => void this.playerSession.signIn(username, password).then((ok) => ok && this.afterSignIn()),
      register: (username, password) => void this.playerSession.register(username, password).then((ok) => ok && this.afterSignIn()),
      signOut: () => {
        void this.playerSession.signOut();
        this.ui.screen.value = "auth";
      },

      findGame: () => {
        this.ui.screen.value = "lobby";
        this.playerSession.findGame();
      },
      createPrivateLobby: () => {
        this.ui.screen.value = "lobby";
        this.playerSession.createPrivateLobby();
      },
      setLobbyMap: (map) => this.playerSession.setLobbyMap(map),
      setLobbyMode: (id) => this.playerSession.setLobbyMode(id),
      joinLobby: (code) => {
        this.ui.screen.value = "lobby";
        this.playerSession.joinLobby(code);
      },
      startLobby: () => this.playerSession.startLobby(),
      endLobby: () => this.playerSession.endLobby(),
      playHere: () => {
        this.ui.screen.value = "menu";
        this.playerSession.playHere();
        void this.fetchWorlds();
      },
      leaveLobby: () => {
        this.playerSession.leave();
        this.ui.screen.value = "menu";
      },
    };
  }

  private get engine(): Engine {
    return {
      viewer: this.viewer,
      animator: this.animator,
      fx: this.fx,
      audio: this.audio,
      collision: this.collision,
      live: this.world,
      weapons: this.weapons,
      // The gametype is the default one until a match names another: a world is
      // walked around offline far more often than it is played.
      cast: () => ({ catalogue: this.catalogue, gametype: this.gametype }),
      loadout: () => this.ui.loadouts.value[this.ui.selectedLoadout.value] ?? defaultLoadout(0),
      firstPerson: this.firstPerson,
      dollhouse: this.dollhouse,
      shadowFit: this.shadowFit,
      viewmodel: this.viewmodel,
      remotes: this.remotes,
      corpses: this.corpses,
      actors: this.actors,
      dev: this.dev,
    };
  }

  private async showMenu(): Promise<void> {
    this.ui.screen.value = this.playerSession.inLobby ? "lobby" : "menu";
    await this.fetchWorlds();
  }

  private async fetchWorlds(): Promise<void> {
    try {
      this.ui.worlds.value = await fetchManifest();
    } catch (e) {
      this.ui.worlds.value = [];
      console.error("Failed to load worlds manifest", e);
    }
  }

  /** Enter a world, or re-enter the current one after an edit (`reload`), keeping the camera. */
  private enterWorld(slug: string, reload = false): Promise<void> {
    const generation = ++this.generation;
    const next = this.loads.then(() => this.load(slug, reload, generation));
    this.loads = next; // `load` never rejects, so the queue cannot be poisoned
    return next;
  }

  /** Whether this load is still the one the app is waiting for. */
  private current(generation: number): boolean {
    return generation === this.generation;
  }

  private async load(slug: string, reload: boolean, generation: number): Promise<void> {
    if (!this.current(generation)) {
      return;
    }
    try {
      await this.loadWorld(slug, reload, generation);
    } catch (e) {
      // Or a world that throws leaves the loading screen up for good.
      if (!this.current(generation)) {
        return;
      }
      console.error(`Failed to load world "${slug}"`, e);
      this.showError({
        title: `Could not load world "${slug}"`,
        detail: e instanceof Error ? (e.stack ?? e.message) : String(e),
        watching: import.meta.env.DEV,
      });
    }
  }

  private async loadWorld(slug: string, reload: boolean, generation: number): Promise<void> {
    let entry = this.ui.worlds.value.find((w) => w.slug === slug) ?? { slug, name: slug };
    if (!reload) {
      this.ui.loading.value = { world: entry, step: "fetch", progress: 0 };
      this.ui.screen.value = "loading";
    }
    const result = await loadWorldFromServer(slug);
    if (!this.current(generation)) {
      return;
    }
    if ("fetchError" in result) {
      console.error(`Failed to load world "${slug}"`, result.fetchError);
      this.showError({ title: `Could not load world "${slug}"`, detail: String(result.fetchError), watching: false });
      return;
    }
    if (!result.ok) {
      const errors = result.diagnostics.filter((d) => d.severity === "error").length;
      const warnings = result.diagnostics.length - errors;
      const title = `${slug}: ${plural(errors, "error")}${warnings ? `, ${plural(warnings, "warning")}` : ""}`;
      this.showError({ title, detail: formatDiagnosticsAcrossFiles(result.sources, result.diagnostics), watching: true });
      return;
    }

    let arrival: Arrival = { kind: "spawn" };
    if (reload && this.session?.slug === slug) {
      const { feet, yaw, pitch } = this.firstPerson.player.movement;
      arrival = { kind: "keep", feet: { ...feet }, yaw, pitch };
    } else if (this.pendingPose?.slug === slug) {
      const pose = this.pendingPose;
      arrival = { kind: "pose", feet: { x: pose.x, y: pose.y, z: pose.z }, ...poseOrientation(pose), hold: pose.hold };
    }
    this.pendingPose = undefined;

    if (this.session?.slug !== slug) {
      this.session?.dispose();
      this.session = new WorldSession(slug, this.engine);
    }
    entry = { ...entry, name: result.world.name };
    const onStep = reload
      ? undefined
      : (step: string, index: number, count: number) => {
          // The fetch was the first of count + 1 steps.
          this.ui.loading.value = { world: entry, step, progress: (index + 1) / (count + 1) };
          return yieldToBrowser(); // or the step never paints: most of them are synchronous
        };
    await this.session.mount(result.world, arrival, onStep);
    if (!this.current(generation)) {
      return;
    } // left for the menu, or superseded
    // A held pose is a screenshot, so time holds too; a hot reload keeps whatever it was.
    if (arrival.kind !== "keep") {
      this.animator.paused = arrival.kind === "pose" && arrival.hold;
      this.fx.paused = this.animator.paused;
    }
    // A particle system starts empty, so holding it at t=0 would screenshot a
    // clear sky and read as a rendering bug rather than a timing one. Replaying
    // to a fixed point in fixed steps also makes the frame identical run to run,
    // which is what keeps `pnpm shots` diffs meaningful for every world.
    if (arrival.kind === "pose" && arrival.hold) {
      // The camera first: mounting leaves it at the dollhouse's framing until the
      // next frame, and a frustum-gated elem judged from there spawns nothing.
      if (this.mode === "walk") {
        this.firstPerson.snapCamera();
      }
      this.fx.seekTo(POSE_TIME, this.viewer.camera);
    }
    if (arrival.kind === "pose" && arrival.hold) {
      this.toast("held still (pose has `hold`): press W/A/S/D to release");
    }

    this.ui.worldName.value = result.world.name;
    const minimap = result.world.minimap;
    this.ui.minimap.map.value = minimap ? minimapInfo(minimap, worldBaseUrl(slug)) : null;
    this.ui.error.value = null;
    this.ui.loading.value = null;
    if (!reload) {
      this.ui.prompt.value = this.awaitingSpawn ? "joining" : "play";
    } // over the world, which runs behind it
    this.ui.screen.value = "world";
    this.viewer.start();
    this.setMode(arrival.kind === "keep" ? this.mode : "walk");
    // A hot reload rebuilds the scene, not the match: dropping the channel and
    // rejoining on every file save would make the player flicker for everyone
    // else. The ticket is the api's, and a reload does not invalidate it.
    if (reload && this.ticket && !this.connection) {
      this.joinMatch(this.ticket);
    }
  }

  /**
   * A game is standing and this player is on its roster: load the map, then
   * connect. The world comes first because it is playable whatever happens to
   * the connection, and nothing about a match may take that away.
   */
  private async enterMatch(ticket: MatchTicket, map: string): Promise<void> {
    this.ticket = ticket;
    this.awaitingSpawn = true;
    await this.enterWorld(map);
    // The round can end while its map is loading — a host ending it, a game
    // nobody else reached — and the world can fail to load at all. Either way
    // there is no match left to join, and a channel opened now would sit
    // connected to a game that has gone, behind whatever screen is up instead.
    if (this.ticket !== ticket || this.ui.screen.value !== "world") {
      return;
    }
    this.joinMatch(ticket);
  }

  /**
   * Open the channel the ticket names. Fire and forget: the world is already up,
   * and nothing here may surface an error.
   */
  private joinMatch(ticket: MatchTicket): void {
    this.leaveMatch();
    const connection = new Connection(
      {
        onJoined: (joined) => {
          const { tickRate, gametype: id } = joined;
          this.tickRate = tickRate;
          this.firstPerson.setTickRate(tickRate);
          // The stream this player's recoil draws from. The same hash of the same
          // id the game server uses, so the kick this client predicts is the one
          // the server judges its shots with (@3d/shared/sim/recoil.ts).
          this.firstPerson.player.setSeed(hashString(ticket.playerId));
          // The same stream, so a replay of this player reproduces their boots
          // as well as their recoil.
          this.footsteps.setSeed(hashString(ticket.playerId));
          // And the same one again for the weapon: a round's spread cone is drawn
          // from it, so an impact this end predicts lands where the server's does.
          this.weaponAudio.setSeed(hashString(ticket.playerId));
          // Snapshots arrive at that rate, so it is also how far back peers are drawn.
          this.remotes.setTickRate(tickRate);
          this.actors.setTickRate(tickRate);
          // From here the HUD is the server's: its rules give the health bar a
          // denominator, and its id says which feed lines are this player's.
          this.hud.joined(joined, ticket.playerId, gametype(id));
          // A gametype this build does not know is *not* a reason to refuse the
          // match: the server has already admitted us, and the default's cast is a
          // better answer than no players at all. It is worth saying out loud,
          // because everyone wearing the wrong faction is otherwise unaccountable.
          const decl = gametype(id);
          if (decl && decl.mode !== this.world.presence.mode) {
            // The world was built for another mode's models; its solids follow the snapshot anyway.
            console.warn(`[net] the world was built for mode "${this.world.presence.mode ?? "none"}" and ${decl.display} plays "${decl.mode ?? "none"}"`);
          }
          if (decl) {
            this.gametype = decl;
          } else {
            console.warn(`[net] the server is running gametype "${id}", which this build does not know; using ${this.gametype.id}`);
          }
          console.info(`[net] joined game ${ticket.gameId} at ${tickRate} Hz, playing ${this.gametype.display}`);
          this.classes.clear();
          // Passing the kill plane is a death now, which the server deals: held
          // where they fell on this end too, so the prediction stops where the
          // server's replay does (`FallOut`).
          this.firstPerson.player.setFallOut("die");
          if (joined.spawned) {
            // In already: a reconnect after a hot reload, or a gametype with no
            // classes to choose. Nothing left to wait for.
            this.awaitingSpawn = false;
            this.ui.canChooseClass.value = joined.classes;
            // The server kept our class; the last one chosen is the best guess at which it was.
            this.ui.playingClass.value = joined.classes ? this.ui.selectedLoadout.value : null;
            if (this.ui.prompt.value === "joining") {
              this.ui.prompt.value = "play";
            }
          } else {
            // Seated, not spawned: nothing happens in this game until a class is
            // chosen, so the class menu goes up over everything else.
            this.ui.classChoice.value = "spawn";
            this.ui.prompt.value = null;
            this.input.exitPointerLock();
            this.setPaused(true);
          }
        },
        onSnapshot: ({ tick, self, others, actors, pending, events, presence, counters }) => {
          // Before `apply`, which is what would otherwise go on posing a body that
          // has stopped being sent inputs — a corpse standing up, idling and
          // aiming, which is what a dead player looks like today.
          this.dropTheDead(events);
          // Before the corpses step: a part leaves at the tick it left on the server.
          this.session?.applyPresence(presence, tick);
          this.remotes.apply(others, tick, performance.now());
          // Every body's hit boxes fetched before its first death, not at it.
          this.corpses.prepare(this.remotes.drawnBodies());
          this.actors.apply(actors, tick, performance.now());
          this.actorVoices.apply(actors, performance.now() / 1000);
          // Off the snapshot and not off a frame: these are the server's own tick
          // states, so every client hears the same step at the same place.
          this.footsteps.remote(others, tick);
          this.weaponAudio.remote(others, this);
          // After `others` is in hand: a death needs the feet of whoever fell,
          // and a hit marker is this player's own answer about their own round.
          this.soundEvents(events, self, others);
          this.roster = this.rosterOf(tick, self, others, counters);
          // The gametype's own, and the only events this engine does not know the
          // meaning of: a script published them and a script is what reads them.
          this.scriptEvents(events);
          // Once per server tick, never per frame: a corpse's step count is
          // `tick - spawnTick` and every end has to arrive at the same number.
          this.corpses.step(tick);
          this.hud.snapshot(self, events, performance.now());
          this.hud.counters(counters);
          // The menu's marks: a waiting class is the one in hand once they are up.
          // The weapons themselves arrive in `self` (`PlayerState.armed`).
          this.classes.snapshot(self?.dead);
          // The correction. Before the server was authoritative there was nothing
          // to apply — it believed whatever this client claimed — so the local
          // player was filtered out of every snapshot and only peers arrived.
          if (self) {
            this.firstPerson.reconcile(self, pending);
          }
        },
        // SHOTTRACE (docs/engine/diagnostics-shottrace.md): the server's own
        // account of a round this player fired, drawn beside this client's.
        onShotTrace: (trace) => this.dev.serverShotTrace(trace),
        onClassChosen: (index, timing) => {
          console.info(`[net] class ${index + 1}: ${timing}`);
          const said = this.classes.answered(index, timing, this.ui.loadouts.value[index]?.name ?? `Class ${index + 1}`);
          if (said !== null) {
            this.toast(said);
          }
        },
        // The world stays, offline, as it would with no game server at all: so
        // nobody is waiting to be spawned any more, and the world can be played.
        onOffline: () => this.playOffline(),
        onClosed: () => {
          this.classes.clear();
          this.playOffline();
          this.remotes.clear();
          this.actors.clear();
          this.actorVoices.clear();
          this.corpses.clear();
          this.footsteps.clear();
          this.weaponAudio.clear();
          // Back to what this browser knows about itself. Left alone, the HUD
          // would hold the last numbers a dead channel gave it for the rest of
          // the world, which is worse than an offline one.
          this.hud.clear();
        },
      },
      this.weapons.hash,
      this.session?.world ? worldHash(this.session.world) : "",
    );
    this.connection = connection;
    if (!connection.connect(ticket)) {
      this.leaveMatch();
    }
  }

  private leaveMatch(): void {
    this.connection?.close();
    this.connection = undefined;
    this.classes.clear();
    this.awaitingSpawn = false;
    this.firstPerson.player.setFallOut("respawn");
    this.remotes.clear();
    this.actors.clear();
    this.actorVoices.clear();
    this.corpses.clear();
    this.footsteps.clear();
    this.weaponAudio.clear();
    this.hud.clear();
    this.roster = EMPTY_ROSTER;
  }

  /** A class, clicked in the class menu. See `ClassChoice` for who decides what. */
  private chooseClass(index: number): void {
    const loadout = this.ui.loadouts.value[index];
    if (!loadout || !this.connection || this.ui.classChoice.value === null) {
      return;
    }
    this.connection.chooseClass(index);
    // Remembered as the last chosen, which is what the menu offers first next time.
    this.playerSession.selectLoadout(index);
    if (this.classes.chose(index)) {
      // Spawning. The weapons arrive with the server's state; this only lets the
      // player into the world, and the click that chose is also the gesture
      // pointer lock wants.
      this.awaitingSpawn = false;
      this.ui.canChooseClass.value = true;
      this.resume();
    }
  }

  /** The match could not be joined, or went away: the world plays on offline, as a world with no server does. */
  private playOffline(): void {
    this.awaitingSpawn = false;
    this.firstPerson.player.setFallOut("respawn");
    if (this.ui.prompt.value === "joining") {
      this.ui.prompt.value = "play";
    }
  }

  /**
   * The two sounds the event tail raises: a hit marker for this player, and a
   * body arriving for whoever fell.
   *
   * `events` is already de-duplicated by `unseenEvents`, which is what makes
   * this safe to raise on: a death is repeated for sixty datagrams and a marker
   * is sent once, and neither is heard twice. A `hit` names nobody — the marker
   * is only ever this player's own — and a `death` names the victim, whose feet
   * are wherever the same snapshot already put them.
   */
  private soundEvents(events: readonly GameEvent[], self: PlayerState | undefined, others: readonly PlayerSnapshot[]): void {
    for (const event of events) {
      if (event.kind === "hit") {
        this.weaponAudio.hitMarker();
      } else if (event.kind === "death") {
        const fell = event.victim === this.ticket?.playerId ? self : others.find((p) => p.id === event.victim)?.state;
        if (fell) {
          this.weaponAudio.death(fell.movement.feet);
        }
      }
    }
  }

  /**
   * The announcements in one tail, handed to the gametype's client scripts.
   *
   * De-duplicated by `unseenEvents` before it gets here, which is what makes a
   * kind that is repeated for a second safe to act on: the countdown is heard
   * once however many datagrams carried it.
   *
   * The view is built once per tail and only when there is something to hear —
   * `indexWorld` is memoised by the session, but the roster is not, and most ticks
   * announce nothing at all. Nothing happens before a world is mounted or before
   * `joined` named a tick rate, because there is no clock to read then.
   */
  private scriptEvents(events: readonly GameEvent[]): void {
    const announcements = events.filter((event) => event.kind === "announce");
    const session = this.session;
    const world = session?.world;
    if (announcements.length === 0 || !session || !world || this.tickRate === 0) {
      return;
    }
    const where = this.surroundings(session, world);
    for (const event of announcements) {
      this.scripts.hear(event, where);
    }
  }

  /** The players in one snapshot, as a script sees them: sides resolved to names. */
  private rosterOf(tick: number, self: PlayerState | undefined, others: readonly PlayerSnapshot[], counters: readonly number[]): Roster {
    const sideOf = (team: number | null): string | undefined => (team === null ? undefined : this.gametype.teams[team]);
    const me = this.ticket?.playerId;
    // `since` is left undefined on every one of them: this browser is told
    // nobody's join time, and inventing one would put a different number in front
    // of a hook than the server read (@3d/shared/game/context.ts).
    const players = [
      ...(self && me !== undefined ? [{ id: me, team: sideOf(self.team), bot: false, points: self.points }] : []),
      ...others.map((peer) => ({ id: peer.id, team: sideOf(peer.state.team), bot: isBotId(peer.id), points: peer.state.points })),
    ];
    return { players, tick, values: { counters } };
  }

  /** The scripts' view of the match as of the newest snapshot: the clock, the roster and which of them is us. */
  private surroundings(session: WorldSession, world: NonNullable<WorldSession["world"]>): ScriptSurroundings {
    const { players, tick, values } = this.roster;
    const me = this.ticket?.playerId;
    return {
      view: session.gameView(world, this.tickRate === 0 ? 0 : tick / this.tickRate, players, values),
      self: me === undefined ? undefined : players.find((player) => player.id === me),
    };
  }

  /**
   * What the use key would use now, from the predicted player — the same rule the
   * server applies to the input when the key goes down — and the prompt on it.
   * Nothing while not walking, or dead.
   */
  private updateUseFocus(): void {
    const session = this.session;
    const world = session?.world;
    const player = this.firstPerson.player;
    if (!session || !world || this.mode !== "walk" || this.ui.screen.value !== "world" || player.dead) {
      this.useFocus.update(null);
      return;
    }
    const { feet, yaw, pitch } = player.movement;
    this.useFocus.update({
      world,
      mode: this.world.presence.mode,
      collision: this.world,
      presence: this.world.presence,
      partBounds: (index) => this.collision.partBounds(index),
      feet,
      yaw,
      pitch,
      where: () => this.surroundings(session, world),
    });
  }

  /**
   * See `WeaponSource`: a peer's weapon index and attachments as the definition
   * they name. `resolveWeapon` hands back the entry's own object where nothing is
   * fitted, so the usual peer costs no allocation.
   */
  defAt(index: number | null, attachments: readonly number[]): WeaponDef | undefined {
    const entry = this.weapons.entry(this.weapons.idAt(index));
    return entry === undefined ? undefined : resolveWeapon(entry, attachments);
  }

  /**
   * Turn a spawn the server sent into a body on the floor.
   *
   * Driven off the event rather than off `dead` in the snapshot, and the difference
   * is the whole point: `dead` would tell this client *that* somebody fell, and
   * every client would then invent its own answer to *how*. The event carries the
   * pose, the velocity and the round's own push, quantised, so sixteen jointed
   * boxes start from the same numbers everywhere.
   *
   * The body is **handed over, not rebuilt**: the rig `RemotePlayers` is drawing is
   * already the one `bodyIndex` chose from this player's id, which is the body the
   * server traced the killing round against. A hand-over that cannot be completed —
   * no physics in this world, or a body whose hit boxes have not arrived yet —
   * puts nothing on the floor and lets `apply` go on drawing them standing, which
   * is what a build with no physics does anyway.
   *
   * Repeats cost nothing: `Corpses.spawn` is a no-op for an entity it holds, and so
   * is `PhysicsWorld.spawn` underneath it. That matters because a spawn is repeated
   * for half a second, exactly as a death is.
   */
  private dropTheDead(events: readonly GameEvent[]): void {
    for (const event of events) {
      if (event.kind !== "spawn") {
        continue;
      }
      dropBody(this.remotes, this.corpses, event);
    }
  }

  /**
   * The round is over. Everything `returnToMenu` tears down, torn down the same
   * way — its `generation++` and its cleared reload timer are both load-bearing
   * — but landing back in the lobby the player came from rather than the menu.
   */
  private returnToLobby(): void {
    this.ticket = undefined;
    this.teardownWorld();
    this.ui.screen.value = "lobby";
  }

  private showError(error: ErrorInfo): void {
    this.ui.error.value = error;
    this.ui.loading.value = null;
    this.ui.prompt.value = null;
    this.ui.screen.value = "error";
    this.input.context = "menu";
  }

  /** A `.world` or asset file changed on disk (dev server only). */
  private onSourceChanged(path: string | undefined): void {
    const session = this.session;
    if (!session) {
      return;
    }
    // This world's own files, or the catalogue — which belongs to no world and so
    // could never match a slug. A world cannot include another's sources, and an
    // exporter run rewrites every other world on disk, each of which used to
    // reload whatever world was loaded here.
    const inCatalog = path?.startsWith(`${CATALOG_DIR}/`) ?? false;
    if (path !== undefined && !inCatalog && !path.startsWith(`${session.slug}/`)) {
      return;
    }
    // The AssetStore is keyed by the URL scene/ loaded with, so the key has to be
    // built by the same builder rather than spelled out a second time here.
    const assetUrl = path === undefined ? undefined : inCatalog ? catalogUrlOf(path) : worldAssetPath(session.slug, path.slice(session.slug.length + 1));
    if (assetUrl !== undefined && session.assets.invalidate(assetUrl)) {
      console.info(`[reload] ${path} changed; reloading it`);
    }
    // One reload for a burst of changes. Each invalidation above is already
    // recorded, so a reload after the burst picks up all of them — while a
    // reload per file re-fetches and re-resolves the whole world, and an
    // exporter run writes hundreds of files per map.
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = undefined;
      if (this.session === session) {
        void this.enterWorld(session.slug, true);
      }
    }, RELOAD_QUIET_MS);
  }

  private returnToMenu(): void {
    // Leaving a match is leaving its lobby. Left in it, the api goes on counting
    // this player as in the game: the menu's buttons refuse them, and the round
    // ending pulls them back into a lobby — or a public one's next match — from
    // wherever they have gone since.
    if (this.playerSession.inLobby) {
      this.playerSession.leave();
    }
    this.ticket = undefined;
    this.teardownWorld();
    const memory = this.viewer.renderer.info.memory;
    console.info(`[menu] GPU holds ${memory.geometries} geometries, ${memory.textures} textures`);
    // Drop the fragment, or reloading from the menu goes straight back into the world.
    if (location.hash) {
      history.replaceState(null, "", location.pathname);
    }
    void this.showMenu();
  }

  /** Everything that has to stop when a world goes away, whatever comes next. */
  private teardownWorld(): void {
    this.generation++; // a load still in flight must not put its world back up
    clearTimeout(this.reloadTimer); // or a file change from before this re-enters the world
    this.reloadTimer = undefined;
    this.input.context = "menu";
    this.viewer.stop();
    this.firstPerson.setActive(false);
    this.firstPerson.setFrozen(false);
    this.dollhouse.enabled = false;
    this.dev.reset();
    this.leaveMatch();
    this.session?.dispose();
    this.session = undefined;
    this.pendingPose = undefined;
    this.ui.worldName.value = null;
    this.ui.minimap.map.value = null;
    this.ui.minimap.pose.value = null;
    this.ui.error.value = null;
    this.ui.loading.value = null;
    this.ui.prompt.value = null;
    this.ui.paused.value = false;
    this.clearToast();
  }

  /**
   * Paused means gameplay input is off and the pause menu is up. Walking is
   * paused exactly while the pointer is unlocked; the dollhouse by choice.
   */
  private setPaused(paused: boolean): void {
    this.ui.paused.value = paused;
    if (paused) {
      this.pausedAt = performance.now();
    }
    this.input.context = paused ? "menu" : "world";
  }

  /**
   * Play, from a click or key press (Click to play, Resume Game). In walk mode
   * the lock change then unpauses and clears the prompt.
   */
  private resume(): void {
    // The click that takes the pointer is also the gesture a browser wants
    // before it will start an AudioContext, and this is the one place both are
    // known to be inside one. `engine/audio/context.ts` is the backstop for the
    // gestures that never reach here — signing in, and the menus.
    this.audio.unlock();
    // Not in the world yet: back to waiting for the server, over which the class
    // menu comes up by itself (`onJoined`).
    if (this.awaitingSpawn) {
      if (this.ui.classChoice.value === null) {
        this.ui.prompt.value = "joining";
      }
      return;
    }
    if (this.mode !== "walk") {
      this.ui.prompt.value = null;
      this.setPaused(false);
      return;
    }
    void this.input.requestPointerLock();
  }

  /**
   * Esc in the pause menu. The browser freed the pointer before the page saw
   * the key, and will not re-lock from it, so this usually asks for a click.
   */
  private resumeFromKey(): void {
    if (this.awaitingSpawn) {
      return this.resume(); // which puts the joining prompt back
    }
    if (this.mode !== "walk") {
      return this.setPaused(false);
    }
    void this.input.requestPointerLock().then((locked) => {
      if (!locked && this.ui.screen.value === "world" && this.ui.paused.value) {
        this.ui.prompt.value = "resume";
      }
    });
  }

  private setMode(next: ViewMode): void {
    this.mode = next;
    this.dev.onModeChange(next);
    this.firstPerson.setActive(next === "walk");
    if (next !== "walk") {
      this.input.exitPointerLock();
    }
    this.dollhouse.enabled = next === "dollhouse";
    const root = this.session?.root;
    if (next === "dollhouse" && root) {
      this.dollhouse.frame(contentBounds(root));
    }
    this.setPaused(next === "walk" && !this.input.locked);
  }

  /** Works in the menu too; the level is remembered per browser. */
  private setQuality(level: QualityLevel): void {
    const root = this.session?.root;
    let texelSize: number | undefined;
    if (root) {
      // Focus radius and map size are per level, so the frustum is refitted first.
      texelSize = this.shadowFit.build(root, contentBounds(root), {
        focusRadius: QUALITY[level].shadowFocusRadius,
        mapSize: QUALITY[level].shadowMapSize,
      }).texelSize;
      this.shadowFit.update(this.viewer.camera);
    }
    this.viewer.setQuality(level, root, texelSize);
    this.ui.quality.value = level;
  }

  /** The aim's scale, and the UI's copy of it. Remembered per browser once a player has chosen one. */
  private setSensitivity(value: number, options: { save?: boolean } = {}): void {
    const clamped = clampSensitivity(value);
    this.firstPerson.setSensitivity(clamped);
    this.ui.sensitivity.value = clamped;
    if (options.save) {
      saveSensitivity(clamped);
    }
  }

  private toast(text: string): void {
    this.ui.toast.value = text;
    if (this.toastTimer !== undefined) {
      clearTimeout(this.toastTimer);
    }
    this.toastTimer = setTimeout(() => this.clearToast(), TOAST_SECONDS * 1000);
  }

  private clearToast(): void {
    if (this.toastTimer !== undefined) {
      clearTimeout(this.toastTimer);
    }
    this.toastTimer = undefined;
    this.ui.toast.value = null;
  }

  private bindActions(): void {
    const { input, dev } = this;
    input.on("toggleView", () => this.setMode(this.mode === "walk" ? "dollhouse" : "walk"));
    input.on("quality", () => this.setQuality(nextQualityLevel(this.viewer.qualityLevel)));
    input.on("menu", () => this.onMenuKey());
    if (this.ui.debug.enabled.value) {
      input.on("inspector", () => dev.toggleInspector());
      input.on("colliders", () => dev.toggleColliders());
      input.on("mantles", () => dev.toggleMantles());
      input.on("hitboxes", () => dev.toggleHitboxes());
      input.on("surfaces", () => dev.toggleSurfaces());
      input.on("navigation", () => dev.toggleNavigation());
      input.on("shotTraces", () => dev.toggleShotTraces()); // SHOTTRACE
      input.on("hideModels", () => dev.toggleModels());
      input.on("pauseAnimation", () => {
        this.animator.paused = !this.animator.paused;
        this.toast(this.animator.paused ? "animation paused" : "animation running");
      });
      input.on("sun", () => dev.toggleSun());
      input.on("viewmodel", () => {
        this.viewmodelShown = !this.viewmodelShown;
        this.toast(this.viewmodelShown ? "viewmodel shown" : "viewmodel hidden");
      });
      input.on("capturePose", () => dev.capturePose());
    }
    // A pointer that unlocks (Esc, alt-tab) pauses a walk; one that locks resumes it.
    input.onLockChange((locked) => {
      if (this.ui.screen.value !== "world" || this.mode !== "walk") {
        return;
      }
      if (locked && this.awaitingSpawn) {
        this.input.exitPointerLock(); // not in the world yet: see `awaitingSpawn`
        return;
      }
      if (locked) {
        this.ui.prompt.value = null;
      }
      this.setPaused(!locked);
    });
    this.firstPerson.onUnfreeze = () => {
      this.animator.paused = false;
      this.toast("released");
    };
  }

  /** Esc toggles the pause menu. Walking, the lock change does the pausing. */
  private onMenuKey(): void {
    const screen = this.ui.screen.value;
    if (screen === "error") {
      return this.returnToMenu();
    }
    if (screen !== "world") {
      return;
    }
    // Over the class menu, Esc is that menu's: Back when changing class (its own
    // handler), and nothing at all on joining, where there is no game to go back to.
    if (this.ui.classChoice.value !== null) {
      return;
    }
    if (this.ui.prompt.value) {
      this.ui.prompt.value = null; // to the pause menu: the game is paused under a prompt
      return;
    }
    if (!this.ui.paused.value) {
      if (this.mode === "walk") {
        this.input.exitPointerLock();
      } else {
        this.setPaused(true);
      }
    } else if (performance.now() - this.pausedAt > ESC_ECHO_MS) {
      this.resumeFromKey();
    }
  }

  /** The hands follow the local player: its weapon, which stepped with it, and its movement. */
  private updateViewmodel(dt: number): void {
    const vm = this.viewmodel;
    const walking = this.mode === "walk";
    vm.visible = this.viewmodelShown && walking;
    vm.paused = this.animator.paused; // a held pose holds the arms too
    vm.update(dt, { camera: this.viewer.camera, turn: this.firstPerson.turn, movement: this.firstPerson.player.movement });
    const zoom = walking ? vm.zoom : 1;
    this.viewer.setZoom(zoom);
    // The aim is scaled by the same number the view is, so a scope does not cost
    // its own magnification in precision. See FirstPersonControls.zoom.
    this.firstPerson.setZoom(zoom);
  }

  /** Where the player stands on the HUD map, while walking. Every frame, since it turns with the mouse: ui/hud/Minimap.tsx draws it without re-rendering. */
  private updateMinimap(): void {
    const map = this.session?.world?.minimap;
    const pose = this.ui.minimap.pose;
    if (!map || this.mode !== "walk") {
      pose.value = null;
      return;
    }
    const { feet, yaw } = this.firstPerson.player.movement;
    const next = minimapPose(map, feet.x, feet.z, yaw);
    const last = pose.value;
    if (last?.u !== next.u || last.v !== next.v || last.rotation !== next.rotation) {
      pose.value = next;
    }
  }

  /**
   * The HUD, every frame. `local` is the offline path and the `Hud` refuses it in
   * a match, which is what keeps health and ammunition the server's answer; the
   * check here only saves building a snapshot nobody would read.
   */
  private updateHud(): void {
    this.hud.setWalking(this.mode === "walk" && this.ui.screen.value === "world");
    if (!this.hud.live) {
      this.hud.local(this.firstPerson.player.snapshot());
    }
    this.updateCone();
  }

  /**
   * How far open the crosshair stands: the cone the next round may leave in,
   * divided by the half-angle the camera is showing, which makes it a fraction of
   * half the screen's height that the widget can draw with no camera of its own.
   *
   * Tangents on both, because that is how an angle becomes a distance on a screen
   * — and it is what the game does with the same two numbers
   * (reverse/iw5-bullet-spread/README.md). The camera's own `fov` rather than the
   * resting one, so a weapon that narrows the view to aim does not also appear to
   * open its cone by the amount it just zoomed in.
   */
  private updateCone(): void {
    const weapon = this.firstPerson.player.weapon;
    const cone = weapon ? shotSpread(weapon.def, weapon.data.spread, weapon.data.ads) : 0;
    const half = Math.tan((this.viewer.camera.fov / 2) * DEG);
    this.ui.hud.cone.value = cone > 0 && half > 0 ? Math.tan(cone * DEG) / half : 0;
    // The same prediction and for the same reason: the crosshair gives way to the
    // weapon's sights as they come up (ui/hud/Reticle.tsx).
    this.ui.hud.ads.value = weapon ? weapon.data.ads : 0;
  }

  private frame(dt: number): void {
    this.animator.update(dt);
    this.fx.update(dt, this.viewer.camera);
    this.firstPerson.update(dt);
    // After the step and before the listener moves: the watcher compares the
    // state it last saw with this one, so a frame that ran several ticks still
    // hears every footfall between them.
    this.footsteps.local(this.firstPerson.player.movement);
    this.weaponAudio.local(this.firstPerson.player);
    this.remotes.update(performance.now());
    this.actors.update(performance.now());
    this.dollhouse.update();
    // Before the viewmodel is posed: a swap that finished this step needs the
    // new weapon's rig attached before anything tries to animate the old one.
    this.session?.followSwap();
    this.updateViewmodel(dt);
    this.updateMinimap();
    this.updateHud();
    this.updateUseFocus();
    // After the controls move, like the shadow fit: the listener is where the
    // player is *now*, and a loop comes into earshot on the frame they reach it.
    this.audio.update(dt, this.viewer.camera);
    // After the controls move, so the shadow fit follows where the player is now.
    if (this.shadowFit.update(this.viewer.camera)) {
      this.viewer.invalidateShadows();
    }
    this.dev.update(dt);
  }
}

/** The controls help, from the bindings table; the four movement keys collapse into one line. */
function controlHints(): ControlHint[] {
  const b = DEFAULT_BINDINGS;
  const movement: Action[] = ["forward", "left", "back", "right"];
  const others = (Object.keys(b) as Action[]).filter((a) => !movement.includes(a));
  return [
    { label: "Move", keys: movement.map((a) => keyLabel(b[a].keys[0]!)).join(""), dev: false },
    { label: "Look", keys: "Mouse", dev: false },
    ...others.map((a) => ({ label: b[a].label, keys: [...new Set(b[a].keys.map(keyLabel))].join(" / "), dev: b[a].dev ?? false })),
  ];
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Let the browser run a frame between synchronous load steps. Not rAF: that never fires in a background tab. */
function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The match as of the newest snapshot, as a script's view is built from it. */
interface Roster {
  players: PlayerView[];
  tick: number;
  values: MatchValues;
}

const EMPTY_ROSTER: Roster = { players: [], tick: 0, values: NO_MATCH_VALUES };
