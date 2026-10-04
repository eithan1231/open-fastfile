import { useUi } from "../context.js";
import styles from "./Vitals.module.css";

/** Below this fraction of `maxHealth`, the bar says so in colour as well as in length. */
const LOW = 0.35;

/**
 * What is left of the player, bottom left. The server's health and the server's
 * ceiling (`CombatRules.maxHealth`, from `joined`) — a fraction neither of which
 * this client could work out for itself.
 *
 * Hidden while they are down: the middle of the screen is saying so, and an empty
 * bar says it twice.
 */
export function Health() {
  const player = useUi().state.hud.player.value;
  if (!player || player.dead) {
    return null;
  }
  const fraction = player.maxHealth > 0 ? Math.min(1, Math.max(0, player.health / player.maxHealth)) : 0;
  const low = fraction <= LOW;
  return (
    <div class={styles.health} data-testid="hud-health">
      <span class={low ? styles.countLow : styles.count}>{player.health}</span>
      <div class={styles.track}>
        <div class={low ? styles.fillLow : styles.fill} style={{ width: `${fraction * 100}%` }} data-testid="hud-health-fill" />
      </div>
    </div>
  );
}

/**
 * The magazine, bottom right.
 *
 * The rounds in the weapon and nothing else: the simulation has no reserve
 * ammunition, and a second number there would be one this HUD made up. The count
 * is the server's, which is also the one thing that makes a reload honest — the
 * magazine refills when the server says it has.
 */
export function Ammo() {
  const player = useUi().state.hud.player.value;
  if (!player?.weapon || player.dead) {
    return null;
  }
  const { name, ammo, reloading } = player.weapon;
  return (
    <div class={styles.ammo} data-testid="hud-ammo">
      <span class={ammo === 0 ? styles.roundsEmpty : styles.rounds}>{ammo}</span>
      <span class={styles.weapon}>{reloading ? "Reloading" : name}</span>
    </div>
  );
}
