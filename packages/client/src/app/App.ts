// The application: the composition root. It builds the page's pieces, hands each
// the others it needs, and routes the UI's commands and the player session's
// news to them. It owns nothing else: what a frame does is the update list
// (frame.ts) and the pipeline, what a world is is WorldSession, and every rule
// lives with the piece it is about.

import { parsePose } from "../engine/pose.js";
import { nextQualityLevel } from "../engine/qualityLevel.js";
import { DEFAULT_BINDINGS, keyLabel, type Action } from "../input/bindings.js";
import { gametype } from "@3d/shared/game/gametypes/registry.js";
import { mountUi } from "../ui/index.js";
import { ClassChoice } from "./classChoice.js";
import { GameContent } from "./content.js";
import { CurrentWorld } from "./currentWorld.js";
import { DevTools } from "./dev/devTools.js";
import { FrameUpdates } from "./frame.js";
import { Hud } from "./hud.js";
import { takeInviteCode } from "./invite.js";
import { MatchController } from "./match.js";
import { PauseController } from "./pause.js";
import { Presenters } from "./presenters.js";
import { WeaponPreviews } from "./preview.js";
import { ScreenRouter } from "./screens.js";
import { ClientScripts } from "./scripts.js";
import { PlayerSession } from "./session.js";
import { Settings } from "./settings.js";
import { Systems } from "./systems.js";
import { Toaster } from "./toaster.js";
import { createUiState, type ControlHint, type UiCommands, type UiState } from "./uiBridge.js";
import { UseFocus } from "./useFocus.js";
import { WeaponViewmodel } from "./weaponViewmodel.js";
import { weaponChoices } from "./weaponChoices.js";
import { fetchManifest } from "./worldFetch.js";
import { WorldLoader } from "./worldLoader.js";
import { WorldSession } from "./WorldSession.js";

export class App {
  private readonly ui: UiState = createUiState();
  private readonly systems: Systems;
  private readonly content: GameContent;
  private readonly current = new CurrentWorld();
  private readonly updates = new FrameUpdates();
  private readonly toaster: Toaster;
  private readonly playerSession: PlayerSession;
  private readonly screens: ScreenRouter;
  private readonly pause: PauseController;
  private readonly settings: Settings;
  private readonly weapon: WeaponViewmodel;
  private readonly dev: DevTools;
  private readonly worlds: WorldLoader;
  private readonly match: MatchController;
  /** The class menu's turning weapon. Builds its renderer on first use and drops it when the menu closes. */
  private readonly preview = new WeaponPreviews();
  /** A lobby code from an invite link, waiting for a signed-in player to join it. */
  private pendingJoin: string | undefined;

