// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CATEGORY_SLOT, createUiState, type HudPlayerInfo, type UiCommands, type WeaponCategory } from "../src/app/uiBridge.js";
import { defaultLoadouts, type Loadout } from "@3d/shared/sim/loadout.js";
import { Root } from "../src/ui/Root.js";
import { groupWorlds } from "../src/ui/screens/MapSelect.js";

function setup() {
  const state = createUiState();
  const commands: UiCommands = {
    enterWorld: vi.fn(),
    returnToMenu: vi.fn(),
    resume: vi.fn(),
    setQuality: vi.fn(),
    setSensitivity: vi.fn(),
    setAudioVolume: vi.fn(),
    setAudioMuted: vi.fn(),
    previewWeapon: vi.fn(),
    saveLoadout: vi.fn(),
    openClasses: vi.fn(),
    closeClasses: vi.fn(),
    chooseClass: vi.fn(),
    openClassChoice: vi.fn(),
    closeClassChoice: vi.fn(),
    signIn: vi.fn(),
    register: vi.fn(),
    signOut: vi.fn(),
    findGame: vi.fn(),
    createPrivateLobby: vi.fn(),
    setLobbyMap: vi.fn(),
    setLobbyMode: vi.fn(),
    joinLobby: vi.fn(),
    startLobby: vi.fn(),
    endLobby: vi.fn(),
    playHere: vi.fn(),
    leaveLobby: vi.fn(),
  };
  render(<Root state={state} commands={commands} />);
  return { state, commands };
}

afterEach(cleanup);

describe("main menu", () => {
  it("groups imported games in release order, then anything else, then uncategorised", () => {
    const w = (slug: string, category?: string) => ({ slug, name: slug, category });
    const groups = groupWorlds([
      w("a", "Community"),
      w("b", "BO Multiplayer"),
      w("c"),
      w("d", "MW3 Special Ops"),
      w("e", "MW3 Multiplayer"),
      w("f", "MW2 Multiplayer"),
      w("g", "BO Zombies"),
    ]);
    expect(groups.map(([name]) => name)).toEqual([
      "MW2 Multiplayer",
      "MW3 Multiplayer",
      "MW3 Special Ops",
      "BO Multiplayer",
      "BO Zombies",
      "Community",
      "Other",
    ]);
  });

  /** The map is chosen inside the lobby now, so this makes one and goes straight there. */
  it("makes a private lobby under Private Match", () => {
    const { commands } = setup();
    fireEvent.click(screen.getByText("Private Match"));
    expect(commands.createPrivateLobby).toHaveBeenCalled();
  });

  it("queues for a match under Find Game", () => {
    const { commands } = setup();
    fireEvent.click(screen.getByText("Find Game"));
    expect(commands.findGame).toHaveBeenCalled();
  });

  it("opens Create a Class as a screen of its own", () => {
    const { commands } = setup();
    fireEvent.click(screen.getByText("Create a Class"));
    expect(commands.openClasses).toHaveBeenCalled();
  });

  it("does nothing for the buttons with nothing behind them", () => {
    const { commands } = setup();
    for (const label of ["Callsign", "Barracks", "Settings"]) {
      fireEvent.click(screen.getByText(label));
    }
    expect(Object.values(commands).every((c) => vi.mocked(c).mock.calls.length === 0)).toBe(true);
  });

  it("shows the selected button's description", () => {
    setup();
    fireEvent.focus(screen.getByText("Barracks"));
    expect(screen.getByText("Challenges, accolades, prestige and leaderboards.")).toBeTruthy();
  });
});

describe("signing in", () => {
  it("sends what was typed, and registers instead when asked to", () => {
    const { state, commands } = setup();
    act(() => void (state.screen.value = "auth"));

    fireEvent.input(screen.getByLabelText("Username"), { target: { value: "ana" } });
    fireEvent.input(screen.getByLabelText("Password"), { target: { value: "hunter2hunter2" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));
    expect(commands.signIn).toHaveBeenCalledWith("ana", "hunter2hunter2");

    fireEvent.click(screen.getByRole("button", { name: "Create an account" }));
    fireEvent.click(screen.getByRole("button", { name: "Create Account" }));
    expect(commands.register).toHaveBeenCalledWith("ana", "hunter2hunter2");
  });

  it("shows what went wrong, and will not submit an empty form", () => {
    const { state, commands } = setup();
    act(() => void (state.screen.value = "auth"));
    act(() => void (state.authError.value = "That name is taken."));
    expect(screen.getByRole("alert").textContent).toBe("That name is taken.");

    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));
    expect(commands.signIn).not.toHaveBeenCalled();
  });
});

