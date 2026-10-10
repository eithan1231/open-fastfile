// What each member carries: the class they chose, when a change of it takes
// effect, and what scripts have said about their weapons over it. Nothing else
// equips a member: `arm` is the one place weapons go into a player's hands.

import { DEFAULT_CLASS_RULES, type ArmedWeapon, type ArmedWith, type ClassRequest, type ClassRules, type ClassTiming } from "@3d/shared/game/classes.js";
import type { Loadout } from "@3d/shared/sim/loadout.js";
import type { WeaponId, WeaponRegistry } from "@3d/shared/sim/weaponRegistry.js";
import type { MatchClock } from "./clock.js";
import type { Member } from "./roster.js";
import type { ScriptHost } from "./scripts.js";

/** One member's side of it. */
export interface ClassState {
  /** The class they carry, and are re-armed with at every spawn. Undefined for a player joined with none. */
  loadout: Loadout | undefined;
  /** Which of their classes that is, as the game order lists them: what a repeated choice is recognised by. */
  index: number | undefined;
  /**
   * A class chosen for their next spawn, held until then — how a change that is
   * not allowed to take effect at once is enforced. `spawned` reads it.
   */
  pending: { loadout: Loadout; index: number } | undefined;
  /** The tick they last spawned on, which the class grace is measured from. */
  spawnedAt: number;
  /** A script's word on this player's mid-game changes (`ServerContext.setClassChange`), over the rules. */
  change: ClassTiming | undefined;
  /** What a script has them spawn with instead of their class (`setLoadout`), until it says otherwise. */
  forced: ArmedWith | undefined;
  /** What a script armed them with while they were dead (`arm`): their next spawn, once. */
  armNext: ArmedWith | undefined;
}

export function newClassState(tick: number): ClassState {
  return { loadout: undefined, index: undefined, pending: undefined, spawnedAt: tick, change: undefined, forced: undefined, armNext: undefined };
}

export class Classes {
  /** Who may choose a class, and when it takes effect. Asked of the scripts once, at match start. */
  private ruled: ClassRules = DEFAULT_CLASS_RULES;

  constructor(
    private readonly clock: MatchClock,
    private readonly weapons: WeaponRegistry,
    private readonly scripts: ScriptHost,
    /** What a player with nothing this instance holds is handed: the gametype's, or null. */
    private readonly defaultWeapon: () => WeaponId | null,
  ) {}

  get rules(): ClassRules {
    return this.ruled;
  }

  /** Ask the gametype's scripts for the rules, once. The first with an opinion wins, over the defaults. */
  askRules(): void {
    const wanted = this.scripts.first((hooks, ctx) => hooks.classRules?.(ctx));
    this.ruled = wanted ? { ...DEFAULT_CLASS_RULES, ...wanted } : DEFAULT_CLASS_RULES;
  }

  /**
   * The class a member joins with, if any: `now`, or `refuse` where the gametype
   * takes no classes or a script said no, in which case they spawn armed as a
   * player with no class is. Arms them either way.
   */
  join(member: Member, loadout: Loadout | undefined, index: number | undefined): ClassTiming {
    let timing: ClassTiming = "now";
    if (loadout !== undefined) {
      const asked = this.ruled.customClasses ? "now" : "refuse";
      timing = this.verdict({ id: member.id, index: index ?? 0, first: true, alive: false, sinceSpawn: 0, timing: asked }) === "refuse" ? "refuse" : "now";
      if (timing === "now") {
        member.kit.loadout = loadout;
        member.kit.index = index;
      }
    }
    this.arm(member);
    return timing;
  }

