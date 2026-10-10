# UI

Everything on screen that is not the 3D scene: menus, the loading and error
screens, the pause menu, the HUD and the dev overlay. Preact with signals, CSS
Modules, and one bridge to the rest of the game.

```
app/ (App, DevTools)  ──writes──▶  UiState signals  ──read by──▶  ui/ components
                      ◀─────────── UiCommands ◀──────────────── clicks
```

- **`packages/client/src/app/uiBridge.ts`** is the whole contract: `UiState` (signals holding
  plain data) and `UiCommands` (what the UI may ask for). No three.js values
  cross it; convert them in `packages/client/src/app/` first (see `pickInfo` in `app/dev/inspector.ts`).
  The one thing that is not plain data is a **DOM element**, and there is one
  such command: `previewWeapon(host, weapon, attachments)`. The class menu has
  to show a real weapon turning, and that is the smallest seam that works — the
  app owns the canvas and the renderer behind it
  (`engine/weaponPreview.ts`), the UI owns where on the page it goes, and
  neither learns the other's business.
- **`packages/client/src/ui/`** may import only the bridge from the rest of the codebase. ESLint
  enforces it, as it enforces that `engine/`, `scene/` and `input/` never import
  the UI.
- **Gameplay input is not UI.** Movement, look and game keys go through
  `packages/client/src/input/InputManager.ts`, which is off while a menu is up
  (`input.context = "menu"`). A UI widget handles its own clicks and typing, and
  the input manager ignores keys typed into fields.

## Screens