describe("the lobby", () => {
  const player = (id: string, username: string, host = false) => ({ id, username, host });

  const lobby = (overrides: Partial<NonNullable<ReturnType<typeof createUiState>["lobby"]["value"]>> = {}) => ({
    code: "BRAVO7",
    private: false,
    map: null,
    mode: "Free Roam",
    gametype: "default",
    playing: false,
    startsAt: null,
    players: [player("aaaaaaaa", "ana", true), player("bbbbbbbb", "bo")],
    host: false,
    invite: null,
    ...overrides,
  });

  it("lists everyone in it, and says who is waiting for what", () => {
    const { state } = setup();
    act(() => {
      state.screen.value = "lobby";
      state.lobby.value = lobby();
    });
    expect(screen.getByText("ana")).toBeTruthy();
    expect(screen.getByText("bo")).toBeTruthy();
    expect(screen.getByRole("region", { name: "2 in the lobby" })).toBeTruthy();
    expect(screen.getByText("Waiting for more players…")).toBeTruthy();
  });

  it("counts down to the instant it was given, and names the map", () => {
    const { state } = setup();
    act(() => {
      state.screen.value = "lobby";
      state.lobby.value = lobby({ map: "rust-mw2", startsAt: Date.now() + 23_400 });
    });
    // On the same side as the buttons, because the map is one of the things a
    // private match is deciding rather than part of the roster.
    expect(screen.getByText("rust-mw2")).toBeTruthy();
    // Rounded, so 23.4s reads as 23 rather than 24.
    expect(screen.getByText("0:23")).toBeTruthy();
  });

  /** The host chooses it here so that everyone already in the lobby sees the choice being made. */
  it("lets the host choose the map under Game Setup, and says so until they do", () => {
    const { state, commands } = setup();
    act(() => {
      state.worlds.value = [{ slug: "dome-mw3", name: "Dome", category: "MW3 Multiplayer" }];
      state.screen.value = "lobby";
      state.lobby.value = lobby({ private: true, host: true });
    });
    expect(screen.getByText("Waiting for the host to choose a map.")).toBeTruthy();

    fireEvent.click(screen.getByText("Game Setup"));
    fireEvent.click(screen.getByRole("button", { name: "Map" }));
    fireEvent.click(screen.getByRole("button", { name: "Dome" }));
    expect(commands.setLobbyMap).toHaveBeenCalledWith("dome-mw3");
    // Back to Game Setup, not out of it.
    expect(screen.getByRole("button", { name: "Game Mode" })).toBeTruthy();
  });

  it("lists only the maps the lobby's mode is played on", () => {
    const { state } = setup();
    act(() => {
      state.worlds.value = [
        { slug: "dome-mw3", name: "Dome", category: "MW3 Multiplayer" },
        { slug: "theater-bo1", name: "Kino der Toten", category: "BO Zombies" },
      ];
      state.screen.value = "lobby";
      state.lobby.value = lobby({ private: true, host: true, gametype: "zombies", mode: "Zombies" });
    });
    fireEvent.click(screen.getByText("Game Setup"));
    fireEvent.click(screen.getByRole("button", { name: "Map" }));
    expect(screen.getByRole("button", { name: "Kino der Toten" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Dome" })).toBeNull();
  });

  it("lets the host choose the mode under Game Setup, and tells everyone else what it is", () => {
    const { state, commands } = setup();
    act(() => {
      state.screen.value = "lobby";
      state.lobby.value = lobby({ private: true, host: true });
    });
    fireEvent.click(screen.getByText("Game Setup"));
    fireEvent.click(screen.getByRole("button", { name: "Game Mode" }));
    fireEvent.click(screen.getByRole("button", { name: "Zombies" }));
    expect(commands.setLobbyMode).toHaveBeenCalledWith("zombies");

    act(() => void (state.lobby.value = lobby({ private: true, host: false, gametype: "chase", mode: "Chase" })));
    expect(screen.queryByText("Game Setup")).toBeNull();
    expect(screen.getByText("Chase")).toBeTruthy();
  });

  it("puts the zombies picture behind the menus while the mode is Zombies", () => {
    const { state } = setup();
    act(() => {
      state.screen.value = "lobby";
      state.lobby.value = lobby({ private: true });
    });
    const shown = () => [...document.querySelectorAll("img")].filter((img) => img.className.includes("shown")).map((img) => img.getAttribute("src"));
    expect(shown()).toHaveLength(1);
    expect(shown()[0]).toContain("menu-generic");

    act(() => void (state.lobby.value = lobby({ private: true, gametype: "zombies", mode: "Zombies" })));
    expect(shown()).toHaveLength(1);
    expect(shown()[0]).toContain("menu-zombies");
  });

  it("does not offer the map to anyone but the host", () => {
    const { state } = setup();
    act(() => {
      state.screen.value = "lobby";
      state.lobby.value = lobby({ private: true, host: false });
    });
    expect(screen.queryByText("Game Setup")).toBeNull();
  });

  it("offers Start to a private lobby's host only, and the invite code to everyone", () => {
    const { state, commands } = setup();
    act(() => {
      state.screen.value = "lobby";
      state.lobby.value = lobby({ private: true, host: false });
    });
    expect(screen.getByText("BRAVO7")).toBeTruthy();
    expect(screen.queryByText("Start Match")).toBeNull();

    act(() => void (state.lobby.value = lobby({ private: true, host: true })));
    fireEvent.click(screen.getByText("Start Match"));
    expect(commands.startLobby).toHaveBeenCalled();
  });

  it("offers everyone in a private lobby its invite link in the corner, not in the menu, and copies it", async () => {
    const { state } = setup();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const invite = "http://localhost:5173/?join=BRAVO7";
    act(() => {
      state.screen.value = "lobby";
      state.lobby.value = lobby({ private: true, host: false, invite });
    });
    const column = screen.getByRole("navigation", { name: "Private Match" });
    expect(column.textContent).not.toContain("Copy Invite Link");

    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Copy Invite Link" })));
    expect(writeText).toHaveBeenCalledWith(invite);
    expect(screen.getByRole("button", { name: "Invite Link Copied" })).toBeTruthy();
    // Only printed when the clipboard cannot be reached.
    expect(screen.queryByText(invite)).toBeNull();
  });

  it("prints the link to copy by hand when the page has no clipboard", async () => {
    const { state } = setup();
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    const invite = "http://192.168.1.5:5173/?join=BRAVO7";
    act(() => {
      state.screen.value = "lobby";
      state.lobby.value = lobby({ private: true, invite });
    });
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Copy Invite Link" })));
    expect(screen.getByText(invite)).toBeTruthy();
  });

  it("has no invite link in a public lobby", () => {
    const { state } = setup();
    act(() => {
      state.screen.value = "lobby";
      state.lobby.value = lobby({ private: false });
    });
    expect(screen.queryByRole("button", { name: "Copy Invite Link" })).toBeNull();
  });

  it("lets a private host stop the countdown, and end a running match", () => {
    const { state, commands } = setup();
    act(() => {
      state.screen.value = "lobby";
      state.lobby.value = lobby({ private: true, host: true, map: "rust-mw2", startsAt: Date.now() + 10_000 });
    });
    // Once it is counting down, the map is settled: stopping is how it changes.
    expect(screen.queryByText("Game Setup")).toBeNull();
    fireEvent.click(screen.getByText("Cancel"));
    expect(commands.endLobby).toHaveBeenCalledTimes(1);

    act(() => void (state.lobby.value = lobby({ private: true, host: true, map: "rust-mw2", playing: true })));
    fireEvent.click(screen.getByText("End Match"));
    expect(commands.endLobby).toHaveBeenCalledTimes(2);
  });

  it("offers ending the match to nobody but a private lobby's host", () => {
    const { state } = setup();
    act(() => {
      state.screen.value = "lobby";
      state.lobby.value = lobby({ private: true, host: false, playing: true });
    });
    expect(screen.queryByText("End Match")).toBeNull();

    act(() => void (state.lobby.value = lobby({ private: false, host: true, playing: true })));
    expect(screen.queryByText("End Match")).toBeNull();
  });

  it("goes back to the main menu on Esc, leaving the lobby, whether private or found", () => {
    const { state, commands } = setup();
    for (const priv of [true, false]) {
      act(() => {
        state.screen.value = "lobby";
        state.lobby.value = lobby({ private: priv, host: true });
      });
      fireEvent.keyDown(window, { key: "Escape" });
    }
    expect(commands.leaveLobby).toHaveBeenCalledTimes(2);

    // Still searching, with no lobby yet: the same.
    act(() => {
      state.lobby.value = null;
      state.searching.value = true;
    });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(commands.leaveLobby).toHaveBeenCalledTimes(3);
  });

  it("backs out of the map list, then Game Setup, on Esc before it leaves anything", () => {
    const { state, commands } = setup();
    act(() => {
      state.worlds.value = [{ slug: "dome-mw3", name: "Dome", category: "MW3 Multiplayer" }];
      state.screen.value = "lobby";
      state.lobby.value = lobby({ private: true, host: true });
    });
    fireEvent.click(screen.getByText("Game Setup"));
    fireEvent.click(screen.getByRole("button", { name: "Map" }));
    expect(screen.getByRole("button", { name: "Dome" })).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("button", { name: "Dome" })).toBeNull();
    expect(screen.getByRole("button", { name: "Game Mode" })).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("button", { name: "Start Match" })).toBeTruthy();
    expect(commands.leaveLobby).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(commands.leaveLobby).toHaveBeenCalledTimes(1);
  });

  it("leaves on request", () => {
    const { state, commands } = setup();
    act(() => {
      state.screen.value = "lobby";
      state.lobby.value = lobby();
    });
    fireEvent.click(screen.getByText("Leave"));
    expect(commands.leaveLobby).toHaveBeenCalled();
  });

  it("says it is still looking while there is no lobby yet", () => {
    const { state } = setup();
    act(() => {
      state.screen.value = "lobby";
      state.searching.value = true;
    });
    expect(screen.getByText("Looking for a game…")).toBeTruthy();
  });
});

describe("screens", () => {
  it("stands down in a tab another one has displaced, and takes the player back on request", () => {
    const { state, commands } = setup();
    act(() => void (state.screen.value = "elsewhere"));
    expect(screen.getByText("The game is open somewhere else, and only one tab can play at a time.")).toBeTruthy();
    fireEvent.click(screen.getByText("Play Here"));
    expect(commands.playHere).toHaveBeenCalled();
  });

  it("gives a private match's host End Match in the pause menu, and nobody else", () => {
    const { state, commands } = setup();
    const lobby = (host: boolean) => ({
      code: "BRAVO7",
      private: true,
      map: "rust-mw2",
      mode: "Free Roam",
      gametype: "default",
      playing: true,
      startsAt: null,
      players: [],
      host,
      invite: null,
    });
    act(() => {
      state.screen.value = "world";
      state.paused.value = true;
      state.lobby.value = lobby(false);
    });
    expect(screen.queryByText("End Match")).toBeNull();

    act(() => void (state.lobby.value = lobby(true)));
    fireEvent.click(screen.getByText("End Match"));
    expect(commands.endLobby).toHaveBeenCalled();
  });

  it("follows the screen signal", () => {
    const { state } = setup();
    act(() => {
      state.loading.value = { world: { slug: "dome-mw3", name: "Dome", category: "MW3 Multiplayer" }, step: "collision", progress: 0.5 };
      state.screen.value = "loading";
    });
    expect(screen.getByRole("heading", { name: "Dome" })).toBeTruthy();
    expect(screen.getByText("MW3 Multiplayer")).toBeTruthy();
    expect(screen.getByText("collision")).toBeTruthy();
    expect(screen.queryByText("Click to play")).toBeNull();

    act(() => {
      state.error.value = { title: "dome: 1 error", detail: "world.world:3:1 bad", watching: true };
      state.screen.value = "error";
    });
    expect(screen.queryByRole("heading", { name: "Dome" })).toBeNull();
    expect(screen.getByText("world.world:3:1 bad")).toBeTruthy();
  });

  it("returns to the menu from an error", () => {
    const { state, commands } = setup();
    act(() => {
      state.error.value = { title: "x", detail: "y", watching: false };
      state.screen.value = "error";
    });
    fireEvent.click(screen.getByText("Back to menu"));
    expect(commands.returnToMenu).toHaveBeenCalled();
  });
});

describe("click to play", () => {
  function prompted(prompt: "play" | "resume") {
    const ui = setup();
    act(() => {
      ui.state.screen.value = "world";
      ui.state.worldName.value = "Dome";
      ui.state.paused.value = true;
      ui.state.prompt.value = prompt;
    });
    return ui;
  }

  it("waits over the world after loading, instead of the pause menu, for a click or Enter", () => {
    const { state, commands } = prompted("play");
    expect(screen.queryByRole("status")).toBeNull(); // the loading screen is gone
    expect(screen.queryByRole("dialog", { name: "Paused" })).toBeNull();
    expect(screen.getByText("Dome")).toBeTruthy();
    fireEvent.click(screen.getByRole("dialog", { name: "Click to play" }));
    expect(commands.resume).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "Enter" });
    expect(commands.resume).toHaveBeenCalledTimes(2);

    act(() => {
      state.prompt.value = null;
    });
    expect(screen.queryByText("Click to play")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Paused" })).toBeTruthy();
  });

  it("asks the same way when Esc could not give the mouse back", () => {
    const { commands } = prompted("resume");
    fireEvent.click(screen.getByRole("dialog", { name: "Click to resume" }));
    expect(commands.resume).toHaveBeenCalled();
  });
});

