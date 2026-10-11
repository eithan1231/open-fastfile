// What a world sounds like: the alias table, what one alias comes to, and what
// the engine does with it.
//
// Everything here fails as *silence* rather than as an error, which is why there
// is so much of it. A bed pinned to the origin, a loop never started because the
// hard cap was read as the end of a curve, nineteen copies of one clip started in
// phase — none of those throw, and none of them look wrong in a screenshot.
//
// There is no `AudioContext` in Node and no audio device in CI, so the Web Audio
// half is driven against the fake below. It implements only what three.js
// touches, which is the point: what is asserted is the graph this engine builds
// and the numbers it puts into it.

import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { ambienceEntries, ambienceClipUrls, entryAudible, type SoundPlacement } from "../src/engine/audio/ambience.js";
import {
  aliasNamed,
  pickClip,
  readSoundLibrary,
  resolveAlias,
  sampleRange,
  type SoundAlias,
  type SoundBank,
  type SoundLibrary,
} from "../src/engine/audio/library.js";
import { Mixer, defaultAudioSettings } from "../src/engine/audio/mixer.js";
import { distanceFrom, voiceRequests, withinRange, type VoiceRequest } from "../src/engine/audio/requests.js";
import { VoicePool, linearAttenuation } from "../src/engine/audio/voices.js";
import { AudioSystem } from "../src/engine/audio/system.js";
import { Footsteps } from "../src/engine/audio/footsteps.js";
import { ActorVoices } from "../src/engine/audio/actors.js";
import type { ActorState } from "@3d/shared/game/actors/actor.js";
import { actorKindIndex } from "@3d/shared/game/actors/kinds.js";
import { WeaponAudio, type SoundingPeer, type SoundingShooter, type WeaponSource } from "../src/engine/audio/weapons.js";
import type { WeaponData } from "@3d/shared/sim/weapon.js";
import type { WeaponClipInfo, WeaponDef } from "@3d/shared/sim/weaponDef.js";
import { footfallPhase } from "@3d/shared/sim/footsteps.js";
import { createMovement, WALK_SPEED, type CapsuleWorld, type MovementState } from "@3d/shared/sim/movement.js";
import { DEFAULT_SURFACE, type SurfaceType } from "@3d/shared/sim/surfaces.js";
import { ClientScripts, type ScriptSurroundings } from "../src/app/scripts.js";
import type { GameView } from "@3d/shared/game/context.js";
import type { Script } from "@3d/shared/game/hooks.js";
import type { AnnounceEvent } from "@3d/shared/net/messages/events.js";

// ---------------------------------------------------------------------------
// A Web Audio graph that records rather than sounds.

class FakeParam {
  value = 0;
  cancelScheduledValues(): void {}
  // The real ones ramp; the fake lands at once so an assertion can read a number.
  linearRampToValueAtTime(value: number): void {
    this.value = value;
  }
  setTargetAtTime(value: number): void {
    this.value = value;
  }
  setValueAtTime(value: number): void {
    this.value = value;
  }
}

class FakeNode {
  readonly outputs: FakeNode[] = [];
  connect(node: FakeNode): FakeNode {
    this.outputs.push(node);
    return node;
  }
  disconnect(node?: FakeNode): void {
    const keep = node ? this.outputs.filter((o) => o !== node) : [];
    this.outputs.length = 0;
    this.outputs.push(...keep);
  }
}

class FakeGain extends FakeNode {
  gain = new FakeParam();
}

class FakePanner extends FakeNode {
  panningModel = "equalpower";
  distanceModel = "inverse";
  refDistance = 1;
  maxDistance = 10000;
  rolloffFactor = 1;
  positionX = new FakeParam();
  positionY = new FakeParam();
  positionZ = new FakeParam();
  orientationX = new FakeParam();
  orientationY = new FakeParam();
  orientationZ = new FakeParam();
}

class FakeSource extends FakeNode {
  buffer: AudioBuffer | null = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  onended: (() => void) | null = null;
  playbackRate = new FakeParam();
  detune = new FakeParam();
  /** `[when, offset, duration]`, which is the whole of what a phase offset is. */
  started: [number, number, number | undefined] | undefined;
  start(when: number, offset: number, duration?: number): void {
    this.started = [when, offset, duration];
  }
  stop(): void {}
}

class FakeListener {
  positionX = new FakeParam();
  positionY = new FakeParam();
  positionZ = new FakeParam();
  forwardX = new FakeParam();
  forwardY = new FakeParam();
  forwardZ = new FakeParam();
  upX = new FakeParam();
  upY = new FakeParam();
  upZ = new FakeParam();
}

class FakeContext {
  currentTime = 0;
  state: AudioContextState = "suspended";
  destination = new FakeNode();
  listener = new FakeListener();
  createGain(): FakeGain {
    return new FakeGain();
  }
  createPanner(): FakePanner {
    return new FakePanner();
  }
  createBufferSource(): FakeSource {
    return new FakeSource();
  }
  resume(): Promise<void> {
    this.state = "running";
    return Promise.resolve();
  }
}

/** A buffer is only ever read for its `duration` here. */
function fakeBuffer(duration = 4): AudioBuffer {
  return { duration, length: duration * 48000, numberOfChannels: 1, sampleRate: 48000 } as AudioBuffer;
}

let context: FakeContext;

beforeAll(() => {
  context = new FakeContext();
  // three takes its context from here, and so does the decoder: one context, one
  // clock, one listener. Setting it before anything constructs a listener is the
  // whole of what a test has to arrange.
  THREE.AudioContext.setContext(context as unknown as AudioContext);
});

function poolOf(cap = 48): { pool: VoicePool; mixer: Mixer; listener: THREE.AudioListener; root: THREE.Group } {
  const listener = new THREE.AudioListener();
  const root = new THREE.Group();
  root.matrixAutoUpdate = false;
  root.updateMatrixWorld(true);
  const mixer = new Mixer(context as unknown as BaseAudioContext, listener.gain, defaultAudioSettings());
  return { pool: new VoicePool(listener, root, mixer, cap), mixer, listener, root };
}

const ORIGIN = { x: 0, y: 0, z: 0 };

function request(over: Partial<VoiceRequest> = {}): VoiceRequest {
  return {
    alias: "a",
    url: "/worlds/w/assets/sounds/clips/a.webm",
    volume: 1,
    rate: 1,
    range: [1, 10],
    loop: false,
    channel: "sfx",
    delay: 0,
    phase: 0,
    ...over,
  };
}

function alias(over: Partial<SoundAlias> = {}): SoundAlias {
  return {
    clips: [{ file: "one", weight: 1 }],
    volume: [1, 1],
    pitch: [1, 1],
    range: [1, 10],
    loop: false,
    spatial: true,
    delay: 0,
    flags: 0,
    ...over,
  };
}

function libraryOf(aliases: Record<string, SoundAlias>): SoundLibrary {
  return { game: "iw5", aliases };
}

/** One bank, with the URL prefix a test can read the resolution off. */
function bankOf(aliases: Record<string, SoundAlias>, prefix = "/worlds/w/"): SoundBank[] {
  return [{ library: libraryOf(aliases), clipUrl: (file) => `${prefix}${file}.webm` }];
}

/** A fixed stream, so a test can say exactly which random each field drew. */
function stream(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length]!;
}

// ---------------------------------------------------------------------------

// An imported map's assets are gitignored, so a checkout without them skips this.
const DOME_SOUNDS = path.resolve(import.meta.dirname, "../../../worlds/dome-mw3/assets/sounds/sounds.json");

describe.skipIf(!fs.existsSync(DOME_SOUNDS))("the alias table", () => {
  // Read in beforeAll: a skipped describe's body is still collected.
  let library: SoundLibrary;
  beforeAll(() => {
    library = readSoundLibrary(JSON.parse(fs.readFileSync(DOME_SOUNDS, "utf8")), "sounds.json");
  });

  it("reads dome's own table", () => {
    expect(library.game).toBe("iw5");
    expect(Object.keys(library.aliases)).toHaveLength(23);
    const fence = aliasNamed(library, "emt_mtl_chainlink_rattle_ext");
    expect(fence).toBeDefined();
    // Four clips over two files: the duplicates *are* the weighting, and dropping
    // them to a set would silently halve the variety the game asked for.
    expect(fence!.clips).toHaveLength(4);
    expect(new Set(fence!.clips.map((c) => c.file)).size).toBe(2);
    expect(fence!.loop).toBe(true);
    expect(fence!.spatial).toBe(true);
    // Metres, already: the exporter divides the game's inches by 39.37.
    expect(fence!.range[1]).toBeGreaterThan(5);
    expect(fence!.range[1]).toBeLessThan(30);
    expect(fence!.range[0]).toBeLessThan(fence!.range[1]);
  });

  it("every alias dome's sound.world names is in it", () => {
    const world = fs.readFileSync(path.resolve(import.meta.dirname, "../../../worlds/dome-mw3/sound.world"), "utf8");
    const named = [...world.matchAll(/alias:\s*([A-Za-z_][A-Za-z0-9_-]*)/g)].map((m) => m[1]!);
    expect(named.length).toBe(77);
    expect(named.filter((name) => aliasNamed(library, name) === undefined)).toEqual([]);
  });

  it("matches a name case-insensitively, because the game's own data does not agree with itself", () => {
    expect(aliasNamed(library, "EMT_PUMPJACK_MOTOR")).toBe(aliasNamed(library, "emt_pumpjack_motor"));
  });

  it("refuses a version it does not know rather than reading zeroes", () => {
    expect(() => readSoundLibrary({ _version: 99, aliases: {} }, "x.json")).toThrow(/version 99/);
    expect(() => readSoundLibrary({}, "x.json")).toThrow();
  });
});