  /**
   * A member's `index`th class, chosen mid-game. Returns when it takes effect —
   * see `ClassTiming` — which is decided here, in this order: no classes in this
   * gametype, a script's `refuse` for this player, a dead player (whose soonest is
   * their next spawn), a script's word for this player, the grace after a spawn,
   * and the gametype's rule. Then the `classChoice` hook has the last word.
   *
   * The same choice again changes nothing: the client re-sends until it is
   * answered, and a repeat must not refill a magazine by re-arming.
   */
  choose(member: Member, loadout: Loadout, index: number): ClassTiming {
    const kit = member.kit;
    if (kit.pending?.index === index) {
      return "nextSpawn";
    }
    if (kit.index === index) {
      // The class in hand. Choosing it again cancels a change still waiting.
      kit.pending = undefined;
      return "now";
    }

    const alive = !member.player.dead;
    const sinceSpawn = (this.clock.tick - kit.spawnedAt) / this.clock.rate;
    let timing: ClassTiming;
    if (!this.ruled.customClasses || kit.change === "refuse") {
      timing = "refuse";
    } else if (!alive) {
      timing = "nextSpawn";
    } else if (kit.change !== undefined) {
      timing = kit.change;
    } else if (sinceSpawn < this.ruled.grace) {
      timing = "now";
    } else {
      timing = this.ruled.change;
    }
    timing = this.verdict({ id: member.id, index, first: false, alive, sinceSpawn, timing });
    // Nothing is in a corpse's hands to change: the soonest is the next spawn.
    if (timing === "now" && !alive) {
      timing = "nextSpawn";
    }

    if (timing === "now") {
      kit.loadout = loadout;
      kit.index = index;
      kit.pending = undefined;
      // A script's weapons outrank a class (`setLoadout`): the class is theirs
      // again the moment the script lets go, and not before.
      if (kit.forced === undefined) {
        this.arm(member);
      }
    } else if (timing === "nextSpawn") {
      kit.pending = { loadout, index };
    }
    return timing;
  }

  /** A member is spawning: a class chosen while they were down becomes theirs, and they are armed afresh. */
  spawned(member: Member): void {
    const kit = member.kit;
    if (kit.pending) {
      kit.loadout = kit.pending.loadout;
      kit.index = kit.pending.index;
      kit.pending = undefined;
    }
    this.arm(member);
    kit.spawnedAt = this.clock.tick;
  }

  /** `ServerContext.arm`: these weapons in their hands now if they are alive, or at their next spawn — once — if not. */
  armNow(member: Member, weapons: ArmedWith): void {
    member.kit.armNext = this.check(weapons);
    if (!member.player.dead) {
      this.arm(member);
    }
  }

  /** `ServerContext.setLoadout`: what they spawn with instead of their class, or their class again for null. */
  force(member: Member, weapons: ArmedWith | null): void {
    member.kit.forced = weapons === null ? undefined : this.check(weapons);
  }

  /**
   * Hand a member what they carry now: what a script armed them with while they
   * were dead, else what a script has them spawn with, else their class.
   */
  private arm(member: Member): void {
    const kit = member.kit;
    const scripted = kit.armNext ?? kit.forced;
    kit.armNext = undefined;
    const player = member.player;
    if (scripted) {
      player.equipWeapons(armedWeapon(scripted.primary), armedWeapon(scripted.secondary));
      return;
    }
    if (kit.loadout) {
      player.equipLoadout(kit.loadout);
    }
    if (!kit.loadout || player.weaponId === null) {
      player.equipById(this.defaultWeapon());
    }
  }

  /** What the gametype's scripts say about a class request. The first with an opinion wins. */
  private verdict(request: ClassRequest): ClassTiming {
    return this.scripts.first((hooks, ctx) => hooks.classChoice?.(ctx, request)) ?? request.timing;
  }

  /**
   * A script's weapons, checked against this instance's catalogue before anything
   * is equipped. A weapon it does not hold, or an attachment that weapon does not
   * offer, throws: a script that asked for a rifle and silently got an empty hand
   * is a wrong answer nothing would report.
   */
  private check(weapons: ArmedWith): ArmedWith {
    for (const armed of [weapons.primary, weapons.secondary]) {
      if (!armed) {
        continue;
      }
      const entry = this.weapons.entry(armed.weapon);
      if (!entry) {
        throw new Error(`a script armed a player with "${armed.weapon}", which this instance's catalogue does not hold`);
      }
      for (const attachment of armed.attachments ?? []) {
        if (!entry.attachments.some((offered) => offered.id === attachment)) {
          throw new Error(`a script fitted "${attachment}" to "${armed.weapon}", which does not offer it`);
        }
      }
    }
    return weapons;
  }
}

/** A script's weapon as a class's slot would name it, so one `equipWeapons` serves both. */
function armedWeapon(armed: ArmedWeapon | null | undefined): { weapon: string; attachments: string[] } | null {
  return armed ? { weapon: armed.weapon, attachments: [...(armed.attachments ?? [])] } : null;
}
