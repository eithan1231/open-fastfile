import { Fragment, type ComponentChildren, type JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import styles from "./Menu.module.css";

export { styles as menuStyles };

/** One button in a menu column. Every menu screen is built from these. */
export interface MenuItem {
  label: string;
  /** What tells two items apart when their labels may not: a player may give two classes one name. The label otherwise. */
  key?: string;
  /** Shown under the list while the item is selected. */
  description?: string;
  /** Omitted: the button does nothing yet. */
  onSelect?: () => void;
  /** Set on an item that opens a panel: whether it is open. */
  open?: boolean;
  /** Set on an item that is what is chosen now, in a list of choices. */
  current?: boolean;
  /** A rule above this item, starting a new group: `true`, or the group's name. */
  divider?: true | string;
  /** Called when the item is highlighted, by hover or by the keyboard. */
  onHighlight?: () => void;
}

/** The full-screen layer a menu screen draws in. Its own class sets the background. */
export function MenuScreen(props: JSX.HTMLAttributes<HTMLDivElement>) {
  return <div {...props} class={`${styles.screen} ${props.class ?? ""}`} />;
}

/**
 * The left two fifths of a menu screen: a title, the buttons, the selected
 * button's description, and anything else (the pause map) at the bottom.
 */
export function MenuColumn(props: { title: string; items: MenuItem[]; children?: ComponentChildren }) {
  return (
    <nav class={styles.column} aria-label={props.title}>
      <h1 class={styles.title}>{props.title}</h1>
      <MenuList items={props.items} />
      <div class={styles.foot}>{props.children}</div>
    </nav>
  );
}

/**
 * Hovering selects, as the arrow keys do, so there is one highlighted button
 * and it is the focused one. The selection is focused on mount and again when
 * a panel closes, so the keyboard always has somewhere to start. In a list of
 * choices, that is the current one.
 */
function MenuList({ items }: { items: MenuItem[] }) {
  const [selected, setSelected] = useState(() =>
    Math.max(
      0,
      items.findIndex((item) => item.current),
    ),
  );
  const list = useRef<HTMLUListElement>(null);
  const anyOpen = items.some((item) => item.open);
  useEffect(() => {
    const button = list.current?.querySelectorAll("button")[selected];
    if (!anyOpen && list.current && button) {
      button.focus({ preventScroll: true });
      // Scrolled by hand, to the middle of the list: scrollIntoView would also
      // scroll the screen, which clips rather than scrolls but moves all the same.
      const { offsetTop, offsetHeight } = button;
      list.current.scrollTop = offsetTop - list.current.offsetTop - (list.current.clientHeight - offsetHeight) / 2;
    }
    // Only on mount and when a panel closes, not on every change of selection.
  }, [anyOpen]);
  return (
    <>
      <ul class={styles.list} ref={list} onKeyDown={(e) => arrowKeys(e, list.current)}>
        {items.map((item, i) => (
          <Fragment key={item.key ?? item.label}>
            {item.divider && (
              <li class={styles.divider} role="presentation">
                {item.divider !== true && item.divider}
              </li>
            )}
            <li>
              <button
                class={styles.item}
                aria-expanded={item.open}
                aria-current={item.current}
                onFocus={() => {
                  setSelected(i);
                  item.onHighlight?.();
                }}
                onMouseEnter={(e) => e.currentTarget.focus({ preventScroll: true })}
                onClick={item.onSelect}
              >
                {item.label}
              </button>
            </li>
          </Fragment>
        ))}
      </ul>
      <p class={styles.description}>{items[selected]?.description}</p>
    </>
  );
}

/** The right-hand side of a menu screen, under a heading level with the column's title. */
export function MenuPanel(props: { title: string; children?: ComponentChildren }) {
  return (
    <section class={styles.panel} aria-label={props.title}>
      <h2 class={styles.panelTitle}>{props.title}</h2>
      {props.children}
    </section>
  );
}

/** Up and down move focus through the buttons in `container`, wrapping around. */
export function arrowKeys(e: KeyboardEvent, container: HTMLElement | null): void {
  if (!container || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) {
    return;
  }
  e.preventDefault();
  const buttons = [...container.querySelectorAll("button")];
  const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const step = e.key === "ArrowDown" ? 1 : -1;
  buttons[at === -1 ? 0 : (at + step + buttons.length) % buttons.length]?.focus();
}

/**
 * Calls `onEscape` when Esc is pressed, while it is set, and keeps that Esc
 * from the game: it closes a panel, not the pause menu. Capturing on window
 * runs before the input manager's listener there.
 */
export function useEscape(onEscape: (() => void) | undefined): void {
  useEffect(() => {
    if (!onEscape) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") {
        return;
      }
      e.stopPropagation();
      onEscape();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [onEscape]);
}