describe("the clip picker", () => {
  it("normalises across an alias' own clips, whatever they sum to", () => {
    const clips = [
      { file: "a", weight: 3 },
      { file: "b", weight: 1 },
    ];
    // Three quarters of the range is "a" — a table summing to 4 picks like one summing to 1.
    expect(pickClip(clips, 0)!.file).toBe("a");
    expect(pickClip(clips, 0.74)!.file).toBe("a");
    expect(pickClip(clips, 0.76)!.file).toBe("b");
    expect(pickClip(clips, 0.999)!.file).toBe("b");
  });

  it("counts a duplicate twice, which is how the dump spells 'twice as often'", () => {
    const clips = [
      { file: "a", weight: 1 },
      { file: "b", weight: 1 },
      { file: "a", weight: 1 },
      { file: "b", weight: 1 },
    ];
    const hits = { a: 0, b: 0 };
    for (let i = 0; i < 1000; i++) {
      hits[pickClip(clips, i / 1000)!.file as "a" | "b"]++;
    }
    expect(hits.a).toBe(500);
    expect(hits.b).toBe(500);
  });

  it("still picks when every weight is zero", () => {
    const clips = [
      { file: "a", weight: 0 },
      { file: "b", weight: 0 },
    ];
    expect(pickClip(clips, 0)!.file).toBe("a");
    expect(pickClip(clips, 0.9)!.file).toBe("b");
    expect(pickClip([], 0.5)).toBeUndefined();
  });

  it("samples a range end to end", () => {
    expect(sampleRange([0.85, 1], 0)).toBeCloseTo(0.85);
    expect(sampleRange([0.85, 1], 1)).toBeCloseTo(1);
    expect(sampleRange([0.85, 1], 0.5)).toBeCloseTo(0.925);
  });
});

describe("one alias becomes voices", () => {
  it("plays its `with` layer alongside it, one level deep", () => {
    const banks = bankOf({
      land_plr_dirt: alias({ with: "gear_rattle_plr_land", range: [2, 25] }),
      // The layer names a layer of its own, which must not be followed.
      gear_rattle_plr_land: alias({ range: [1, 4], with: "land_plr_dirt" }),
    });
    const out = voiceRequests({ alias: "land_plr_dirt", position: { x: 0, y: 0, z: 0 } }, banks, stream([0.5]));
    expect(out.map((r) => r.alias)).toEqual(["land_plr_dirt", "gear_rattle_plr_land"]);
    // The layer plays where the primary does, and keeps its own reach: a distant
    // report carries much further than the shot that pulled it.
    expect(out[1]!.position).toEqual({ x: 0, y: 0, z: 0 });
    expect(out[1]!.range).toEqual([1, 4]);
  });

  it("carries the placement's volume into the layer but not the placement's range", () => {
    const banks = bankOf({ a: alias({ with: "b" }), b: alias({ range: [1, 4] }) });
    const out = voiceRequests({ alias: "a", volume: 0.5, range: [2, 40], position: ORIGIN }, banks, stream([0.5]));
    expect(out[0]!.range).toEqual([2, 40]);
    expect(out[1]!.range).toEqual([1, 4]);
    expect(out[1]!.volume).toBeCloseTo(0.5);
  });

  it("says nothing at all for an alias the table does not hold", () => {
    expect(voiceRequests({ alias: "nope" }, [], stream([0.5]))).toEqual([]);
  });

  it("a placement with no position is the world's bed: flat, and not at the origin", () => {
    const banks = bankOf({ bed: alias({ spatial: true, loop: true }) });
    const [bed] = voiceRequests({ alias: "bed" }, banks, stream([0.5]));
    // Undefined, not {0,0,0}: a bed given the origin plays from one corner of the
    // map, and nothing downstream could tell the difference.
    expect(bed!.position).toBeUndefined();
    expect(distanceFrom(bed!, { x: 500, y: 0, z: 0 })).toBeUndefined();
    // And it is audible from anywhere, because it has nowhere to be far from.
    expect(withinRange(bed!, { x: 5000, y: 0, z: 0 })).toBe(true);
  });

  it("a sound at the listener is flat whatever the alias says", () => {
    // step_run_plr_dirt is the trap in miniature: the canonical first footstep,
    // the one dome's own zone carries, and one of the seven `_plr` entries with an
    // ordinary short distance. `atListener` is what makes that stop mattering.
    const banks = bankOf({ step_run_plr_dirt: alias({ spatial: true, range: [2, 25] }) });
    const [own] = voiceRequests({ alias: "step_run_plr_dirt", position: { x: 1, y: 2, z: 3 }, atListener: true }, banks, stream([0.5]));
    expect(own!.position).toBeUndefined();
    const [theirs] = voiceRequests({ alias: "step_run_plr_dirt", position: { x: 1, y: 2, z: 3 } }, banks, stream([0.5]));
    expect(theirs!.position).toEqual({ x: 1, y: 2, z: 3 });
  });

  it("an alias the exporter marked non-spatial keeps no panner even when it is placed", () => {
    const banks = bankOf({ bed: alias({ spatial: false }) });
    const [voice] = voiceRequests({ alias: "bed", position: { x: 9, y: 0, z: 0 } }, banks, stream([0.5]));
    expect(voice!.position).toBeUndefined();
  });

  it("takes the game's mixer group where it named one, and the caller's where it did not", () => {
    const banks = bankOf({ a: alias({ channel: "ambience" }), b: alias({ channel: "weapons" }), c: alias() });
    const channel = (name: string, fallback?: "footsteps"): string => voiceRequests({ alias: name, channel: fallback }, banks, stream([0.5]))[0]!.channel;
    expect(channel("a")).toBe("ambience");
    expect(channel("b")).toBe("sfx");
    // Nothing said: a footstep is a footstep because the footstep code played it.
    expect(channel("c", "footsteps")).toBe("footsteps");
    expect(channel("c")).toBe("sfx");
    // The game's own word wins over the caller's guess, which is the whole point
    // of the exporter carrying it.
    expect(channel("a", "footsteps")).toBe("ambience");
  });
});

describe("a world's table and the catalogue's", () => {
  /** Two banks in precedence order, spelling their clips apart so a test can read which won. */
  function twoBanks(world: Record<string, SoundAlias>, catalogue: Record<string, SoundAlias>): SoundBank[] {
    return [...bankOf(world, "/worlds/dome-mw3/assets/sounds/clips/"), ...bankOf(catalogue, "/api/catalog/sounds/iw5/mp/clips/")];
  }

  it("resolves a catalogue-only alias against the catalogue, clips and all", () => {
    const banks = twoBanks({}, { step_run_plr_dirt: alias({ clips: [{ file: "footsteps/foot_dirt01", weight: 1 }] }) });
    const [step] = voiceRequests({ alias: "step_run_plr_dirt", atListener: true }, banks, stream([0.5]));
    expect(step!.url).toBe("/api/catalog/sounds/iw5/mp/clips/footsteps/foot_dirt01.webm");
  });

  it("gives the world's own table the name when both hold it", () => {
    // The losing case, and the reason for the order: ten aliases a map zone
    // defines are genuinely different recordings from one map to the next, so a
    // world that ships one has to keep its own rather than the catalogue's.
    const banks = twoBanks(
      { emt_mtl_chainlink_rattle_ext: alias({ clips: [{ file: "ambient/dome_rattle", weight: 1 }], range: [1, 19] }) },
      { emt_mtl_chainlink_rattle_ext: alias({ clips: [{ file: "ambient/paris_rattle", weight: 1 }], range: [1, 4] }) },
    );
    const found = resolveAlias(banks, "emt_mtl_chainlink_rattle_ext")!;
    expect(found.alias.range).toEqual([1, 19]);
    const [voice] = voiceRequests({ alias: "emt_mtl_chainlink_rattle_ext", position: ORIGIN }, banks, stream([0.5]));
    expect(voice!.url).toBe("/worlds/dome-mw3/assets/sounds/clips/ambient/dome_rattle.webm");
  });

  it("layers an alias from the other table, and fetches that table's clip", () => {
    // A landing pulls the gear on the player's back: the landing is the world's
    // (or the catalogue's) and the rattle is the catalogue's, and the closure the
    // exporter ran covers one table at a time.
    const banks = twoBanks(
      { land_plr_dirt: alias({ with: "gear_rattle_plr_land", clips: [{ file: "footsteps/land_dirt", weight: 1 }] }) },
      { gear_rattle_plr_land: alias({ clips: [{ file: "foley/foly_gear_land1", weight: 1 }] }) },
    );
    const out = voiceRequests({ alias: "land_plr_dirt", position: ORIGIN }, banks, stream([0.5]));
    expect(out.map((r) => r.url)).toEqual([
      "/worlds/dome-mw3/assets/sounds/clips/footsteps/land_dirt.webm",
      "/api/catalog/sounds/iw5/mp/clips/foley/foly_gear_land1.webm",
    ]);
  });

  it("says nothing for a name neither table holds, and nothing at all for no tables", () => {
    expect(resolveAlias(twoBanks({}, {}), "nope")).toBeUndefined();
    expect(voiceRequests({ alias: "nope" }, [], stream([0.5]))).toEqual([]);
  });
});

