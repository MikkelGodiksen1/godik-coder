// @vitest-environment jsdom
// GODIK CODER: World is hidden (brand.ts WORLD_ENABLED = false). No entry point
// may show it: not Home's World plate or its New tag, not the usage panel's key.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentState } from "./agent";
import { WORLD_ENABLED } from "./brand";

mockWindows("main");
mockIPC(() => new Promise(() => {}));
const { default: App } = await import("./App");

const scrollToDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
beforeEach(() => {
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: false,
    media,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
});
afterEach(() => {
  cleanup();
  if (scrollToDescriptor) {
    Object.defineProperty(HTMLElement.prototype, "scrollTo", scrollToDescriptor);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  }
  clearMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const PROGRESS = {
  level: 3,
  rankName: "Rookie",
  tier: 0,
  tierName: "Bronze",
  tierGlyph: "",
  effectId: "",
  xp: 120,
  xpIntoLevel: 20,
  xpForLevel: 100,
  percent: 20,
  streak: { current: 0, best: 0 },
  totals: { prompts: 0, commits: 0, linesShipped: 0, projects: 0 },
  xpBySource: { prompts: 0, commits: 0, streakBonus: 0 },
  memberSince: "2026-01-01",
  ladder: [],
  levelUp: null,
};

describe("World is hidden in GODIK CODER", () => {
  it("is switched off", () => {
    expect(WORLD_ENABLED).toBe(false);
  });

  it("shows no World plate or New tag on Home", async () => {
    mockWindows("main");
    mockIPC((command) => {
      switch (command) {
        case "window_restore_target":
          return null;
        case "sidecar_port":
          return 12345;
        case "plugin:log|log":
          return null;
        default:
          return new Promise(() => {});
      }
    });
    render(<App />);
    expect(await screen.findByRole("button", { name: "Motion" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "World" })).toBeNull();
    expect(screen.queryByText("New")).toBeNull();
    expect(document.querySelector(".home")?.textContent).not.toMatch(/World/);
    expect(document.querySelector(".world-overlay")).toBeNull();
  });

  it("shows no World key in the open usage panel", async () => {
    const cwd = "/workspaces/no-world";
    const state: AgentState = {
      cwd,
      mode: "code",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      running: false,
    };
    mockWindows("main");
    mockIPC((cmd) => {
      switch (cmd) {
        case "window_restore_target":
          return { mode: "code", cwd, sessionPath: null };
        case "sidecar_port":
          return 12345;
        case "agent_state":
          return state;
        case "agent_models":
          return { models: [{ id: state.model, provider: state.provider }] };
        case "agent_commands":
          return { commands: [] };
        case "agent_tasks":
          return { tasks: [] };
        case "agent_history":
          return { history: [] };
        case "agent_progress":
          return PROGRESS;
        default:
          return new Promise(() => {});
      }
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Usage$/ }));
    // The panel is open: its scorecard key is there, World's isn't.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Level 3, Rookie/ })).toBeTruthy(),
    );
    expect(screen.queryByRole("button", { name: "World" })).toBeNull();
    expect(screen.queryByTitle("World: play the 3D game")).toBeNull();
    expect(document.querySelector(".world-overlay")).toBeNull();
  });
});