describe("pause menu", () => {
  function paused() {
    const ui = setup();
    act(() => {
      ui.state.screen.value = "world";
      ui.state.worldName.value = "Dome";
      ui.state.paused.value = true;
      ui.state.controls.value = [
        { label: "Jump", keys: "Space", dev: false },
        { label: "Inspector", keys: "`", dev: true },
      ];
    });
    return ui;
  }

  it("resumes from the button, not from a click elsewhere", () => {
    const { commands } = paused();
    fireEvent.click(screen.getByText("Resume Game"));
    expect(commands.resume).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("dialog"));
    fireEvent.click(screen.getByRole("navigation", { name: "Paused" }));
    expect(commands.resume).toHaveBeenCalledTimes(1);
  });

  it("closes an open panel on Esc, keeping that Esc from the game", () => {
    paused();
    const game = vi.fn();
    window.addEventListener("keydown", game);
    fireEvent.click(screen.getByText("Options"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(game).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" }); // no panel: the game's to handle
    expect(game).toHaveBeenCalledTimes(1);
    window.removeEventListener("keydown", game);
  });

  it("names the world, and leaves it", () => {
    const { commands } = paused();
    expect(screen.getByRole("heading", { name: "Dome" })).toBeTruthy();
    fireEvent.click(screen.getByText("Leave Game"));
    expect(commands.returnToMenu).toHaveBeenCalled();
  });

  it("marks the current quality under Options and sets a new one", () => {
    const { state, commands } = paused();
    act(() => {
      state.quality.value = "medium";
    });
    expect(screen.queryByRole("radio", { name: "medium" })).toBeNull();
    fireEvent.click(screen.getByText("Options"));
    expect(screen.getByRole("radio", { name: "medium" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "low" }));
    expect(commands.setQuality).toHaveBeenCalledWith("low");
  });

  it("lists dev controls only when debug is enabled", () => {
    const { state } = paused();
    fireEvent.click(screen.getByText("Controls"));
    expect(screen.getByText("Jump")).toBeTruthy();
    expect(screen.queryByText("Inspector")).toBeNull();
    act(() => {
      state.debug.enabled.value = true;
    });
    expect(screen.getAllByText("Inspector").length).toBeGreaterThan(0);
  });

  it("shows the whole map with the player on it", () => {
    const { state } = paused();
    expect(screen.queryByTestId("pause-map")).toBeNull();
    act(() => {
      state.minimap.map.value = { image: "/worlds/dome-mw3/assets/minimap.png", width: 1.25, height: 1.5 };
    });
    const marker = screen.getByTestId("pause-map").querySelector<HTMLElement>("[hidden]")!;
    expect(marker).toBeTruthy(); // no pose: not walking
    act(() => {
      state.minimap.pose.value = { u: 0.25, v: 0.5, rotation: 1 };
    });
    expect(marker.hidden).toBe(false);
    expect([marker.style.left, marker.style.top]).toEqual(["25%", "50%"]);
    expect(marker.style.getPropertyValue("--heading")).toBe("-1rad");
    act(() => {
      state.minimap.pose.value = { u: 1.4, v: -0.2, rotation: 0 };
    });
    expect([marker.style.left, marker.style.top]).toEqual(["100%", "0%"]);
  });

  it("disappears on resume", () => {
    const { state } = paused();
    act(() => {
      state.paused.value = false;
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("minimap", () => {
  it("shows the world's map while walking and turns it under the player", () => {
    const { state } = setup();
    act(() => {
      state.screen.value = "world";
    });
    expect(screen.queryByTestId("minimap")).toBeNull();

    act(() => {
      state.minimap.map.value = { image: "/worlds/dome-mw3/assets/minimap.png", width: 1.25, height: 1.5 };
    });
    const frame = screen.getByTestId("minimap");
    const image = frame.querySelector("img")!;
    expect(frame.hidden).toBe(true); // no pose: not walking
    expect(image.getAttribute("src")).toBe("/worlds/dome-mw3/assets/minimap.png");
    expect(image.style.width).toBe("125%");
    expect(image.style.height).toBe("150%");

    act(() => {
      state.minimap.pose.value = { u: 0.25, v: 0.5, rotation: 1 };
    });
    expect(frame.hidden).toBe(false);
    expect(image.style.transform).toBe("rotate(1rad) translate(-25%, -50%)");

    act(() => {
      state.minimap.pose.value = null;
    });
    expect(frame.hidden).toBe(true);
  });
});

describe("hud", () => {
  /** In a world, on foot, with a server answering: what `Hud` writes and nothing more. */
  function playing(over: Partial<HudPlayerInfo> = {}) {
    const ui = setup();
    act(() => {
      ui.state.screen.value = "world";
      ui.state.hud.player.value = { health: 100, maxHealth: 100, dead: false, respawnIn: 0, weapon: { name: "M4A1", ammo: 30, reloading: false }, ...over };
    });
    return ui;
  }

  it("draws nothing at all until there is a player to draw it for", () => {
    const { state } = setup();
    act(() => {
      state.screen.value = "world";
    });
    expect(screen.queryByTestId("crosshair")).toBeNull();
    expect(screen.queryByTestId("hud-health")).toBeNull();
    expect(screen.queryByTestId("hud-ammo")).toBeNull();
  });

  it("puts a crosshair up while walking, and takes it down while paused", () => {
    const { state } = playing();
    expect(screen.getByTestId("crosshair")).toBeTruthy();
    act(() => {
      state.paused.value = true;
    });
    // A crosshair over the pause menu is aiming at nothing.
    expect(screen.queryByTestId("crosshair")).toBeNull();
  });

  it("opens the crosshair by the weapon's cone, and closes it again", () => {
    // `hud.cone` is the cone's radius as a fraction of half the viewport height
    // (app/uiBridge.ts), so the widget hands it to `calc()` and needs no camera.
    // A settled weapon reads 0 and the arms sit at their fixed gap.
    const { state } = playing();
    expect(screen.getByTestId("crosshair").style.getPropertyValue("--cone")).toBe("0");

    act(() => {
      state.hud.cone.value = 0.08;
    });
    expect(screen.getByTestId("crosshair").style.getPropertyValue("--cone")).toBe("0.08");

    act(() => {
      state.hud.cone.value = 0;
    });
    expect(screen.getByTestId("crosshair").style.getPropertyValue("--cone")).toBe("0");
  });

  it("fades the crosshair out as the sights come up, and has it gone before they arrive", () => {
    // Aiming replaces the crosshair with the weapon's own sights; one still on
    // screen at a full aim is a second reticle beside the real one. The hit
    // marker is deliberately not part of the fade — a scoped shot still has to
    // say that it counted.
    const { state } = playing();
    expect(screen.getByTestId("crosshair").style.opacity).toBe("1");

    act(() => {
      state.hud.ads.value = 0.425;
    });
    expect(Number(screen.getByTestId("crosshair").style.opacity)).toBeCloseTo(0.5, 6);

    act(() => {
      state.hud.ads.value = 0.9;
    });
    expect(screen.queryByTestId("crosshair")).toBeNull();

    act(() => {
      state.hud.ads.value = 0;
    });
    expect(screen.getByTestId("crosshair").style.opacity).toBe("1");
  });

  it("marks a hit the server confirmed, and marks a kill differently", () => {
    const { state } = playing();
    expect(screen.queryByTestId("hit-marker")).toBeNull();

    act(() => {
      state.hud.hit.value = { id: 1, lethal: false };
    });
    const first = screen.getByTestId("hit-marker");
    expect(screen.queryByTestId("hit-marker-lethal")).toBeNull();

    act(() => {
      state.hud.hit.value = { id: 2, lethal: false };
    });
    // A different element, because the flash is a CSS animation and a reused node
    // would carry on the one already under way: two rounds are two marks.
    expect(screen.getByTestId("hit-marker")).not.toBe(first);

    act(() => {
      state.hud.hit.value = { id: 3, lethal: true };
    });
    expect(screen.getByTestId("hit-marker-lethal")).toBeTruthy();
  });

  it("shows the health the server reported, as a count and as a fraction of the match's ceiling", () => {
    const { state } = playing({ health: 30, maxHealth: 120 });
    expect(screen.getByTestId("hud-health").textContent).toBe("30");
    expect(screen.getByTestId("hud-health-fill").style.width).toBe("25%");

    // The ceiling is the match's, not a hundred: the same 30 out of 30 is a full bar.
    act(() => {
      state.hud.player.value = { ...state.hud.player.value!, maxHealth: 30 };
    });
    expect(screen.getByTestId("hud-health-fill").style.width).toBe("100%");
  });

  it("shows the magazine, and says so while it is being filled", () => {
    const { state } = playing();
    expect(screen.getByTestId("hud-ammo").textContent).toBe("30M4A1");
    act(() => {
      state.hud.player.value = { ...state.hud.player.value!, weapon: { name: "M4A1", ammo: 0, reloading: true } };
    });
    expect(screen.getByTestId("hud-ammo").textContent).toBe("0Reloading");
  });

  it("says they are down, and counts them back in, instead of a crosshair over a corpse", () => {
    const { state } = playing({ dead: true, health: 0, respawnIn: 2.6 });
    expect(screen.queryByTestId("crosshair")).toBeNull();
    expect(screen.getByText("respawning in 2.6s")).toBeTruthy();
    // And the health bar is not saying it a second time in the corner.
    expect(screen.queryByTestId("hud-health")).toBeNull();

    act(() => {
      state.hud.player.value = { ...state.hud.player.value!, dead: false, health: 100, respawnIn: 0 };
    });
    expect(screen.getByTestId("crosshair")).toBeTruthy();
  });

  it("lists the kill feed newest first, and marks the lines this player is in", () => {
    const { state } = playing();
    expect(screen.queryByTestId("kill-feed")).toBeNull();

    act(() => {
      state.hud.feed.value = [
        { id: 3, killer: "Someone", victim: "Alex", mine: true, how: null },
        { id: 2, killer: null, victim: "Someone", mine: false, how: "fell out of the world" },
      ];
    });
    const lines = screen.getByTestId("kill-feed").querySelectorAll("li");
    // A suicide has nobody to put first, so it says how instead.
    expect([...lines].map((line) => line.textContent)).toEqual(["Someone▸Alex", "☠Someonefell out of the world"]);
    // The player's own line is drawn differently; the other is not.
    expect(lines[0]!.className).not.toBe(lines[1]!.className);
  });

  it("shows the use prompt with the bound key in it, and nothing while paused", () => {
    const { state } = playing();
    expect(screen.queryByTestId("use-prompt")).toBeNull();
    act(() => {
      state.hud.use.value = { text: "Press {key} to open the door [Cost: 1000]", key: "F", thing: { kind: "trigger", index: 3, tags: ["zombie_door"] } };
    });
    const prompt = screen.getByTestId("use-prompt");
    expect(prompt.querySelector("kbd")!.textContent).toBe("F");
    expect(prompt.textContent).toContain("Press F to open the door [Cost: 1000]");
    act(() => {
      state.paused.value = true;
    });
    expect(screen.queryByTestId("use-prompt")).toBeNull();
  });

  it("names the focused thing in a development build, even where the script shows nothing", () => {
    const { state } = playing();
    act(() => {
      state.hud.use.value = { text: null, key: "F", thing: { kind: "solid", index: 7, tags: ["crate"] } };
    });
    expect(screen.queryByTestId("use-prompt")).toBeNull();
    act(() => {
      state.debug.enabled.value = true;
    });
    expect(screen.getByTestId("use-prompt").textContent).toBe("solid 7 · crate");
  });

  it("shows the gametype's counters and this player's points, and neither where there are none", () => {
    const { state } = playing();
    expect(screen.queryByTestId("hud-counters")).toBeNull();
    expect(screen.queryByTestId("hud-points")).toBeNull();
    act(() => {
      state.hud.counters.value = [{ name: "round", value: 4 }];
      state.hud.points.value = 1250;
    });
    expect(screen.getByTestId("hud-counters").textContent).toBe("round4");
    expect(screen.getByTestId("hud-points").textContent).toBe("1250");
  });

  it("says a player the gametype brings back is waiting, rather than counting", () => {
    playing({ dead: true, health: 0, respawnIn: null });
    expect(screen.getByText("waiting to be brought back")).toBeTruthy();
  });
});

describe("debug overlay", () => {
  it("shows the inspector only while it is on, and what it picked", () => {
    const { state } = setup();
    act(() => {
      state.screen.value = "world";
      state.debug.enabled.value = true;
    });
    expect(screen.queryByText("Inspector")).toBeNull();
    act(() => {
      state.debug.inspector.value = null;
    });
    expect(screen.getByText("Inspector")).toBeTruthy();
    act(() => {
      state.debug.inspector.value = { title: "com_barrel", rows: [["at", "1, 2, 3"]], hint: "Click to pin", pinned: false, collider: false };
    });
    expect(screen.getByText("com_barrel")).toBeTruthy();
    expect(screen.getByText("1, 2, 3")).toBeTruthy();
  });
});

describe("create a class", () => {
  const weapon = (id: string, name: string, game: string, category: WeaponCategory, attachments: { id: string; name: string }[] = []) => ({
    id,
    name,
    game,
    kind: "",
    slot: CATEGORY_SLOT[category],
    category,
    attachments,
  });
  const M4 = weapon("iw5/iw5_m4_mp", "M4 Carbine", "iw5", "assault", [
    { id: "acog", name: "ACOG" },
    { id: "silencer", name: "Silencer" },
  ]);
  const MP5 = weapon("iw5/iw5_mp5_mp", "MP5", "iw5", "smg");
  const USP = weapon("iw5/iw5_usp45_mp", "USP 45", "iw5", "handgun");
  const G18 = weapon("iw5/iw5_g18_mp", "G18", "iw5", "machinePistol");
  const AK = weapon("iw4/ak47_mp", "AK-47", "iw4", "assault");

  function classes() {
    const { state, commands } = setup();
    act(() => {
      state.weapons.value = [M4, MP5, USP, G18, AK];
      state.loadouts.value = [
        { name: "Assault", game: "iw5", primary: { weapon: M4.id, attachments: ["acog"] }, secondary: { weapon: null, attachments: [] } },
        ...defaultLoadouts().slice(1),
      ];
      state.screen.value = "classes";
    });
    return { state, commands };
  }
  const saved = (commands: UiCommands) => (commands.saveLoadout as ReturnType<typeof vi.fn>).mock.calls.at(-1) as [number, Loadout];

  it("lists the five classes and edits none of them until one is clicked", () => {
    classes();
    expect(screen.getByRole("button", { name: "Assault" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Class 5" })).toBeTruthy();
    expect(screen.getByText("Choose a class to edit.")).toBeTruthy();
  });

  it("opens a class by clicking it, not by hovering it", () => {
    classes();
    const assault = screen.getByRole("button", { name: "Assault" });
    fireEvent.mouseEnter(assault);
    fireEvent.focus(assault);
    expect(screen.queryByLabelText("Class name")).toBeNull();
    // Hovering does say what the class carries.
    expect(screen.getByText("MW3 — M4 Carbine / Nothing")).toBeTruthy();
    fireEvent.click(assault);
    expect(screen.getByLabelText("Class name")).toBeTruthy();
    expect(screen.getByRole("button", { name: /M4 Carbine/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "ACOG", pressed: true })).toBeTruthy();
  });

  it("asks for a game before any weapon", () => {
    classes();
    fireEvent.click(screen.getByRole("button", { name: "Class 2" }));
    expect(screen.getAllByRole("button", { name: "Choose a game first" }).every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });

  it("empties both slots when the game changes, since no weapon is in two", () => {
    const { commands } = classes();
    fireEvent.click(screen.getByRole("button", { name: "Assault" }));
    fireEvent.click(screen.getByRole("radio", { name: "MW2" }));
    const [index, loadout] = saved(commands);
    expect(index).toBe(0);
    expect(loadout).toMatchObject({ game: "iw4", primary: { weapon: null }, secondary: { weapon: null } });
  });

  it("offers only the class's game's weapons, by the categories that belong to the slot", () => {
    const { commands } = classes();
    fireEvent.click(screen.getByRole("button", { name: "Assault" }));
    fireEvent.click(screen.getByRole("button", { name: /M4 Carbine/ }));
    const tabs = screen.getAllByRole("tab").map((tab) => tab.textContent);
    expect(tabs).toEqual(["SMG", "Assault Rifle"]);
    // The current weapon's category is open first, and another game's rifle is not in it.
    expect(screen.getByRole("tab", { name: "Assault Rifle", selected: true })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "AK-47" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "SMG" }));
    fireEvent.click(screen.getByRole("button", { name: "MP5" }));
    expect(saved(commands)[1].primary).toEqual({ weapon: MP5.id, attachments: [] });
  });

  it("puts handguns and machine pistols under the secondary", () => {
    const { commands } = classes();
    fireEvent.click(screen.getByRole("button", { name: "Assault" }));
    // The empty secondary reads as "None"; the primary already names the M4.
    fireEvent.click(screen.getByRole("button", { name: "None" }));
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Handgun", "Machine Pistol"]);
    fireEvent.click(screen.getByRole("button", { name: "USP 45" }));
    expect(saved(commands)[1].secondary).toEqual({ weapon: USP.id, attachments: [] });
  });

  /** One attachment for now, so picking a second replaces the first rather than being refused. */
  it("fits an attachment, and a second one takes the first's place", () => {
    const { commands } = classes();
    fireEvent.click(screen.getByRole("button", { name: "Assault" }));
    fireEvent.click(screen.getByRole("button", { name: "Silencer" }));
    expect(saved(commands)[1].primary.attachments).toEqual(["silencer"]);
  });

  it("takes an attachment off when it is pressed again", () => {
    const { commands } = classes();
    fireEvent.click(screen.getByRole("button", { name: "Assault" }));
    fireEvent.click(screen.getByRole("button", { name: "ACOG" }));
    expect(saved(commands)[1].primary.attachments).toEqual([]);
  });

  it("goes back on Esc: out of the weapon list first, then out of the screen", () => {
    const { commands } = classes();
    fireEvent.click(screen.getByRole("button", { name: "Assault" }));
    fireEvent.click(screen.getByRole("button", { name: /M4 Carbine/ }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("tab")).toBeNull();
    expect(commands.closeClasses).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(commands.closeClasses).toHaveBeenCalled();
  });

  it("is reached from a lobby too", () => {
    const { state, commands } = setup();
    act(() => {
      state.screen.value = "lobby";
    });
    fireEvent.click(screen.getByRole("button", { name: "Create a Class" }));
    expect(commands.openClasses).toHaveBeenCalled();
  });

  it("says so when there is no catalogue to pick from", () => {
    const { state } = setup();
    act(() => {
      state.weapons.value = [];
      state.screen.value = "classes";
    });
    expect(screen.getByText(/No weapons in the catalogue/)).toBeTruthy();
  });
});

describe("joining a match", () => {
  /** Nobody plays before choosing a class, so there is nothing to click until the server has answered. */
  it("waits over the world with nothing to click, and Esc still reaches the pause menu", () => {
    const { state, commands } = setup();
    act(() => {
      state.screen.value = "world";
      state.worldName.value = "Dome";
      state.prompt.value = "joining";
    });
    const prompt = screen.getByRole("dialog", { name: "Joining the match…" });
    expect(prompt.textContent).toContain("Dome");
    // A click asks the app to resume, which keeps the prompt up while it waits (App.resume).
    fireEvent.click(prompt);
    expect(commands.resume).toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Click to play" })).toBeNull();
  });
});

describe("choosing a class in a match", () => {
  function inMatch(choice: "spawn" | "change") {
    const { state, commands } = setup();
    act(() => {
      state.screen.value = "world";
      state.paused.value = true;
      state.loadouts.value = defaultLoadouts();
      state.playingClass.value = choice === "change" ? 0 : null;
      state.classChoice.value = choice;
    });
    return { state, commands };
  }

  it("comes up over everything on joining, and chooses by clicking", () => {
    const { commands } = inMatch("spawn");
    expect(screen.getByRole("dialog", { name: "Choose Class" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Paused" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Class 3" }));
    expect(commands.chooseClass).toHaveBeenCalledWith(2);
  });

  it("has no way back on joining, only out", () => {
    const { commands } = inMatch("spawn");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(commands.closeClassChoice).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Leave Game" }));
    expect(commands.returnToMenu).toHaveBeenCalled();
  });

  it("marks the class in hand and the one waiting, and says when a change applies", () => {
    const { state } = inMatch("change");
    act(() => {
      state.pendingClass.value = 1;
    });
    expect(screen.getByRole("button", { name: "Class 1 (current)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Class 2 (next)" })).toBeTruthy();
    expect(screen.getByText(/takes effect when you next spawn/)).toBeTruthy();
  });

  it("goes back to the pause menu on Esc or Back when changing", () => {
    const { commands } = inMatch("change");
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(commands.closeClassChoice).toHaveBeenCalledTimes(2);
  });

  it("is offered in the pause menu in a match that lets players choose, and not otherwise", () => {
    const { state, commands } = setup();
    act(() => {
      state.screen.value = "world";
      state.paused.value = true;
    });
    expect(screen.queryByRole("button", { name: "Choose Class" })).toBeNull();
    act(() => {
      state.canChooseClass.value = true;
    });
    fireEvent.click(screen.getByRole("button", { name: "Choose Class" }));
    expect(commands.openClassChoice).toHaveBeenCalled();
  });
});
