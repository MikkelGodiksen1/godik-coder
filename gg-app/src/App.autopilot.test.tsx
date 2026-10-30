// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentState, HistoryEntry, SidecarEvent } from "./agent";

mockWindows("main");
mockIPC(() => new Promise(() => {}));
const { default: App } = await import("./App");
const agent = await import("./agent");
const notifications = await import("./toast");
const scrollToDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");

const KEY_OFF = "Autopilot: let Ken review and steer each turn";
const KEY_ON = "Autopilot on: Ken reviews each turn (rules in .gg/autopilot-rules.md)";

beforeEach(() => {
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: false,
    media,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  vi.spyOn(notifications, "toast").mockReturnValue(1);
});
afterEach(() => {
  cleanup();
  clearMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  if (scrollToDescriptor)
    Object.defineProperty(HTMLElement.prototype, "scrollTo", scrollToDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
});

interface Window {
  emit: (type: string, data: Record<string, unknown>) => void;
  toggles: ReturnType<typeof vi.fn>;
}

async function setup(history: HistoryEntry[] = [], autopilot = false): Promise<Window> {
  const listeners = new Set<(e: SidecarEvent) => void>();
  vi.spyOn(agent, "subscribe").mockImplementation((onEvent) => {
    listeners.add(onEvent);
    return () => {
      listeners.delete(onEvent);
    };
  });
  const toggles = vi.fn();
  const state: AgentState = {
    cwd: "/workspaces/autopilot",
    mode: "code",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    running: false,
    autopilot,
  };
  mockWindows("main");
  mockIPC((command, payload) => {
    switch (command) {
      case "window_restore_target":
        return { mode: "code", cwd: state.cwd, sessionPath: null };
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
        return { history };
      case "agent_autopilot_set": {
        const enabled = (payload as { enabled: boolean }).enabled;
        toggles(enabled);
        return { autopilot: enabled };
      }
      case "plugin:log|log":
        return null;
      default:
        return new Promise(() => {});
    }
  });
  render(<App />);
  await screen.findByRole<HTMLTextAreaElement>("textbox");
  await waitFor(() => expect(document.querySelector(".footer-skeleton")).toBeNull());
  const emit = (type: string, data: Record<string, unknown>): void => {
    act(() => {
      for (const listener of listeners) listener({ type, data } as SidecarEvent);
    });
  };
  return { emit, toggles };
}

describe("deck Autopilot key", () => {
  it("toggles the existing Autopilot and reflects it in aria-pressed", async () => {
    const { toggles } = await setup();
    const off = screen.getByTitle(KEY_OFF);
    expect(off.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(off);
    await waitFor(() => expect(toggles).toHaveBeenCalledExactlyOnceWith(true));
    expect(screen.getByTitle(KEY_ON).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByTitle(KEY_ON));
    await waitFor(() => expect(toggles).toHaveBeenLastCalledWith(false));
    expect(toggles).toHaveBeenCalledTimes(2);
    expect(screen.getByTitle(KEY_OFF).getAttribute("aria-pressed")).toBe("false");
  });

  it("starts pressed when the project already has Autopilot on", async () => {
    await setup([], true);
    expect(screen.getByTitle(KEY_ON).getAttribute("aria-pressed")).toBe("true");
  });
});

describe("Autopilot prompted bubble", () => {
  it("names the user's rule that fired", async () => {
    const { emit } = await setup([], true);
    emit("autopilot_prompted", {
      round: 1,
      body: "Fix the failing test and rerun it",
      rule: "tests red",
    });
    expect(await screen.findByText(/Your rule "tests red" fired\./)).toBeTruthy();
    expect(screen.getByText(/Fix the failing test and rerun it/)).toBeTruthy();
  });

  it("keeps the usual copy when no rule fired", async () => {
    const { emit } = await setup([], true);
    emit("autopilot_prompted", { round: 1, body: "Add the missing test" });
    expect(await screen.findByText(/Sending GG Coder back in/)).toBeTruthy();
    expect(screen.queryByText(/Your rule/)).toBeNull();
  });

  it("names the rule on a resumed session too", async () => {
    await setup([
      { role: "user", text: "add a login form" },
      {
        role: "assistant",
        text: "",
        autopilot: { phase: "prompted", body: "Fix the lint errors", rule: "lint red" },
      },
    ]);
    expect(await screen.findByText(/Your rule "lint red" fired\./)).toBeTruthy();
  });
});