  constructor(container: HTMLElement) {
    const { ui } = this;
    const systems = (this.systems = new Systems(container));
    const { viewer, input } = systems;
    this.content = new GameContent(ui);
    this.toaster = new Toaster(ui);
    this.playerSession = new PlayerSession(ui, {
      onMatchReady: (ticket, map, id) => {
        // Before the world is built: which `mode:` models and solids exist is the
        // gametype's, and `joined` arrives only once the world is up.
        this.content.gametype = gametype(id) ?? this.content.gametype;
        void this.match.enter(ticket, map);
      },
      onRoundOver: () => this.returnToLobby(),
      // The menu is for a player in no lobby. One who is in one — after a reload,
      // or a Find Game that answered with the lobby they were already in — is
      // shown it, rather than a menu whose buttons the api would refuse.
      onLobby: () => {
        if (this.screens.current === "menu") {
          this.screens.show("lobby");
        }
      },
      // Out of the lobby, so out of its match too. Only then: a world walked
      // offline was never the api's to end.
      onLeft: () => {
        if (this.match.inMatch || this.screens.current === "lobby") {
          this.returnToMenu();
        }
      },
      onDisplaced: () => {
        this.teardownWorld();
        this.screens.show("elsewhere");
      },
      onSignedOut: () => {
        this.teardownWorld();
        this.screens.show("auth");
      },
    });
    this.screens = new ScreenRouter(ui, input, () => this.playerSession.inLobby);
    this.pause = new PauseController(systems, ui, this.screens, this.current, this.toaster);
    this.settings = new Settings(systems, this.current, ui);
    this.weapon = new WeaponViewmodel(viewer, systems.viewmodel, systems.firstPerson, systems.animator, this.content);
    this.dev = new DevTools(
      {
        viewer,
        collision: systems.collision,
        live: systems.world,
        firstPerson: systems.firstPerson,
        ui,
        toaster: this.toaster,
        current: this.current,
        view: this.pause,
      },
      { bodies: systems.remotes, animator: systems.animator, audio: systems.audio, viewmodel: systems.viewmodel, weapon: this.weapon, updates: this.updates },
    );
    this.pause.onModeChange = (mode) => this.dev.onModeChange(mode);
    this.pause.onLeave = () => this.returnToMenu();
    this.worlds = new WorldLoader(
      this.current,
      (slug) => new WorldSession(slug, systems, this.content, this.weapon, this.dev),
      systems,
      ui,
      this.screens,
      this.pause,
      this.toaster,
    );
    const hud = new Hud(ui, () => this.content.weapons);
    const scripts = new ClientScripts(systems.audio);
    const useFocus = new UseFocus(ui, scripts, keyLabel(DEFAULT_BINDINGS.use.keys[0]!));
    this.match = new MatchController(systems, {
      content: this.content,
      current: this.current,
      worlds: this.worlds,
      pause: this.pause,
      screens: this.screens,
      hud,
      classes: new ClassChoice(ui),
      scripts,
      session: this.playerSession,
      toaster: this.toaster,
      dev: this.dev,
      ui,
    });
    this.worlds.onEntered = (reload) => {
      if (reload) {
        this.match.afterReload();
      }
    };
    const presenters = new Presenters(systems, ui, hud, useFocus, this.pause, this.screens, this.current, this.match);
    this.fillUpdates(presenters);

    ui.debug.enabled.value = import.meta.env.DEV;
    ui.controls.value = controlHints();
    mountUi(container, ui, this.commands());
    this.bindActions();
    viewer.onFrame((dt) => this.updates.run(dt));
    import.meta.hot?.on("world-source-changed", (data: { path?: string }) => this.worlds.sourceChanged(data.path));
  }

  start(): void {
    this.settings.restore();
    console.info(`[render] ${this.systems.viewer.profiler.describe()}`);
    // Before anything can join: the join carries this catalogue's hash, and a
    // server holding a different one refuses rather than misnaming weapons.
    void this.content.load().then((weapons) => {
      this.systems.firstPerson.player.setWeapons(weapons);
      this.preview.setWeapons(weapons);
      this.ui.weapons.value = weaponChoices(weapons);
      console.info(`[net] weapon catalogue: ${weapons.size} weapon(s), ${weapons.hash}`);
    });
    // `#slug@x,y,z,yaw,pitch` goes straight into that world at that camera.
    this.worlds.pendingPose = parsePose(location.hash);
    // `?join=CODE` goes straight into that lobby, once there is a player to put there.
    this.pendingJoin = takeInviteCode();
    void this.playerSession.restore().then((signedIn) => {
      if (!signedIn) {
        // The pose is kept: a deep link followed while signed out lands in its
        // world as soon as there is a player to land there.
        this.screens.show("auth");
        return;
      }
      this.afterSignIn();
    });
  }

  /** Every per-frame step, in the slots frame.ts orders them by. */
  private fillUpdates(presenters: Presenters): void {
    const { animator, firstPerson, dollhouse, footsteps, weaponAudio, remotes, actors, fx, audio, shadowFit, viewer } = this.systems;
    const u = this.updates;
    u.use("animation", (dt) => animator.update(dt));
    u.use("controls", (dt) => {
      firstPerson.update(dt);
      dollhouse.update();
    });
    u.use("local sound", () => {
      footsteps.local(firstPerson.player.movement);
      weaponAudio.local(firstPerson.player);
    });
    u.use("others", () => {
      remotes.update(performance.now());
      actors.update(performance.now());
    });
    u.use("viewmodel", (dt) => this.weapon.update(dt, this.pause.mode === "walk"));
    u.use("effects", (dt) => fx.update(dt, viewer.camera));
    u.use("presenters", () => presenters.update());
    u.use("listener", (dt) => audio.update(dt, viewer.camera));
    u.use("shadows", () => {
      if (shadowFit.update(viewer.camera)) {
        viewer.invalidateShadows();
      }
    });
    u.use("dev", (dt) => this.dev.update(dt));
  }