describe("the catalogue's own bank", () => {
  const file = path.resolve(import.meta.dirname, "../../../worlds/catalog/sounds/iw5/mp/sounds.json");
  // Gitignored and built, like every other catalogue entry, so a checkout that
  // has not run `python3 -m scripts.cod catalog` skips this rather than failing.
  const built = fs.existsSync(file);

  it.runIf(built)("holds the sixteen player footsteps and landings no companion zone has", () => {
    const library = readSoundLibrary(JSON.parse(fs.readFileSync(file, "utf8")), "catalog sounds.json");
    // The union with one map zone, which is the documented exception
    // (docs/engine/audio.md#where-sound-lives). step_run_plr_dirt is the worked
    // example throughout that page and is one of the sixteen.
    for (const name of ["step_run_plr_dirt", "step_sprint_plr_metal", "land_plr_snow", "land_metal"]) {
      expect(aliasNamed(library, name)?.clips.length).toBeGreaterThan(0);
    }
    // And the rest of what steps 8 and 9 will reach for.
    expect(aliasNamed(library, "step_walk_concrete")).toBeDefined();
    expect(aliasNamed(library, "gear_rattle_plr_land")).toBeDefined();
    expect(aliasNamed(library, "weap_m4carbine_fire_plr")).toBeDefined();
  });

  it.runIf(built)("keeps the game's own silence rather than dropping it", () => {
    // `null.wav` is half a second at -91 dB, and 1,532 aliases name it — it is
    // how IW5 spells "this variant plays nothing". Dropped as a missing clip, a
    // one-in-four chance of no breath would become a certainty of one.
    const library = readSoundLibrary(JSON.parse(fs.readFileSync(file, "utf8")), "catalog sounds.json");
    expect(aliasNamed(library, "step_scrape_plr_metal")!.clips.map((c) => c.file)).toEqual(["null"]);
    expect(aliasNamed(library, "gear_rattle_plr_run_breath")!.clips.filter((c) => c.file === "null")).toHaveLength(1);
  });
});

describe("a weapon carried onto another game's map", () => {
  // A world brings its own game's bank; a weapon from another game is heard from
  // that game's, fetched the first time the weapon is seen, and looked in first.
  const shot = (file: string) => alias({ clips: [{ file, weight: 1 }], range: [12700, 63500], spatial: false });
  const t5 = bankOf({ weap_m4carbine_fire_plr: shot("t5_m4"), step_run_dirt: shot("t5_step") }, "/catalog/sounds/t5/");
  const iw5 = bankOf({ weap_m4carbine_fire_plr: shot("iw5_m4"), weap_scar_fire_plr: shot("iw5_scar") }, "/catalog/sounds/iw5/")[0]!;
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  function setup(): { audio: AudioSystem; asked: string[] } {
    const asked: string[] = [];
    const audio = new AudioSystem();
    audio.attach({
      banks: t5,
      placements: [],
      clips: { audio: async () => fakeBuffer(0.4) },
      game: "t5",
      bankFor: async (game) => {
        asked.push(game);
        return game === "iw5" ? iw5 : undefined;
      },
    });
    const camera = new THREE.PerspectiveCamera();
    audio.attachTo(camera);
    audio.update(0.016, camera);
    return { audio, asked };
  }

  it("fetches the weapon's own game's bank once, and hears its sounds from it", async () => {
    const { audio, asked } = setup();
    expect(audio.knows("weap_scar_fire_plr")).toBe(false);
    audio.prepare("iw5");
    audio.prepare("iw5");
    await settle();
    expect(asked).toEqual(["iw5"]);
    expect(audio.knows("weap_scar_fire_plr", "iw5")).toBe(true);
    // The world's own sounds still come from its own bank, whatever the weapon.
    expect(audio.knows("step_run_dirt", "iw5")).toBe(true);
    expect(audio.knows("weap_scar_fire_plr")).toBe(false);

    audio.playAtListener("weap_scar_fire_plr", { game: "iw5" });
    await settle();
    expect(audio.voices.map((v) => v.request.url)).toEqual(["/catalog/sounds/iw5/iw5_scar.webm"]);
  });

  it("takes the weapon's own recording of a name both games have", async () => {
    const { audio } = setup();
    audio.prepare("iw5");
    await settle();
    audio.playAtListener("weap_m4carbine_fire_plr", { game: "iw5" });
    audio.playAtListener("weap_m4carbine_fire_plr");
    await settle();
    expect(audio.voices.map((v) => v.request.url).sort()).toEqual(["/catalog/sounds/iw5/iw5_m4.webm", "/catalog/sounds/t5/t5_m4.webm"]);
  });

  it("never fetches the world's own game again, and asks once for a game that has none", async () => {
    const { audio, asked } = setup();
    audio.prepare("t5");
    audio.prepare("s1");
    await settle();
    audio.prepare("s1");
    expect(asked).toEqual(["s1"]);
    expect(audio.knows("weap_m4carbine_fire_plr", "s1")).toBe(true); // the world's bank still answers
  });
});

describe("the hard distance cap", () => {
  it("is a cap and not the end of a curve", () => {
    const far = request({ position: { x: 0, y: 0, z: 30 }, range: [4, 22] });
    expect(withinRange(far, ORIGIN)).toBe(false);
    expect(withinRange(request({ position: { x: 0, y: 0, z: 21 }, range: [4, 22] }), ORIGIN)).toBe(true);
    // Linear, so it actually reaches zero. `inverse` never does, which is why it
    // is not used: a footstep heard faintly from 200 m is a bug that sounds like
    // a setting.
    expect(linearAttenuation(4, [4, 22])).toBe(1);
    expect(linearAttenuation(22, [4, 22])).toBe(0);
    expect(linearAttenuation(200, [4, 22])).toBe(0);
    expect(linearAttenuation(13, [4, 22])).toBeCloseTo(0.5);
  });

  it("a loop keeps a little slack once it is playing, so the boundary does not chatter", () => {
    const loop = request({ position: { x: 0, y: 0, z: 22.5 }, range: [4, 22], loop: true });
    expect(withinRange(loop, ORIGIN)).toBe(false);
    expect(withinRange(loop, ORIGIN, 1.08)).toBe(true);
  });
});

