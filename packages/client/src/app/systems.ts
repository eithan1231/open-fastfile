// The engine as the page holds it: every system that lives as long as the page
// does, built once, in dependency order, and wired to the renderer. Each field is
// the live object, so whoever is handed this reads today's state, never a copy.

import { CollisionWorld } from "@3d/shared/collision/world.js";
import { Presence } from "@3d/shared/worlds/presence.js";
import { Animator } from "../engine/animator.js";
import { ActorVoices } from "../engine/audio/actors.js";
import { Footsteps } from "../engine/audio/footsteps.js";
import { AudioSystem } from "../engine/audio/system.js";
import { WeaponAudio } from "../engine/audio/weapons.js";
import { FirstPersonControls } from "../engine/controls/firstPerson.js";
import { DollhouseControls } from "../engine/controls/orbit.js";
import { FxSystem } from "../engine/fx/system.js";
import { ShadowFit } from "../engine/shadows.js";
import { Viewer } from "../engine/viewer.js";
import { Viewmodel } from "../engine/viewmodel.js";
import { InputManager } from "../input/InputManager.js";
import { ActorsView } from "../net/actors.js";
import { Corpses } from "../net/corpses.js";
import { RemotePlayers } from "../net/remotePlayers.js";

export class Systems {
  readonly viewer: Viewer;
  readonly input: InputManager;
  readonly collision = new CollisionWorld();
  /**
   * What this client collides with: the collision as the match has it, whose
   * presence each mount replaces and each snapshot updates. Everything that
   * steps or traces a player reads this rather than `collision`.
   */
  readonly world = this.collision.view(new Presence(0));
  readonly animator = new Animator();
  readonly fx = new FxSystem();
  /** What the world sounds like. Built and running from boot, against a context the browser has not started yet. */
  readonly audio = new AudioSystem();
  /**
   * Footsteps and landings, worked out from movement rather than sent: it reads
   * the collision for what is under a foot, and a peer's steps come off the
   * snapshot rather than off a frame.
   */
  readonly footsteps = new Footsteps(this.audio, this.world);
  /**
   * Firing, reloading and a round arriving, worked out from weapon state rather
   * than sent. It traces the round this client has just predicted, and a peer's
   * rounds come off the snapshot.
   */
  readonly weaponAudio = new WeaponAudio(this.audio, this.world);
  /** What the actors sound like — a voice, a swing, a death — worked out from their snapshots. */
  readonly actorVoices = new ActorVoices(this.audio);
  readonly viewmodel = new Viewmodel();
  readonly firstPerson: FirstPersonControls;
  readonly dollhouse: DollhouseControls;
  readonly shadowFit = new ShadowFit();
  /** The other players. Absent a match, empty, and everything else plays offline. */
  readonly remotes = new RemotePlayers();
  readonly corpses = new Corpses();
  /** The creatures the game server runs. Drawn like peers, beside the scene. */
  readonly actors = new ActorsView();

  constructor(container: HTMLElement) {
    this.viewer = new Viewer(container);
    const canvas = this.viewer.renderer.domElement;
    this.input = new InputManager(canvas);
    this.firstPerson = new FirstPersonControls(this.viewer.camera, this.input, this.world);
    this.dollhouse = new DollhouseControls(this.viewer.camera, canvas);
    // The listener rides the camera, which is outside the scene and so outside
    // the frozen-matrix rules that apply to everything in it.
    this.audio.attachTo(this.viewer.camera);
    // Beside the world rather than inside it, because the world root's matrices are frozen.
    this.viewer.roots.keep(this.remotes.root, this.audio.root, this.corpses.root, this.actors.root);
    this.viewer.pipeline.use("effects", this.fx.pass);
    this.viewer.pipeline.use("viewmodel", this.viewmodel.pass);
  }
}
