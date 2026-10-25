// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentState } from "./agent";

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

async function setup(): Promise<{ input: HTMLTextAreaElement; sends: ReturnType<typeof vi.fn> }> {
  vi.spyOn(agent, "subscribe").mockImplementation(() => () => {});
  const sends = vi.fn();
  const state: AgentState = {
    cwd: "/workspaces/mentor",
    mode: "code",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    running: false,
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
        return { history: [] };
      case "agent_prompt":
        sends(payload);
        return null;
      case "plugin:log|log":
        return null;
      default:
        return new Promise(() => {});
    }
  });
  render(<App />);
  const input = await screen.findByRole<HTMLTextAreaElement>("textbox");
  await waitFor(() => expect(document.querySelector(".footer-skeleton")).toBeNull());
  return { input, sends };
}

describe("deck Mentor key", () => {
  it("fills an empty composer with the default question selected, and Enter sends it", async () => {
    const ken = vi.spyOn(agent, "sendKenPrompt").mockResolvedValue(undefined);
    const { input, sends } = await setup();
    expect(input.value).toBe("");
    fireEvent.click(screen.getByTitle("Write to Ken, your mentor"));
    expect(input.value).toBe("@Mentor hvad siger du?");
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(input.selectionStart).toBe("@Mentor ".length);
    expect(input.selectionEnd).toBe("@Mentor hvad siger du?".length);
    expect(input.value.slice(input.selectionStart, input.selectionEnd)).toBe("hvad siger du?");

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(ken).toHaveBeenCalledExactlyOnceWith("hvad siger du?", []));
    expect(sends).not.toHaveBeenCalled();
  });

  it("toggling off the untouched default question clears the composer", async () => {
    const { input } = await setup();
    fireEvent.click(screen.getByTitle("Write to Ken, your mentor"));
    expect(input.value).toBe("@Mentor hvad siger du?");
    fireEvent.click(screen.getByTitle("Stop writing to Ken"));
    expect(input.value).toBe("");
  });

  it("only prepends @Mentor to an existing draft, caret at the end", async () => {
    const { input } = await setup();
    fireEvent.change(input, { target: { value: "why is this slow?" } });
    fireEvent.click(screen.getByTitle("Write to Ken, your mentor"));
    expect(input.value).toBe("@Mentor why is this slow?");
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(input.selectionStart).toBe(input.value.length);
    expect(input.selectionEnd).toBe(input.value.length);
  });
});