describe("the voice pool", () => {
  it("routes a voice through its channel rather than straight at the listener", () => {
    const { pool, mixer, listener } = poolOf();
    const voice = pool.start(request({ channel: "ambience" }), fakeBuffer(), ORIGIN)!;
    const gain = voice.audio.gain as unknown as FakeGain;
    // voice gain -> ambience -> master. Turning ambience down turns down what is
    // already playing, which is the whole reason for the channels.
    expect(gain.outputs).toEqual([mixer.input("ambience")]);
    expect((mixer.input("ambience") as unknown as FakeNode).outputs).toEqual([listener.gain as unknown as FakeNode]);
  });

  it("gives a positional voice a linear panner at the placement, from the first sample", () => {
    const { pool } = poolOf();
    const voice = pool.start(request({ position: { x: 3, y: -2, z: 8 }, range: [1.5, 19] }), fakeBuffer(), ORIGIN)!;
    const audio = voice.audio as THREE.PositionalAudio;
    const panner = audio.panner as unknown as FakePanner;
    expect(panner.distanceModel).toBe("linear");
    expect(panner.refDistance).toBeCloseTo(1.5);
    expect(panner.maxDistance).toBeCloseTo(19);
    // `PositionalAudio.updateMatrixWorld` writes nothing while a voice is stopped,
    // so a voice positioned before `play` plays at the origin for ever. This is
    // the assertion that catches that, and it is the whole reason the root lives
    // beside the scene instead of in it.
    expect([panner.positionX.value, panner.positionY.value, panner.positionZ.value]).toEqual([3, -2, 8]);
  });

  it("a flat voice has no panner at all", () => {
    const { pool } = poolOf();
    const voice = pool.start(request({ position: undefined }), fakeBuffer(), ORIGIN)!;
    expect(voice.audio).not.toBeInstanceOf(THREE.PositionalAudio);
  });

  it("starts a loop part-way in, and a one-shot at its beginning", () => {
    const { pool } = poolOf();
    const loop = pool.start(request({ loop: true, phase: 0.25 }), fakeBuffer(8), ORIGIN)!;
    expect((loop.audio.source as unknown as FakeSource).started![1]).toBeCloseTo(2);
    const shot = pool.start(request({ loop: false, phase: 0.25 }), fakeBuffer(8), ORIGIN)!;
    expect((shot.audio.source as unknown as FakeSource).started![1]).toBe(0);
  });

  it("steals the quietest voice at the listener when it is full, and only for something louder", () => {
    const { pool } = poolOf(2);
    const near = pool.start(request({ position: { x: 0, y: 0, z: 1 }, range: [1, 20] }), fakeBuffer(), ORIGIN)!;
    const far = pool.start(request({ position: { x: 0, y: 0, z: 19 }, range: [1, 20] }), fakeBuffer(), ORIGIN)!;
    expect(pool.count).toBe(2);
    // Quieter than everything playing: refused rather than taking someone's place.
    expect(pool.start(request({ volume: 0.01, position: { x: 0, y: 0, z: 19.5 }, range: [1, 20] }), fakeBuffer(), ORIGIN)).toBeUndefined();
    expect(pool.count).toBe(2);
    // Louder: the far one goes, not the near one.
    const loud = pool.start(request({ position: { x: 0, y: 0, z: 2 }, range: [1, 20] }), fakeBuffer(), ORIGIN);
    expect(loud).toBeDefined();
    expect(pool.playing).toContain(near);
    expect(pool.playing).not.toContain(far);
  });

  it("drops a loop that has gone out of earshot, and lets go of its buffer", () => {
    const { pool } = poolOf();
    const voice = pool.start(request({ loop: true, position: { x: 0, y: 0, z: 10 }, range: [1, 12] }), fakeBuffer(), ORIGIN)!;
    pool.reap(ORIGIN);
    expect(pool.count).toBe(1);
    pool.reap({ x: 0, y: 0, z: 40 });
    expect(pool.count).toBe(0);
    // The AssetStore owns the buffer; a retired voice must not be the last thing
    // holding one after its world is gone.
    expect(voice.audio.buffer).toBeNull();
  });
});

describe("a world's ambience", () => {
  const placement = (id: number, over: Partial<SoundPlacement> = {}): SoundPlacement => ({
    id,
    alias: "fence",
    position: { x: 0, y: 0, z: 0 },
    volume: 1,
    delay: 0,
    ...over,
  });
  const banks = bankOf({
    fence: alias({
      loop: true,
      clips: [
        { file: "a", weight: 1 },
        { file: "b", weight: 1 },
      ],
      range: [0.6, 12],
    }),
  });

  it("gives nineteen copies of one loop nineteen different phases", () => {
    // Dome has exactly this: nineteen chainlink emitters within earshot of each
    // other. Started together they are a comb filter, not ambience.
    const entries = ambienceEntries(
      Array.from({ length: 19 }, (_, i) => placement(i + 1)),
      banks,
    );
    const phases = entries.map((e) => e.requests[0]!.phase);
    expect(new Set(phases).size).toBe(19);
    expect(Math.min(...phases)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...phases)).toBeLessThan(1);
  });

  it("is the same every load, because the seed is the placement and not the clock", () => {
    const once = ambienceEntries([placement(7)], banks)[0]!.requests[0]!;
    const again = ambienceEntries([placement(7)], banks)[0]!.requests[0]!;
    expect(again).toEqual(once);
  });

  it("names every clip it can ever ask for, so a load fetches them once", () => {
    const entries = ambienceEntries(
      Array.from({ length: 19 }, (_, i) => placement(i + 1)),
      banks,
    );
    expect(ambienceClipUrls(entries).sort()).toEqual(["/worlds/w/a.webm", "/worlds/w/b.webm"]);
  });

  it("a placement with no position is audible everywhere", () => {
    const bed = ambienceEntries([placement(1, { position: undefined })], banks)[0]!;
    expect(bed.requests[0]!.position).toBeUndefined();
    expect(entryAudible(bed, { x: 900, y: 0, z: 900 })).toBe(true);
  });

  it("a placed loop is audible only inside its own range", () => {
    const fence = ambienceEntries([placement(1, { position: { x: 0, y: 0, z: 30 } })], banks)[0]!;
    expect(entryAudible(fence, { x: 0, y: 0, z: 25 })).toBe(true);
    expect(entryAudible(fence, ORIGIN)).toBe(false);
  });

  it("an alias the table does not hold plays nothing and is never asked for again", () => {
    const missing = ambienceEntries([placement(1, { alias: "gone" })], banks)[0]!;
    expect(missing.requests).toEqual([]);
    expect(entryAudible(missing, ORIGIN)).toBe(false);
  });
});

describe("the mixer", () => {
  it("applies the master and each channel, and mutes by taking the master to zero", () => {
    const listener = new THREE.AudioListener();
    const mixer = new Mixer(context as unknown as BaseAudioContext, listener.gain, defaultAudioSettings());
    mixer.setVolume("master", 0.5);
    mixer.setVolume("footsteps", 0.25);
    expect((listener.gain as unknown as FakeGain).gain.value).toBeCloseTo(0.5);
    expect((mixer.input("footsteps") as unknown as FakeGain).gain.value).toBeCloseTo(0.25);
    expect(mixer.gainOf("footsteps")).toBeCloseTo(0.125);
    mixer.setMuted(true);
    expect((listener.gain as unknown as FakeGain).gain.value).toBe(0);
    expect(mixer.gainOf("footsteps")).toBe(0);
  });

  it("clamps what it is given and survives a storage that throws", () => {
    // There is no `localStorage` in Node at all, which is the same shape of
    // failure a private window gives: every read and write is wrapped.
    const listener = new THREE.AudioListener();
    const mixer = new Mixer(context as unknown as BaseAudioContext, listener.gain, defaultAudioSettings());
    mixer.setVolume("master", 4);
    mixer.setVolume("ui", -1);
    expect(mixer.settings.master).toBe(1);
    expect(mixer.settings.channels.ui).toBe(0);
  });
});

describe("the system", () => {
  const banks = bankOf({
    fence: alias({ loop: true, range: [0.6, 12] }),
    shout: alias({ spatial: true, range: [2, 25] }),
  });

  function systemWith(placements: SoundPlacement[]): { audio: AudioSystem; camera: THREE.PerspectiveCamera; asked: string[] } {
    const asked: string[] = [];
    const audio = new AudioSystem();
    audio.attach({
      banks,
      placements,
      clips: {
        audio: async (url) => {
          asked.push(url);
          return fakeBuffer();
        },
      },
    });
    const camera = new THREE.PerspectiveCamera();
    audio.attachTo(camera);
    return { audio, camera, asked };
  }

  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it("never fetches a clip for a placement past its own max distance", async () => {
    const { audio, camera, asked } = systemWith([{ id: 1, alias: "fence", position: { x: 0, y: 0, z: 40 }, volume: 1, delay: 0 }]);
    camera.position.set(0, 0, 0);
    audio.update(0.016, camera);
    await settle();
    // No voice, no panner and no round trip: a sound across the map is not a
    // quiet sound.
    expect(asked).toEqual([]);
    expect(audio.voiceCount).toBe(0);

    // Walk up to it and it starts, which is the same rule and not a second one.
    camera.position.set(0, 0, 35);
    audio.update(0.016, camera);
    await settle();
    expect(asked).toEqual(["/worlds/w/one.webm"]);
    expect(audio.voiceCount).toBe(1);

    // Walk away and it stops again.
    camera.position.set(0, 0, 0);
    audio.update(0.016, camera);
    expect(audio.voiceCount).toBe(0);
  });

  it("puts the listener where the camera is, every frame", () => {
    const { audio, camera } = systemWith([]);
    camera.position.set(4, 1.7, -9);
    audio.update(0.016, camera);
    expect(context.listener.positionX.value).toBeCloseTo(4);
    expect(context.listener.positionY.value).toBeCloseTo(1.7);
    expect(context.listener.positionZ.value).toBeCloseTo(-9);
  });

  it("plays a sound at the local player flat, and one in the world through a panner", async () => {
    const { audio, camera } = systemWith([]);
    camera.position.set(0, 0, 0);
    audio.update(0.016, camera);
    audio.playAtListener("shout");
    audio.playAt("shout", { x: 0, y: 0, z: 5 });
    await settle();
    const voices = [...audio.root.children];
    expect(voices).toHaveLength(2);
    expect(voices.filter((v) => v instanceof THREE.PositionalAudio)).toHaveLength(1);
  });

  it("forgets a world's ambience when it is left", async () => {
    const { audio, camera } = systemWith([{ id: 1, alias: "fence", position: { x: 0, y: 0, z: 0 }, volume: 1, delay: 0 }]);
    audio.update(0.016, camera);
    await settle();
    expect(audio.voiceCount).toBe(1);
    audio.clear();
    expect(audio.voiceCount).toBe(0);
    expect(audio.ambienceCount.placements).toBe(0);
    // And a fetch still in flight from the world just left must not start into
    // the next one: the generation, not the promise, is what settles that.
    audio.update(0.016, camera);
    await settle();
    expect(audio.voiceCount).toBe(0);
  });
});

