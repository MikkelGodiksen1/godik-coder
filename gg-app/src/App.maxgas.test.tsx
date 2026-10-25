// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentState } from "./agent";
import { wrapMaxGas } from "./max-gas";

mockWindows("main");
mockIPC(() => new Promise(() => {}));
const { default: App } = await import("./App");
const agent = await import("./agent");
const notifications = await import("./toast");
const scrollToDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");

const MAX_GAS_ON = "Max Gas: send the task to Ken for a production-run prompt";
const MAX_GAS_OFF = "Max Gas off: send to GG as usual";

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
    cwd: "/workspaces/max-gas",
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

describe("deck Max Gas key", () => {
  it("is off by default and shows a flag while on, without touching the draft", async () => {
    const { input } = await setup();
    expect(screen.queryByText("Max Gas", { selector: ".deck-flag" })).toBeNull();
    fireEvent.change(input, { target: { value: "keep me" } });
    fireEvent.click(screen.getByTitle(MAX_GAS_ON));
    expect(screen.getByText("Max Gas", { selector: ".deck-flag" })).toBeTruthy();
    expect(screen.getByTitle(MAX_GAS_OFF).getAttribute("aria-pressed")).toBe("true");
    expect(input.value).toBe("keep me");
    fireEvent.click(screen.getByTitle(MAX_GAS_OFF));
    expect(screen.queryByText("Max Gas", { selector: ".deck-flag" })).toBeNull();
    expect(input.value).toBe("keep me");
  });

  it("sends the wrapped task to Ken while on, and to GG as usual once off", async () => {
    const ken = vi.spyOn(agent, "sendKenPrompt").mockResolvedValue(undefined);
    const { input, sends } = await setup();

    fireEvent.click(screen.getByTitle(MAX_GAS_ON));
    fireEvent.change(input, { target: { value: "Ship the invoice export" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(ken).toHaveBeenCalledExactlyOnceWith(wrapMaxGas("Ship the invoice export"), []),
    );
    expect(sends).not.toHaveBeenCalled();
    await waitFor(() => expect(input.value).toBe(""));

    fireEvent.click(screen.getByTitle(MAX_GAS_OFF));
    fireEvent.change(input, { target: { value: "and now a normal message" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(sends).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ text: "and now a normal message" }),
      ),
    );
    expect(ken).toHaveBeenCalledTimes(1);
  });

  it("takes a leading @Mentor off before wrapping", async () => {
    const ken = vi.spyOn(agent, "sendKenPrompt").mockResolvedValue(undefined);
    const { input, sends } = await setup();
    fireEvent.click(screen.getByTitle(MAX_GAS_ON));
    fireEvent.change(input, { target: { value: "@Mentor hvad siger du?" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(ken).toHaveBeenCalledExactlyOnceWith(wrapMaxGas("hvad siger du?"), []),
    );
    expect(sends).not.toHaveBeenCalled();
  });
});
