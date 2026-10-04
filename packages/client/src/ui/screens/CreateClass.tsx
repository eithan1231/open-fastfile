import { useEffect, useRef, useState } from "preact/hooks";
import {
  CATEGORY_LABEL,
  CATEGORY_SLOT,
  LOADOUT_GAMES,
  MAX_LOADOUT_ATTACHMENTS,
  WEAPON_CATEGORIES,
  type Loadout,
  type UiWeapon,
  type WeaponCategory,
} from "../../app/uiBridge.js";
import { useUi } from "../context.js";
import { arrowKeys, MenuColumn, MenuPanel, MenuScreen, menuStyles, useEscape, type MenuItem } from "../menu/Menu.js";
import { classSummary } from "./classes.js";
import { MenuArt } from "./MenuArt.js";
import styles from "./CreateClass.module.css";

/** Which weapon of a class is being looked at. */
type Slot = "primary" | "secondary";

const SLOTS: Slot[] = ["primary", "secondary"];
const SLOT_LABEL: Record<Slot, string> = { primary: "Primary", secondary: "Secondary" };

/**
 * Create a Class: a screen of its own, reached from the main menu or a lobby, and
 * Back returns there.
 *
 * The classes are the column on the left, and one is **opened by clicking it**,
 * never by hovering — hovering only says what it carries. A class is built from
 * one game: choose the game, then a primary and a secondary from that game's
 * weapons, listed by category. Changing the game empties both slots, because no
 * weapon belongs to two games.
 *
 * Everything here is a class as the api gave it back. A change is sent and the
 * whole set is replaced by the answer, so a weapon the catalogue has dropped
 * since the class was saved shows as empty immediately rather than at spawn.
 *
 * Choosing which class to *play* is not done here: that is chosen in the match,
 * and the game server holds it to the next spawn.
 */
export function CreateClass() {
  const { state, commands } = useUi();
  const classes = state.loadouts.value;
  const weapons = state.weapons.value;

  const [editing, setEditing] = useState<number | null>(null);
  const [slot, setSlot] = useState<Slot>("primary");
  const [picking, setPicking] = useState(false);
  /** The weapon under the cursor while picking, which is what the preview shows. */
  const [hover, setHover] = useState<string | null>(null);

  // Esc is Back: out of the weapon list first, then out of the screen.
  useEscape(picking ? () => setPicking(false) : () => commands.closeClasses());

  const loadout = editing === null ? undefined : classes[editing];
  const edit = (change: (was: Loadout) => Loadout) => {
    if (editing !== null && loadout) {
      commands.saveLoadout(editing, change(loadout));
    }
  };

  const items: MenuItem[] = [
    ...classes.map((one, index): MenuItem => ({
      key: `class-${index}`,
      label: one.name,
      description: classSummary(one, weapons),
      open: editing === index,
      onSelect: () => {
        setEditing(index);
        setPicking(false);
        setHover(null);
      },
    })),
    { label: "Back", description: "Back to where you came from.", onSelect: () => commands.closeClasses() },
  ];

  const held = loadout?.[slot];
  const shown = picking && hover !== null ? hover : (held?.weapon ?? null);
  const shownAttachments = picking && hover !== null && hover !== held?.weapon ? [] : (held?.attachments ?? []);

  return (
    <MenuScreen class={styles.screen}>
      <MenuArt />
      <MenuColumn title="Create a Class" items={items} />
      <MenuPanel title={loadout?.name ?? "Custom Classes"}>
        {weapons.length === 0 ? (
          <p class={styles.empty}>
            No weapons in the catalogue. Build one with <code>python3 -m scripts.cod catalog --dump mw3</code> (see docs/cod/pipeline.md).
          </p>
        ) : !loadout || editing === null ? (
          <p class={styles.empty}>Choose a class to edit.</p>
        ) : (
          <div class={styles.split}>
            <div class={styles.editor}>
              <ClassName key={editing} name={loadout.name} onRename={(name) => edit((was) => ({ ...was, name }))} />
              <GameChoice
                game={loadout.game}
                onChoose={(game) => {
                  setPicking(false);
                  // No weapon is two games', so a new game starts the class empty.
                  edit((was) => (was.game === game ? was : { ...was, game, primary: nothing(), secondary: nothing() }));
                }}
              />
              {SLOTS.map((which) => (
                <SlotRow
                  key={which}
                  slot={which}
                  loadout={loadout}
                  weapons={weapons}
                  disabled={loadout.game === null}
                  open={picking && slot === which}
                  onOpen={() => {
                    setSlot(which);
                    setPicking(picking ? slot !== which : true);
                    setHover(null);
                  }}
                  onFit={(ids) => edit((was) => ({ ...was, [which]: { ...was[which], attachments: ids } }))}
                />
              ))}
            </div>
            {picking && loadout.game !== null ? (
              <WeaponPicker
                weapons={weapons.filter((w) => w.game === loadout.game && w.category !== null && CATEGORY_SLOT[w.category] === slot)}
                slot={slot}
                current={held?.weapon ?? null}
                onHover={setHover}
                onPick={(id) => {
                  edit((was) => ({ ...was, [slot]: { weapon: id, attachments: [] } }));
                  setPicking(false);
                  setHover(null);
                }}
              />
            ) : null}
            <Preview weapon={shown} attachments={shownAttachments} />
          </div>
        )}
      </MenuPanel>
    </MenuScreen>
  );
}

const nothing = () => ({ weapon: null, attachments: [] });

/** The class's name, saved when the field is left rather than on every keystroke. */
function ClassName(props: { name: string; onRename: (name: string) => void }) {
  const [text, setText] = useState(props.name);
  return (
    <input
      class={styles.rename}
      value={text}
      aria-label="Class name"
      maxLength={24}
      onInput={(e) => setText(e.currentTarget.value)}
      onBlur={() => text.trim() && text !== props.name && props.onRename(text.trim())}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
    />
  );
}