describe("what a world's ambience is mixed on", () => {
  it("is the ambience channel, even though not one of dome's rows names a mixer group", () => {
    // The bug this caught: dome's 23 aliases all leave `channel` absent, so
    // everything landed on `sfx` and the ambience slider did nothing at all.
    const banks = bankOf({ fence: alias({ loop: true }), radio: alias({ channel: "mission" }) });
    const entries = ambienceEntries(
      [
        { id: 1, alias: "fence", position: ORIGIN, volume: 1, delay: 0 },
        { id: 2, alias: "radio", position: ORIGIN, volume: 1, delay: 0 },
      ],
      banks,
    );
    expect(entries[0]!.requests[0]!.channel).toBe("ambience");
    // And where the game did name one, the game wins.
    expect(entries[1]!.requests[0]!.channel).toBe("voice");
  });
});

describe("an actor's voice", () => {
  // A zombie of one game is heard from its own game's bank wherever it walks, as a
  // weapon is: TranZit's walker on Kino's map takes Black Ops II's recordings.
  const sound = (file: string) => alias({ clips: [{ file, weight: 1 }], range: [1, 50] });
  const zombieBank = (prefix: string) =>
    Object.fromEntries(
      [
        "zmb_zombie_spawn",
        "zmb_vocals_zombie_ambience",
        "zmb_vocals_zombie_sprint",
        "zmb_vocals_zombie_attack",
        "zmb_attack_whoosh",
        "zmb_vocals_zombie_death",
      ].map((name) => [name, sound(`${prefix}_${name}`)]),
    );
  const t5 = bankOf(zombieBank("t5"), "/catalog/sounds/t5/");
  const t6 = bankOf(zombieBank("t6"), "/catalog/sounds/t6/")[0]!;
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  function setup(): { audio: AudioSystem; voices: ActorVoices; heard: () => string[] } {
    const audio = new AudioSystem();
    audio.attach({
      banks: t5,
      placements: [],
      clips: { audio: async () => fakeBuffer(0.4) },
      game: "t5",
      bankFor: async (game) => (game === "t6" ? t6 : undefined),
    });
    const camera = new THREE.PerspectiveCamera();
    audio.attachTo(camera);
    audio.update(0.016, camera);
    return { audio, voices: new ActorVoices(audio), heard: () => audio.voices.map((v) => v.request.url.replace(/^.*\//, "").replace(".webm", "")) };
  }

  const actor = (kind: string, over: Partial<ActorState> = {}): ActorState => ({
    id: 1,
    kind: actorKindIndex(kind),
    feet: { x: 0, y: 0, z: -2 },
    yaw: 0,
    speed: 1,
    gait: "walk",
    action: "move",
    phase: 0.2,
    traversal: 0,
    ...over,
  });

  it("is silent for what was already there when this browser joined, and sounds an arrival after", async () => {
    const { voices, heard } = setup();
    voices.apply([actor("zombie")], 0);
    await settle();
    expect(heard()).toEqual([]);
    voices.apply([actor("zombie"), actor("zombie", { id: 2 })], 0.05);
    await settle();
    expect(heard()).toEqual(["t5_zmb_zombie_spawn"]);
  });

  it("voices and swings as an attack begins, and dies once, from its own game's bank", async () => {
    const { voices, heard } = setup();
    voices.apply([actor("zombie_transit")], 0);
    await settle(); // its bank, fetched as it was first seen
    voices.apply([actor("zombie_transit", { action: "attack", phase: 0 })], 0.05);
    voices.apply([actor("zombie_transit", { action: "die", phase: 0 })], 0.1);
    await settle();
    expect(heard().sort()).toEqual(["t6_zmb_attack_whoosh", "t6_zmb_vocals_zombie_attack", "t6_zmb_vocals_zombie_death"]);
  });

  it("moans on its own every few seconds, a sprinter's scream for a sprinter", async () => {
    const { voices, heard } = setup();
    voices.apply([actor("zombie", { gait: "sprint" })], 0);
    voices.apply([actor("zombie", { gait: "sprint" })], 1);
    await settle();
    expect(heard()).toEqual([]);
    voices.apply([actor("zombie", { gait: "sprint" })], 9);
    await settle();
    expect(heard()).toEqual(["t5_zmb_vocals_zombie_sprint"]);
  });
});

describe("what a world loads", () => {
  /** Both tables over a stubbed fetch, so what is asserted is the URLs and the order. */
  async function build(world: unknown, tables: Record<string, unknown>): Promise<{ built: unknown; asked: string[] }> {
    const asked: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      asked.push(url);
      const body = tables[url];
      return body ? { ok: true, json: async () => body } : { ok: false, status: 404, statusText: "Not Found" };
    }) as never;
    try {
      const { buildSounds } = await import("../src/scene/sounds.js");
      const store = { audio: async (url: string) => (asked.push(url), fakeBuffer()) } as never;
      return { built: await buildSounds(world as never, "/worlds/dome-mw3/", store), asked };
    } finally {
      globalThis.fetch = original;
    }
  }

  const table = (aliases: Record<string, SoundAlias>): unknown => ({ _version: 1, game: "iw5", aliases });

  it("fetches the world's table, then the catalogue's, and prefetches only the ambience's clips", async () => {
    const { built, asked } = await build(
      {
        game: "iw5",
        soundLibrary: { source: "assets/sounds/sounds.json" },
        sounds: [{ id: 1, alias: "fence", position: { x: 0, y: 0, z: 0 }, volume: 1, delay: 0 }],
      },
      {
        "/worlds/dome-mw3/assets/sounds/sounds.json": table({ fence: alias({ loop: true, clips: [{ file: "ambient/rattle", weight: 1 }] }) }),
        "/api/catalog/sounds/iw5/mp/sounds.json": table({ step_run_plr_dirt: alias({ clips: [{ file: "footsteps/foot_dirt01", weight: 1 }] }) }),
      },
    );
    expect((built as { banks: SoundBank[] }).banks).toHaveLength(2);
    // The catalogue's 556 clips are not prefetched: nothing knows in advance
    // which surfaces a player will walk on, and a footstep fetches its own.
    expect(asked).toEqual([
      "/worlds/dome-mw3/assets/sounds/sounds.json",
      "/api/catalog/sounds/iw5/mp/sounds.json",
      "/worlds/dome-mw3/assets/sounds/clips/ambient/rattle.webm",
    ]);
  });

  it("still gets the catalogue's bank for a world that places no sound of its own", async () => {
    // Which is 41 of the 42 imported worlds today, and all of them once
    // footsteps land: a world with no `sounds` node still has boots.
    const { built } = await build({ game: "iw5", sounds: [] }, { "/api/catalog/sounds/iw5/mp/sounds.json": table({ step_run_plr_dirt: alias() }) });
    expect((built as { banks: SoundBank[] }).banks).toHaveLength(1);
  });

  it("keeps a world's own ambience when the catalogue is not built", async () => {
    // A deployment with no catalogue degrades rather than falling over, exactly
    // as the weapon one does. What is lost is footsteps, not the map.
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      const { built } = await build(
        { game: "iw5", soundLibrary: { source: "assets/sounds/sounds.json" }, sounds: [] },
        { "/worlds/dome-mw3/assets/sounds/sounds.json": table({ fence: alias() }) },
      );
      expect((built as { banks: SoundBank[] }).banks).toHaveLength(1);
    } finally {
      console.warn = warn;
    }
  });

  it("gets Black Ops II's bank for a Black Ops II world", async () => {
    const { built, asked } = await build(
      { game: "t6", sounds: [] },
      { "/api/catalog/sounds/t6/mp/sounds.json": { ...(table({ zmb_cha_ching: alias() }) as object), game: "t6" } },
    );
    expect(asked).toEqual(["/api/catalog/sounds/t6/mp/sounds.json"]);
    expect((built as { game: string; banks: SoundBank[] }).game).toBe("t6");
    expect((built as { banks: SoundBank[] }).banks).toHaveLength(1);
  });

  it("is undefined for a hand-written world, which has neither", async () => {
    expect((await build({ sounds: [] }, {})).built).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe("footsteps", () => {
  // The real ranges, in metres, out of the catalogue's own table: a third
  // person's run carries 30.5 m and a landing 40.6, and `step_run_plr_dirt` is
  // one of the seven `_plr` rows that carry an ordinary short distance rather
  // than the non-positional one — which is the whole reason the local path does
  // not consult `spatial`.
  const FOUR_CLIPS = [
    { file: "footsteps/foot_dirt01", weight: 1 },
    { file: "footsteps/foot_dirt02", weight: 1 },
    { file: "footsteps/foot_dirt03", weight: 1 },
    { file: "footsteps/foot_dirt04", weight: 1 },
  ];
  const banks = bankOf({
    step_run_dirt: alias({ clips: FOUR_CLIPS, range: [1.27, 30.48], pitch: [0.95, 1.05] }),
    step_run_plr_dirt: alias({ clips: FOUR_CLIPS, range: [1.27, 25.4], spatial: true, pitch: [0.95, 1.05] }),
    step_run_metal: alias({ clips: FOUR_CLIPS, range: [1.27, 30.48] }),
    step_run_plr_metal: alias({ clips: FOUR_CLIPS, range: [127, 635], spatial: false }),
    land_plr_dirt: alias({ range: [2.03, 25.4] }),
    land_dirt: alias({ range: [2.03, 40.64] }),
  });

  function ground(surface: SurfaceType): CapsuleWorld {
    return {
      ready: true,
      resolveCapsule: (position, _r, _h, out) => {
        const result = out ?? { position: { x: 0, y: 0, z: 0 }, grounded: false, normal: { x: 0, y: 0, z: 0 } };
        result.position.x = position.x;
        result.position.y = position.y;
        result.position.z = position.z;
        result.grounded = true;
        result.normal.x = 0;
        result.normal.y = 1;
        result.normal.z = 0;
        return result;
      },
      overlapsCapsule: () => false,
      overlapsSweep: () => false,
      groundBelow: (_from, _distance, normal) => {
        if (normal) {
          normal.x = 0;
          normal.y = 1;
          normal.z = 0;
        }
        return 0;
      },
      traceRay: () => null,
      surfaceAt: () => surface,
    };
  }

  function setup(surface: SurfaceType = "dirt"): { audio: AudioSystem; steps: Footsteps; camera: THREE.PerspectiveCamera } {
    const audio = new AudioSystem();
    audio.attach({ banks, placements: [], clips: { audio: async () => fakeBuffer(0.4) } });
    const camera = new THREE.PerspectiveCamera();
    audio.attachTo(camera);
    camera.position.set(0, 0, 0);
    audio.update(0.016, camera);
    return { audio, steps: new Footsteps(audio, ground(surface)), camera };
  }

  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  /** A player on the ground at `x`, running, with the stride clock at `stride`. */
  function moving(x: number, stride: number): MovementState {
    const state = createMovement({ x, y: 0, z: 0 }, 0, 0);
    state.grounded = true;
    state.velocity.z = -WALK_SPEED; // the combat run, which is the bank's `run`
    state.stride = stride;
    return state;
  }

  /** One peer, stepped from just before the first footfall to just after it. */
  async function oneStep(steps: Footsteps, x: number, id = "peer"): Promise<void> {
    const state = moving(x, footfallPhase(0) - 0.01);
    steps.remote([{ id, state: { dead: false, movement: state } }], 100); // a placement: never a step
    state.stride = footfallPhase(0) + 0.01;
    steps.remote([{ id, state: { dead: false, movement: state } }], 101);
    await settle();
  }

  it("plays somebody else's boots through a panner, at their feet", async () => {
    const { audio, steps } = setup();
    await oneStep(steps, 5);
    expect(audio.voices).toHaveLength(1);
    const voice = audio.voices[0]!;
    expect(voice.request.alias).toBe("step_run_dirt");
    expect(voice.request.channel).toBe("footsteps");
    expect(voice.audio).toBeInstanceOf(THREE.PositionalAudio);
    const panner = (voice.audio as THREE.PositionalAudio).panner;
    expect(panner.positionX.value).toBeCloseTo(5);
    expect(panner.positionZ.value).toBeCloseTo(0);
    // Snapped where it starts, not ramped in from the origin, and attenuating
    // linearly — `inverse` never reaches zero.
    expect(panner.distanceModel).toBe("linear");
    expect(panner.maxDistance).toBeCloseTo(30.48);
  });

  it("starts nothing at all for a player across the map", async () => {
    // The acceptance criterion: a footstep must not be audible from anywhere.
    // 50 m is past `step_run_dirt`'s own 30.5 m, and past it there is no voice,
    // no panner and no fetch — not a very quiet footstep.
    const { audio, steps } = setup();
    await oneStep(steps, 50);
    expect(audio.voices).toHaveLength(0);
    await oneStep(steps, 5, "near");
    expect(audio.voices).toHaveLength(1);
  });

  it("plays your own boots flat, whatever the alias says", async () => {
    // `step_run_plr_dirt` carries a real 25.4 m distance and `spatial: true`,
    // and is still played through THREE.Audio: a panner at zero distance has no
    // well-defined direction and attenuates by nothing.
    const { audio, steps } = setup();
    const state = moving(0, footfallPhase(0) - 0.01);
    steps.local(state);
    state.stride = footfallPhase(0) + 0.01;
    steps.local(state);
    await settle();
    expect(audio.voices).toHaveLength(1);
    expect(audio.voices[0]!.request.alias).toBe("step_run_plr_dirt");
    expect(audio.voices[0]!.request.position).toBeUndefined();
    expect(audio.voices[0]!.audio).not.toBeInstanceOf(THREE.PositionalAudio);
  });

  it("changes alias the moment the ground changes, with nothing to cross-fade", async () => {
    const { audio, steps } = setup("metal");
    await oneStep(steps, 5);
    expect(audio.voices[0]!.request.alias).toBe("step_run_metal");
  });

  it("draws the same clip and the same pitch from the same step, twice", async () => {
    const draw = async () => {
      const { audio, steps } = setup();
      await oneStep(steps, 5);
      const { url, rate, volume } = audio.voices[0]!.request;
      return { url, rate, volume };
    };
    expect(await draw()).toEqual(await draw());
    // And a different one for the next step, or four recordings would be one click.
    const { audio, steps } = setup();
    const state = moving(5, 0);
    steps.remote([{ id: "p", state: { dead: false, movement: state } }], 1);
    const urls: string[] = [];
    for (let i = 1; i <= 12; i++) {
      state.stride = (i * 0.09) % 1;
      steps.remote([{ id: "p", state: { dead: false, movement: state } }], 1 + i);
      await settle();
      urls.push(...audio.voices.map((v) => v.request.url));
    }
    expect(new Set(urls).size).toBeGreaterThan(1);
  });

  it("says nothing for a player who is dead, however their stride was left", async () => {
    const { audio, steps } = setup();
    const state = moving(5, footfallPhase(0) - 0.01);
    steps.remote([{ id: "p", state: { dead: true, movement: state } }], 1);
    state.stride = footfallPhase(0) + 0.01;
    steps.remote([{ id: "p", state: { dead: true, movement: state } }], 2);
    await settle();
    expect(audio.voices).toHaveLength(0);
  });
});

describe("weapons", () => {
  // The M4's own rows out of the catalogue's table, at their real numbers. The
  // shot in your own hands is the game's 63 km non-positional row; a peer's
  // reaches 50.8 m and pulls a distant report that reaches 508. **Nothing here
  // swaps one for the other by distance**: `weap_medium_fardist_6` is a `with`
  // layer on the shot, and `voiceRequests` already gives a layer its own range.
  const banks = bankOf({
    weap_m4carbine_fire_plr: alias({ clips: [{ file: "weapons/m4_plr", weight: 1 }], range: [12700, 63500], spatial: false, with: "weap_mech_layer_smg_plr" }),
    weap_mech_layer_smg_plr: alias({ clips: [{ file: "weapons/mech_smg", weight: 1 }], range: [12700, 63500], spatial: false }),
    weap_m4carbine_fire_npc: alias({ clips: [{ file: "weapons/m4_npc", weight: 1 }], range: [0.889, 50.83], with: "weap_medium_fardist_6" }),
    weap_medium_fardist_6: alias({ clips: [{ file: "weapons/fardist6", weight: 1 }], range: [38.1, 508] }),
    weap_m4carbine_reload_npc: alias({ clips: [{ file: "weapons/m4_reload_npc", weight: 1 }], range: [0.61, 15.24] }),
    weap_m4carbine_clipout_plr: alias({ clips: [{ file: "weapons/clipout", weight: 1 }], range: [0.18, 12.7] }),
    weap_m4carbine_clipin_plr: alias({ clips: [{ file: "weapons/clipin", weight: 1 }], range: [0.18, 12.7] }),
    weap_m4carbine_chamber_close_plr: alias({ clips: [{ file: "weapons/chamber", weight: 1 }], range: [0.18, 12.7] }),
    bullet_large_metal: alias({ clips: [{ file: "impacts/metal", weight: 1 }], range: [1, 40] }),
    bullet_large_default: alias({ clips: [{ file: "impacts/default", weight: 1 }], range: [1, 40] }),
    mp_hit_alert: alias({ clips: [{ file: "ui/hitalert", weight: 1 }], range: [12700, 63500], spatial: false }),
    bodyfall_metal_large: alias({ clips: [{ file: "foley/bodyfall", weight: 1 }], range: [2, 30] }),
  });

  const RELOAD_CLIP: WeaponClipInfo = {
    duration: 2.333,
    looped: false,
    notes: [
      ["weap_m4carbine_clipout_plr", 0.3667],
      ["viewmodel_small", 0.4],
      ["weap_m4carbine_clipin_plr", 1.2333],
      ["weap_m4carbine_chamber_close_plr", 1.7333],
    ],
  };

  const M4: WeaponDef = {
    game: "iw5",
    weapon: "iw5_m4_mp",
    gun: "viewmodel_m4",
    roles: { reloadEmpty: "reload_clip" },
    clips: { reload_clip: RELOAD_CLIP },
    times: {},
    clipSize: 30,
    fireType: "Full Auto",
    boltAction: false,
    roundsPerLoad: 0,
    adsZoomFov: 50,
    adsOverlay: null,
    motion: {},
    hideBones: [],
    spread: { hipStandMin: 0, hipStandMax: 0 },
    sounds: {
      fire: "weap_m4carbine_fire_npc",
      firePlayer: "weap_m4carbine_fire_plr",
      reload: "weap_m4carbine_reload_npc",
      impact: "bullet_large",
      notes: {
        weap_m4carbine_clipout_plr: "weap_m4carbine_clipout_plr",
        weap_m4carbine_clipin_plr: "weap_m4carbine_clipin_plr",
        weap_m4carbine_chamber_close_plr: "weap_m4carbine_chamber_close_plr",
      },
    },
  };

  /** A world with a wall straight ahead, made of `surface`; `null` for one a round never meets. */
  function walls(surface: SurfaceType | null, distance = 10): CapsuleWorld {
    return {
      ready: true,
      resolveCapsule: (position, _r, _h, out) => {
        const result = out ?? { position: { x: 0, y: 0, z: 0 }, grounded: false, normal: { x: 0, y: 0, z: 0 } };
        result.position.x = position.x;
        result.position.y = position.y;
        result.position.z = position.z;
        result.grounded = true;
        result.normal.x = 0;
        result.normal.y = 1;
        result.normal.z = 0;
        return result;
      },
      overlapsCapsule: () => false,
      overlapsSweep: () => false,
      groundBelow: (_from, _distance, normal) => {
        if (normal) {
          normal.x = 0;
          normal.y = 1;
          normal.z = 0;
        }
        return 0;
      },
      traceRay: (_from, _direction, _far, _channel, out) => {
        if (surface === null) {
          return null;
        }
        const hit = out ?? { distance: 0, normal: { x: 0, y: 0, z: 0 }, kind: "map" as const, surface: DEFAULT_SURFACE };
        hit.distance = distance;
        hit.kind = "map";
        hit.surface = surface;
        return hit;
      },
      surfaceAt: () => surface ?? DEFAULT_SURFACE,
    };
  }

  function setup(surface: SurfaceType | null = null): { audio: AudioSystem; guns: WeaponAudio } {
    const audio = new AudioSystem();
    audio.attach({ banks, placements: [], clips: { audio: async () => fakeBuffer(0.4) } });
    const camera = new THREE.PerspectiveCamera();
    audio.attachTo(camera);
    camera.position.set(0, 0, 0);
    audio.update(0.016, camera);
    return { audio, guns: new WeaponAudio(audio, walls(surface)) };
  }

  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  function weaponData(over: Partial<WeaponData> = {}): WeaponData {
    return {
      state: "idle",
      input: { trigger: false, ads: false, sprint: false },
      timer: 0,
      span: 0,
      ammo: 30,
      cooldown: 0,
      pressed: false,
      burstLeft: 0,
      ads: 0,
      reloadQueued: false,
      refillAt: null,
      fired: 0,
      spread: 0,
      kick: { pitch: 0, yaw: 0, pitchSpeed: 0, yawSpeed: 0 },
      viewKick: { pitch: 0, yaw: 0, pitchVel: 0, yawVel: 0 },
      clip: null,
      ...over,
    };
  }

  /** The local player, standing at the origin, holding one M4 across every call. */
  function shooter(data: WeaponData): SoundingShooter {
    return { movement: createMovement({ x: 0, y: 0, z: 0 }, 0, 0), weapon: { def: M4, data }, seed: 7 };
  }

  const source: WeaponSource = { defAt: (index) => (index === 0 ? M4 : undefined) };

  function peer(x: number, data: WeaponData, dead = false): SoundingPeer {
    const movement = createMovement({ x, y: 0, z: 0 }, 0, 0);
    return { id: "p", state: { dead, movement, weaponIndex: 0, attachments: [], weapon: data } };
  }

  it("is one voice per round on full auto, flat, and pulls the weapon's mechanical layer", async () => {
    const { audio, guns } = setup();
    // The controller is one object across the whole burst, which is what "the
    // same weapon is still held" means; a new one would reset the count.
    const data = weaponData();
    const held = shooter(data);
    guns.local(held);
    data.fired = 3;
    guns.local(held);
    await settle();
    // Three rounds, each with its `with` layer: six voices, not three and not four.
    const fired = audio.voices.filter((v) => v.request.alias === "weap_m4carbine_fire_plr");
    expect(fired).toHaveLength(3);
    expect(audio.voices.filter((v) => v.request.alias === "weap_mech_layer_smg_plr")).toHaveLength(3);
    // Flat: your own rifle is never panned, and `spatial: false` agrees here.
    expect(fired[0]!.request.position).toBeUndefined();
    expect(fired[0]!.audio).not.toBeInstanceOf(THREE.PositionalAudio);
    expect(fired[0]!.request.channel).toBe("sfx");
    // And a state that has not moved fires nothing more.
    const before = audio.voices.length;
    guns.local(held);
    await settle();
    expect(audio.voices).toHaveLength(before);
  });

  it("plays somebody else's rifle through a panner, at the shooter, and their distant report with it", async () => {
    const { audio, guns } = setup();
    const data = weaponData();
    guns.remote([peer(5, data)], source);
    data.fired = 1;
    guns.remote([peer(5, data)], source);
    await settle();
    const shot = audio.voices.find((v) => v.request.alias === "weap_m4carbine_fire_npc")!;
    expect(shot).toBeDefined();
    expect(shot.audio).toBeInstanceOf(THREE.PositionalAudio);
    expect((shot.audio as THREE.PositionalAudio).panner.positionX.value).toBeCloseTo(5);
    // The tail is a layer with its own reach, not a second alias chosen by
    // distance. Close up you hear both.
    const tail = audio.voices.find((v) => v.request.alias === "weap_medium_fardist_6")!;
    expect(tail.request.range[1]).toBeCloseTo(508);
  });

  it("culls the shot at its own range and keeps the report, which is the whole of the distance swap", async () => {
    const { audio, guns } = setup();
    const data = weaponData();
    // 120 m: past `weap_m4carbine_fire_npc`'s 50.8 m and well inside the tail's
    // 508. No voice for the shot at all — not a quiet one.
    guns.remote([peer(120, data)], source);
    data.fired = 1;
    guns.remote([peer(120, data)], source);
    await settle();
    expect(audio.voices.map((v) => v.request.alias)).toEqual(["weap_medium_fardist_6"]);
  });

  it("reloads as a sequence of the clip's own notetracks, in order", async () => {
    const { audio, guns } = setup();
    const data = weaponData({ state: "reloading", clip: { role: "reloadEmpty", time: 0, rate: 1, loop: false } });
    const held = shooter(data);
    guns.local(held);
    for (const time of [0.5, 1.5, 2.3]) {
      data.clip!.time = time;
      guns.local(held);
    }
    await settle();
    expect(audio.voices.map((v) => v.request.alias)).toEqual(["weap_m4carbine_clipout_plr", "weap_m4carbine_clipin_plr", "weap_m4carbine_chamber_close_plr"]);
  });

  it("gives a peer one reload alias rather than the notetracks in your own hands", async () => {
    const { audio, guns } = setup();
    const idle = weaponData();
    guns.remote([peer(5, idle)], source);
    const reloading = weaponData({ state: "reloading", clip: { role: "reloadEmpty", time: 0.5, rate: 1, loop: false } });
    guns.remote([peer(5, reloading)], source);
    reloading.clip!.time = 1.5;
    guns.remote([peer(5, reloading)], source);
    await settle();
    expect(audio.voices.map((v) => v.request.alias)).toEqual(["weap_m4carbine_reload_npc"]);
  });

  it("sounds a round arriving like what it arrived on", async () => {
    const { audio, guns } = setup("metal");
    const data = weaponData();
    const held = shooter(data);
    guns.local(held);
    data.fired = 1;
    guns.local(held);
    await settle();
    const impact = audio.voices.find((v) => v.request.alias === "bullet_large_metal")!;
    expect(impact).toBeDefined();
    // At the wall, not at the shooter: 10 m out along the aim, which is -Z.
    expect(impact.audio).toBeInstanceOf(THREE.PositionalAudio);
    expect((impact.audio as THREE.PositionalAudio).panner.positionZ.value).toBeCloseTo(-10);
  });

  it("falls back to the family's default where the bank has no row for that surface", async () => {
    // `bullet_large` has no `snow` and no `water` — measured, 29 of the engine's
    // 31 — so an M4 over a puddle must not be silent where an AP round is not.
    const { audio, guns } = setup("snow");
    const data = weaponData();
    const held = shooter(data);
    guns.local(held);
    data.fired = 1;
    guns.local(held);
    await settle();
    expect(audio.voices.map((v) => v.request.alias)).toContain("bullet_large_default");
  });

  it("makes no impact at all for a round that met nothing", async () => {
    const { audio, guns } = setup(null);
    const data = weaponData();
    const held = shooter(data);
    guns.local(held);
    data.fired = 1;
    guns.local(held);
    await settle();
    expect(audio.voices.map((v) => v.request.alias)).not.toContain("bullet_large_default");
  });

  it("puts a hit marker on `ui` and flat, and a death in the world", async () => {
    const { audio, guns } = setup("metal");
    guns.hitMarker();
    await settle();
    expect(audio.voices).toHaveLength(1);
    expect(audio.voices[0]!.request.channel).toBe("ui");
    expect(audio.voices[0]!.request.position).toBeUndefined();

    const fell = setup("metal");
    fell.guns.death({ x: 3, y: 0, z: 0 });
    await settle();
    expect(fell.audio.voices[0]!.request.alias).toBe("bodyfall_metal_large");
    expect(fell.audio.voices[0]!.audio).toBeInstanceOf(THREE.PositionalAudio);
  });

  it("says nothing for a dead peer, however their counter was left", async () => {
    const { audio, guns } = setup();
    const data = weaponData();
    guns.remote([peer(5, data, true)], source);
    data.fired = 4;
    guns.remote([peer(5, data, true)], source);
    await settle();
    expect(audio.voices).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

/**
 * What a gametype says out loud: the last seam, and the only one whose meaning
 * the engine does not know.
 *
 * The chain under test is `publish` → the snapshot tail → `ClientHooks.event` →
 * a voice. The server half of it is `game-server/tests/announce.test.ts`; this
 * is what a browser does with the event when it arrives, which is the half that
 * turns a name into an alias and an alias into a `THREE.Audio` with no panner on
 * it.
 */
describe("what a script says out loud", () => {
  const banks = bankOf({
    ui_mp_timer_countdown: alias({ clips: [{ file: "user_interface/countdown", weight: 1 }], range: [3, 15], spatial: true }),
    mp_bonus_start: alias({ clips: [{ file: "mp/bonus_start", weight: 1 }], range: [3, 15], spatial: true }),
  });

  function setup(scripts?: readonly Script[]): { audio: AudioSystem; scripts: ClientScripts; where: ScriptSurroundings } {
    const audio = new AudioSystem();
    audio.attach({ banks, placements: [], clips: { audio: async () => fakeBuffer(0.4) } });
    const camera = new THREE.PerspectiveCamera();
    audio.attachTo(camera);
    // Away from the origin, so a panner that existed would be audibly somewhere.
    camera.position.set(20, 1.6, -30);
    audio.update(0.016, camera);
    const players = [
      { id: "me", team: "allies", bot: false, points: 0 },
      { id: "them", team: "axis", bot: false, points: 0 },
    ];
    const view = {
      map: "dome-mw3",
      game: "iw5",
      gametype: { id: "default", display: "Free Roam", teams: ["allies", "axis"] },
      now: 10,
      seed: 1,
      players,
      player: (id: string) => players.find((p) => p.id === id),
    } as unknown as GameView;
    return { audio, scripts: new ClientScripts(audio, scripts), where: { view, self: players[0] } };
  }

  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  const announce = (over: Partial<AnnounceEvent> = {}): AnnounceEvent => ({
    kind: "announce",
    id: 1,
    what: "roundStart",
    team: null,
    value: null,
    player: null,
    ...over,
  });

  it("turns a published name into the alias its own client half chose", async () => {
    const { audio, scripts, where } = setup();
    scripts.hear(announce({ what: "countdown", value: 3 }), where);
    await settle();
    expect(audio.voices.map((v) => v.request.alias)).toEqual(["ui_mp_timer_countdown"]);
    expect(audio.voices[0]!.request.channel).toBe("ui");
  });

  /**
   * **Flat, whatever the alias says.** Both of these carry an ordinary 15 m
   * `distMax` in the game's own bank — the same trap `step_run_plr_dirt` is —
   * and a feedback sound must not attenuate, pan, or duck when the player turns
   * their head. `say` has nowhere to put a position, so this is structural
   * rather than a rule every call site has to remember.
   */
  it("plays it at the listener with no panner, whatever the row says", async () => {
    const { audio, scripts, where } = setup();
    scripts.hear(announce(), where);
    await settle();
    const voice = audio.voices[0]!;
    expect(voice.request.alias).toBe("mp_bonus_start");
    expect(voice.request.channel).toBe("voice");
    expect(voice.request.position).toBeUndefined();
    expect(voice.audio).toBeInstanceOf(THREE.Audio);
    expect(voice.audio).not.toBeInstanceOf(THREE.PositionalAudio);
  });

  it("hands a script the side as a name, read against the side this browser is on", () => {
    const heard: (string | undefined)[] = [];
    const mine: Script = {
      id: "mine",
      client: { event: (ctx, event) => void heard.push(event.team === ctx.self?.team ? "ours" : event.team) },
    };
    const { scripts, where } = setup([mine]);
    // Side 1 of `["allies", "axis"]`, and this browser is on side 0.
    scripts.hear(announce({ what: "flagTaken", team: 1 }), where);
    scripts.hear(announce({ what: "flagTaken", team: 0 }), where);
    scripts.hear(announce({ what: "flagTaken", team: null }), where);
    // One event, localised at each end: the server addressed nobody.
    expect(heard).toEqual(["axis", "ours", undefined]);
  });

  /**
   * An alias nothing here holds is the failure this whole layer exists to
   * avoid: silence that looks like success. So it is loud in development — once
   * per alias, not once per announcement — and harmless in play, which is a
   * voice that never starts. `pnpm catalog` is the other half, and it refuses
   * the build before anybody plays.
   */
  it("warns once and plays nothing for an alias no bank here holds", async () => {
    const missing: Script = { id: "missing", sounds: ["mp_nothing_here"], client: { event: (ctx) => ctx.say("mp_nothing_here") } };
    const { audio, scripts, where } = setup([missing]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (let i = 0; i < 5; i++) {
      scripts.hear(announce({ id: i + 1 }), where);
    }
    await settle();
    expect(audio.voices).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/mp_nothing_here/);
    warn.mockRestore();
  });

  it("refuses the one verb it has that is not built, rather than doing nothing", () => {
    const asking: Script = { id: "asking", client: { event: (ctx) => ctx.request({ open: "a door" }) } };
    const { scripts, where } = setup([asking]);
    expect(() => scripts.hear(announce(), where)).toThrow(/request\(\), which is declared but not built/);
  });
});