  /** The menu, or straight into the lobby or the world a link named. */
  private afterSignIn(): void {
    const join = this.pendingJoin;
    this.pendingJoin = undefined;
    if (join !== undefined) {
      // The manifest too: the lobby shows its map by name and picture.
      void this.fetchWorlds();
      this.screens.show("lobby");
      this.playerSession.joinLobby(join);
      return;
    }
    const pose = this.worlds.pendingPose;
    // The manifest first even so, for the loading screen's picture and details.
    if (pose) {
      void this.fetchWorlds().then(() => this.worlds.enter(pose.slug));
    } else {
      void this.showMenu();
    }
  }

  private commands(): UiCommands {
    const { playerSession, screens, settings } = this;
    return {
      enterWorld: (slug) => void this.worlds.enter(slug),
      returnToMenu: () => this.returnToMenu(),
      resume: () => this.pause.resume(),
      setQuality: (level) => settings.setQuality(level),
      setSensitivity: (value) => settings.setSensitivity(value, { save: true }),
      setAudioVolume: (channel, value) => settings.setVolume(channel, value),
      setAudioMuted: (muted) => settings.setMuted(muted),

      previewWeapon: (host, weapon, attachments) => void this.preview.show(host, weapon, attachments),
      saveLoadout: (index, loadout) => playerSession.saveLoadout(index, loadout),
      openClasses: () => screens.show("classes"),
      // Back to wherever Create a Class was opened from, which is the lobby for a
      // player in one.
      closeClasses: () => screens.home(),
      chooseClass: (index) => this.match.chooseClass(index),
      openClassChoice: () => {
        this.ui.classChoice.value = "change";
      },
      closeClassChoice: () => {
        if (this.ui.classChoice.value === "change") {
          this.ui.classChoice.value = null;
        }
      },

      signIn: (username, password) => void playerSession.signIn(username, password).then((ok) => ok && this.afterSignIn()),
      register: (username, password) => void playerSession.register(username, password).then((ok) => ok && this.afterSignIn()),
      signOut: () => {
        void playerSession.signOut();
        screens.show("auth");
      },

      findGame: () => {
        screens.show("lobby");
        playerSession.findGame();
      },
      createPrivateLobby: () => {
        screens.show("lobby");
        playerSession.createPrivateLobby();
      },
      setLobbyMap: (map) => playerSession.setLobbyMap(map),
      setLobbyMode: (id) => playerSession.setLobbyMode(id),
      joinLobby: (code) => {
        screens.show("lobby");
        playerSession.joinLobby(code);
      },
      startLobby: () => playerSession.startLobby(),
      endLobby: () => playerSession.endLobby(),
      playHere: () => {
        screens.show("menu");
        playerSession.playHere();
        void this.fetchWorlds();
      },
      leaveLobby: () => {
        playerSession.leave();
        screens.show("menu");
      },
    };
  }

  private bindActions(): void {
    const { input, viewer } = this.systems;
    this.pause.bind();
    input.on("quality", () => this.settings.setQuality(nextQualityLevel(viewer.qualityLevel)));
    if (this.ui.debug.enabled.value) {
      this.dev.bind(input);
    }
  }

  private async showMenu(): Promise<void> {
    this.screens.home();
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

  /** The round is over: everything `returnToMenu` tears down, landing back in the lobby the player came from. */
  private returnToLobby(): void {
    this.teardownWorld();
    this.screens.show("lobby");
  }

  private returnToMenu(): void {
    // Leaving a match is leaving its lobby. Left in it, the api goes on counting
    // this player as in the game: the menu's buttons refuse them, and the round
    // ending pulls them back into a lobby — or a public one's next match — from
    // wherever they have gone since.
    if (this.playerSession.inLobby) {
      this.playerSession.leave();
    }
    this.teardownWorld();
    const memory = this.systems.viewer.renderer.info.memory;
    console.info(`[menu] GPU holds ${memory.geometries} geometries, ${memory.textures} textures`);
    // Drop the fragment, or reloading from the menu goes straight back into the world.
    if (location.hash) {
      history.replaceState(null, "", location.pathname);
    }
    void this.showMenu();
  }

  /** Everything that has to stop when a world goes away, whatever comes next. */
  private teardownWorld(): void {
    this.pause.stop();
    this.systems.viewer.stop();
    this.dev.reset();
    this.match.end();
    this.worlds.leave();
    this.toaster.clear();
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