/** Which game the class is built from. Chosen first: until it is, there is nothing to pick from. */
function GameChoice(props: { game: string | null; onChoose: (game: string) => void }) {
  return (
    <section class={styles.slot}>
      <h4 class={styles.slotName}>Game</h4>
      <div class={styles.games} role="radiogroup" aria-label="Game">
        {LOADOUT_GAMES.map((game) => (
          <button key={game.id} role="radio" aria-checked={props.game === game.id} class={styles.gameChoice} onClick={() => props.onChoose(game.id)}>
            {game.name}
          </button>
        ))}
      </div>
    </section>
  );
}

/** One of the two weapons a class carries: what is in the slot, and what is fitted to it. */
function SlotRow(props: {
  slot: Slot;
  loadout: Loadout;
  weapons: UiWeapon[];
  disabled: boolean;
  open: boolean;
  onOpen: () => void;
  onFit: (ids: string[]) => void;
}) {
  const held = props.loadout[props.slot];
  const weapon = props.weapons.find((w) => w.id === held.weapon);
  return (
    <section class={styles.slot}>
      <h4 class={styles.slotName}>{SLOT_LABEL[props.slot]}</h4>
      <button class={styles.pick} aria-expanded={props.open} disabled={props.disabled} onClick={props.onOpen}>
        {props.disabled ? "Choose a game first" : (weapon?.name ?? "None")}
        {weapon?.category && <span class={styles.kind}>{CATEGORY_LABEL[weapon.category]}</span>}
      </button>
      {weapon && weapon.attachments.length > 0 && <Attachments weapon={weapon} fitted={held.attachments} onFit={props.onFit} />}
    </section>
  );
}

/**
 * What may be fitted. One at a time for now (MAX_LOADOUT_ATTACHMENTS), so
 * picking a second replaces the first rather than being refused — a menu that
 * silently does nothing reads as broken.
 */
function Attachments(props: { weapon: UiWeapon; fitted: readonly string[]; onFit: (ids: string[]) => void }) {
  const list = useRef<HTMLDivElement>(null);
  const fit = (id: string) => {
    const already = props.fitted.includes(id);
    props.onFit(already ? props.fitted.filter((x) => x !== id) : [...props.fitted, id].slice(-MAX_LOADOUT_ATTACHMENTS));
  };
  return (
    <div class={styles.attachments} ref={list} onKeyDown={(e) => arrowKeys(e, list.current)}>
      {props.weapon.attachments.map((attachment) => (
        <button key={attachment.id} class={styles.attachment} aria-pressed={props.fitted.includes(attachment.id)} onClick={() => fit(attachment.id)}>
          {attachment.name}
        </button>
      ))}
    </div>
  );
}

/**
 * The weapons that fit this slot in this game, one category at a time: the
 * categories across the top, and the chosen one's weapons below. Hovering a
 * weapon previews it; clicking one takes it.
 */
function WeaponPicker(props: { weapons: UiWeapon[]; slot: Slot; current: string | null; onHover: (id: string | null) => void; onPick: (id: string) => void }) {
  const categories = WEAPON_CATEGORIES.filter((category) => CATEGORY_SLOT[category] === props.slot && props.weapons.some((w) => w.category === category));
  const currentCategory = props.weapons.find((w) => w.id === props.current)?.category ?? null;
  const [category, setCategory] = useState<WeaponCategory | null>(currentCategory ?? categories[0] ?? null);
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => list.current?.querySelector("button")?.focus({ preventScroll: true }), [category]);

  if (categories.length === 0) {
    return <p class={styles.empty}>This game has no {SLOT_LABEL[props.slot].toLowerCase()} weapons in the catalogue.</p>;
  }
  const shown = props.weapons.filter((w) => w.category === category);
  return (
    <div class={styles.picker}>
      <div class={styles.categories} role="tablist" aria-label="Category">
        {categories.map((one) => (
          <button key={one} role="tab" aria-selected={one === category} class={styles.category} onClick={() => setCategory(one)}>
            {CATEGORY_LABEL[one]}
          </button>
        ))}
      </div>
      <ul class={styles.weapons} ref={list} onKeyDown={(e) => arrowKeys(e, list.current)} onMouseLeave={() => props.onHover(null)}>
        {shown.map((weapon) => (
          <li key={weapon.id}>
            <button
              class={styles.weapon}
              aria-current={weapon.id === props.current}
              onFocus={() => props.onHover(weapon.id)}
              onMouseEnter={(e) => e.currentTarget.focus({ preventScroll: true })}
              onClick={() => props.onPick(weapon.id)}
            >
              {weapon.name}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The turning weapon.
 *
 * The app draws into this element and owns everything behind it; all the UI does
 * is say where it goes and what to show, and take it away again when the screen
 * closes. That is the whole of the three.js boundary here — see
 * `UiCommands.previewWeapon`.
 */
function Preview(props: { weapon: string | null; attachments: readonly string[] }) {
  const { commands } = useUi();
  const host = useRef<HTMLDivElement>(null);
  const fitted = props.attachments.join(",");
  useEffect(() => {
    commands.previewWeapon(host.current, props.weapon, fitted ? fitted.split(",") : []);
  }, [props.weapon, fitted, commands]);
  useEffect(() => () => commands.previewWeapon(null, null, []), [commands]);
  return (
    <div class={styles.preview}>
      <div class={styles.stage} ref={host} />
      {props.weapon === null && <p class={styles.nothing}>Nothing in this slot.</p>}
      <p class={styles.hint}>
        Choose<span class={menuStyles.key}>Enter</span>
      </p>
    </div>
  );
}
