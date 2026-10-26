// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentState, HistoryEntry } from "./agent";

mockWindows("main");
mockIPC(() => new Promise(() => {}));
const { default: App } = await import("./App");
const agent = await import("./agent");
const notifications = await import("./toast");
const scrollToDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");

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

/** Resume a session whose history the sidecar returns as given. */
async function resume(history: HistoryEntry[]): Promise<void> {
  vi.spyOn(agent, "subscribe").mockImplementation(() => () => {});
  const state: AgentState = {
    cwd: "/workspaces/ken-prompt",
    mode: "code",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    running: false,
  };
  mockWindows("main");
  mockIPC((command) => {
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
      case "plugin:log|log":
        return null;
      default:
        return new Promise(() => {});
    }
  });
  render(<App />);
  await screen.findByRole<HTMLTextAreaElement>("textbox");
}

const KEN_REPLY: HistoryEntry = {
  role: "assistant",
  ken: true,
  text: "Send this:\n\n```prompt\nAdd a retry to the upload\n```",
};

describe("Ken prompt block on resume", () => {
  it("shows Sent for a prompt sent after the Ken bubble (e.g. from the glasses)", async () => {
    await resume([
      { role: "user", ken: true, text: "what next?" },
      KEN_REPLY,
      // The sidecar restores meta.kenSent from the user_hint marker.
      { role: "user", kenSent: true, text: "Add a retry to the upload" },
      { role: "assistant", text: "Added the retry." },
    ]);
    const button = await screen.findByRole<HTMLButtonElement>("button", { name: /^sent$/i });
    expect(button.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /send to gg coder/i })).toBeNull();
    // Rendered once, as the same "Sent to GG Coder" row a click gives.
    await waitFor(() => expect(screen.getAllByText("Sent to GG Coder")).toHaveLength(1));
  });

  it("stays Send when the prompt was never sent", async () => {
    await resume([{ role: "user", ken: true, text: "what next?" }, KEN_REPLY]);
    const button = await screen.findByRole<HTMLButtonElement>("button", {
      name: /send to gg coder/i,
    });
    expect(button.disabled).toBe(false);
    expect(screen.queryByText("Sent to GG Coder")).toBeNull();
  });

  it("ignores an identical send from BEFORE the Ken bubble", async () => {
    await resume([
      { role: "user", kenSent: true, text: "Add a retry to the upload" },
      { role: "assistant", text: "Done." },
      { role: "user", ken: true, text: "again?" },
      KEN_REPLY,
    ]);
    const button = await screen.findByRole<HTMLButtonElement>("button", {
      name: /send to gg coder/i,
    });
    expect(button.disabled).toBe(false);
  });
});