`Root.tsx` switches on `state.screen`: `auth`, `menu`, `lobby`, `loading`,
`error`, `world`, or `elsewhere` — the player opened the game in another tab,
which has it now ([one tab per player](../server/README.md#one-tab-per-player)).
In a world it renders the HUD, the dev overlay (development builds), and over
them the prompt in `state.prompt` if there is one, else the pause menu when
`state.paused` is set.

Paused means gameplay input is off. Walking is paused exactly while the pointer
is unlocked. Capturing the pointer needs a click or key press, so a loaded world
starts paused under **Click to play** (`prompt: "play"`, `PlayPrompt.tsx`), a
light veil over the live world. A click anywhere else never resumes.

In a match nobody plays before choosing a class, so the loaded world waits under
**Joining the match…** instead (`prompt: "joining"`), which has nothing to click:
the class menu comes up by itself once the game server has answered, or Click to
play does where it says the player is already in (a reconnect, or a gametype
with no classes to choose). A server that cannot be reached leaves the world to
be played offline, and the prompt becomes Click to play. `App.awaitingSpawn` is
what stops a resume starting play meanwhile.

Esc opens and closes the pause menu. Esc on a prompt opens the menu too. The
browser frees the pointer before the page sees Esc and will not re-lock from an
Esc, so closing the menu with Esc shows **Click to resume** (`prompt: "resume"`),
the same prompt. The page never asks for fullscreen; the browser's own
fullscreen key works as usual.

In the dollhouse there is no pointer to capture, and Esc simply toggles the menu.

## Menus

Every menu screen is built from `packages/client/src/ui/menu/Menu.tsx`, so they share one
button and one layout: `MenuColumn` over the left two fifths (a title, the
buttons as `MenuItem` data, the selected button's description, and a slot at
the bottom), and `MenuPanel` over the rest, its heading level with the title.
Hovering a button focuses it, so the highlighted button is always the focused
one and the arrow keys carry on from it. An item that opens a panel sets `open`;
Esc closes the panel (`useEscape`, which keeps that Esc from the game) and focus
returns to the column. In a list of choices, `current` marks the one chosen now
and is where focus starts; `divider` starts a group with a rule, named or not.

The picture behind every menu (`MenuArt.tsx`, images in `ui/art/`) follows the
lobby's gametype: `LobbyMode.backdrop` is `"zombies"` for a gametype played in the
zombies' `mode` and `"generic"` otherwise, including with no lobby at all. Both are always in the
page and crossfade.

- **Main menu:** Private Match makes a lobby and goes straight to it. Create a
  Class is a screen of its own (`CreateClass.tsx`, screen `"classes"`), reached
  from the main menu or a lobby, and its Back returns to whichever it was.
  Callsign, Barracks and Settings are placeholders.
- **Create a Class:** the player's five classes are the column, and one is
  opened by **clicking** it — hovering only shows what it carries. A class is
  built from one game (`Loadout.game`), chosen first; changing it empties both
  slots. Each slot lists that game's weapons by category, and a category belongs
  to one slot (`CATEGORY_SLOT` in `@3d/shared/sim/weaponCategory.ts`, the rule the
  api saves by and a game server equips by). Hovering a weapon shows it in the
  **live 3D preview** before it is chosen. Every change is sent to the api, which
  answers with all five classes reconciled against the catalogue, and the
  signals are replaced from that — so a weapon that has gone since the class was
  saved reads as empty here rather than at spawn. Esc closes the weapon list,
  then the screen.
- **Choose Class:** which class to play is chosen in the match, not here
  (`ChooseClass.tsx`, over the world while `classChoice` is set). On joining it
  comes up before anything else and Esc does nothing — Leave Game is the way
  out. From the pause menu, the gametype decides when a choice takes effect — at
  once, at the next spawn, or not at all (`ClassRules`) — and the server's answer
  is said in a toast; the list marks the class in hand and the one waiting.
  `app/classChoice.ts` keeps those marks and nothing else: the weapons arrive in
  the player's own state, which `WorldSession.followSwap` follows.
- **Lobby:** the roster, the map, and the countdown. A private lobby shows its
  code, and Copy Invite Link sits in the bottom-right corner where the main menu
  has Settings (`menuStyles.corner`) — it is something done for other people, not
  a step in setting the match up. The clipboard only exists on https or
  localhost, so elsewhere the button prints the link above itself instead. The
  host gets Start Match and Game Setup while it waits, Cancel while it counts
  down, and End Match while its game runs; below a divider come Create a Class,
  Barracks (a placeholder) and Leave. **Game Setup is a menu of its own**
  (`GameSetup.tsx`), as Create a Class is: Game Mode, then Map, each opening a
  menu of its own again (`ModeSelect.tsx`, `MapSelect.tsx`). The map list holds
  only the worlds the lobby's gametype names (`LobbyMode.maps`); choosing a
  gametype the map is not played on moves the map to the first one it is
  (`setLobbyMode`), because the api refuses the gametype until then. A countdown,
  or the host role moving on, closes these menus. Esc is Back at every level,
  and from the lobby itself it leaves for the main menu.
- **Pause menu:** the world shows through, blurred. Choose Class is there in a
  match whose gametype lets players choose (`canChooseClass`). Options (quality) and Controls open panels. A private match's host also gets End Match, which ends
  it for everyone and returns them to the lobby; Leave Game leaves the lobby too. The map at the bottom is the whole `minimap` image, still,
  with the player's arrow on it (`PauseMap.tsx`), where the HUD map turns
  under the player.
- **Loading screen:** the world's picture (an imported map's loading screen)
  behind a dark left side, its name, category and description at the top, and
  a bar that fills by load step (`WorldSession.mount` reports each step's place).

## Adding a HUD widget

1. Add the data it shows to `UiState` (a signal) and anything it does to
   `UiCommands`.
2. Write the component under `packages/client/src/ui/hud/` with a `.module.css` beside it, and
   place it in one of `HudLayer`'s regions. The layer passes clicks through to
   the game; a widget that needs the pointer sets `pointer-events: auto`.
3. Have the app write the signal. Values that change every frame should be
   published at 10 Hz or less, as the stats readout is. A component re-renders
   only when a signal it read changes, so keep fast-changing values in their own
   small component. A widget that must follow every frame (the minimap turning
   with the mouse) reads the signal in `useSignalEffect` and writes its element's
   style there, so it never re-renders (`hud/Minimap.tsx`).

## What the HUD is told

Everything on the HUD comes from the server, through `app/hud.ts` and out as
`UiState.hud`. The client predicts movement; it does not predict its health, its
ammunition or whether it killed anybody.

Two kinds of thing arrive, and they are not the same kind:

- **State** — health, ammunition, whether they are dead and how long until they
  respawn — rides in every snapshot, so a lost one costs nothing: the next tick
  says the same thing.
- **Events** — a hit marker, a death — ride in a short tail on the snapshot
  (`net/messages/events.ts`) with a monotonic id the client de-dupes against.
  They are the only things on the wire that _happened_ rather than _are_, which
  is why they are repeated and why the id exists.

A hit marker is addressed to whoever fired and is sent for one tick only: its
whole value is immediacy, and a repeat would be a lie about when. A death is
broadcast and repeated for half a second, because a missing kill-feed line is
permanently wrong and no later state repairs it. That difference is retention on
one mechanism, not two mechanisms.

The wire carries player ids and no names; the feed resolves them against the
lobby roster, which survives into the match.

A gametype whose `respawnDelay` is null brings nobody back on a clock
([scripting](scripting.md#points-counters-and-the-end-of-a-game)), so
`HudPlayerInfo.respawnIn` is null rather than a count, and the downed screen says
the player is waiting to be brought back.

### Points and counters

State, like health: both ride every snapshot
([scripting](scripting.md#points-counters-and-the-end-of-a-game)). `app/hud.ts`
learns from `joined` which the gametype keeps — its declared `counters`, and
whether it has `points` — and publishes two signals:

- **`hud.counters`**: one `{ name, value }` per declared counter, in declaration
  order, 0 until the server says otherwise, and replaced only when a value
  changed. `hud/Tally.tsx`'s `Counters` draws them bottom left, the name over the
  number; an empty list draws nothing.
- **`hud.points`**: this player's purse, or null for a gametype with no points.
  `Points` draws it bottom right.

The names are the declaration's own. A gametype that wants a friendlier label
declares the counter under that name.

## The use prompt

The one thing on the HUD that is neither the server's state nor an event, and
the second — after the crosshair's cone — that this browser predicts.
`app/useFocus.ts` runs the same `focusOf` a game server runs on the use key's
edge, every frame, from the predicted player, and asks the gametype's client half
what to say (`prompt`, [scripting](scripting.md#areas-and-the-use-key)). It
publishes `UiState.hud.use` — the text with `{key}` in it, the bound key's name
from `input/bindings.ts`, and which thing — and writes the signal only when one
of those changes, so walking about re-renders nothing. `hud/UsePrompt.tsx` draws
it under the crosshair with the key as a key; a development build also names the
focused thing, even where the script shows no prompt. No prompt text is on the
wire: the script reads what the snapshot already carries.

## Styles

`packages/client/src/ui/styles/tokens.css` holds every colour, font, radius and stacking layer
as custom properties, plus the page's base styles. Components take values from
there and never hard-code them. Stacking, bottom to top: HUD, debug, menus,
error.

`--menu-scale` is how large the menus are drawn. Every menu font size is written
as `calc(<size> * var(--menu-scale))`, as are the few sizes that have to grow
with the text (a button's padding, the selection arrow, the lobby's map card), so
resizing the menus is one number. The HUD does not read it.

## Tests

Component tests use happy-dom and `@testing-library/preact` (`tests/ui.test.tsx`).
Render `Root` with a fresh `createUiState()` and mocked commands, change signals
inside `act()`, and assert on what is shown and what commands were called.
