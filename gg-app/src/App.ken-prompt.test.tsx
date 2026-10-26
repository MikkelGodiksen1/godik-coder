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

interface Resumed {
  /** Deliver a sidecar event to the window, as the SSE stream would. */
  emit: (type: string, data: Record<string, unknown>) => void;
  /** Payloads of the `agent_prompt` calls this window made. */
  sends: ReturnType<typeof vi.fn>;
}

/** Resume a session whose history the sidecar returns as given. */
async function resume(history: HistoryEntry[]): Promise<Resumed> {
  // Several parts of the window subscribe; deliver to all of them, like the
  // real event stream.
  const listeners = new Set<(e: SidecarEvent) => void>();
  vi.spyOn(agent, "subscribe").mockImplementation((onEvent) => {
    listeners.add(onEvent);
    return () => {
      listeners.delete(onEvent);
    };
  });
  const sends = vi.fn();
  const state: AgentState = {
    cwd: "/workspaces/ken-prompt",
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
        return { history };
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
  await screen.findByRole<HTMLTextAreaElement>("textbox");
  await waitFor(() => expect(document.querySelector(".footer-skeleton")).toBeNull());
  const emit = (type: string, data: Record<string, unknown>): void => {
    act(() => {
      for (const listener of listeners) listener({ type, data } as SidecarEvent);
    });
  };
  return { emit, sends };
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

// Live, without a reload: the sidecar announces every accepted /prompt
// (prompt_accepted). A window adds the row only for prompts it didn't send
// itself, matched by the id sendPrompt attaches, never by text.
describe("Ken prompt block live", () => {
  const ASKED: HistoryEntry = { role: "user", ken: true, text: "what next?" };

  it("turns Sent when another client (the glasses) sends the prompt", async () => {
    const { emit } = await resume([ASKED, KEN_REPLY]);
    await screen.findByRole("button", { name: /send to gg coder/i });

    emit("prompt_accepted", {
      id: "glasses-1",
      text: "Add a retry to the upload",
      kenSent: true,
      queued: false,
      attachments: 0,
    });
    emit("run_start", { text: "Add a retry to the upload", runState: "running", continued: false });

    const button = await screen.findByRole<HTMLButtonElement>("button", { name: /^sent$/i });
    expect(button.disabled).toBe(true);
    expect(screen.getAllByText("Sent to GG Coder")).toHaveLength(1);
  });

  it("a click here gives exactly one row, even when the sidecar echoes it back", async () => {
    const { emit, sends } = await resume([ASKED, KEN_REPLY]);
    fireEvent.click(await screen.findByRole("button", { name: /send to gg coder/i }));
    // The click itself turns the block Sent and adds the row, before any echo.
    expect(
      (await screen.findByRole<HTMLButtonElement>("button", { name: /^sent$/i })).disabled,
    ).toBe(true);
    expect(screen.getAllByText("Sent to GG Coder")).toHaveLength(1);
    await waitFor(() => expect(sends).toHaveBeenCalledOnce());
    const payload = sends.mock.calls[0]?.[0] as { text: string; meta: Record<string, unknown> };
    expect(payload.text).toBe("Add a retry to the upload");
    expect(payload.meta.kenSent).toBe(true);
    expect(typeof payload.meta.promptId).toBe("string");

    emit("prompt_accepted", {
      id: payload.meta.promptId,
      text: payload.text,
      kenSent: true,
      queued: false,
      attachments: 0,
    });
    emit("run_start", { text: payload.text, runState: "running", continued: false });

    expect(
      (await screen.findByRole<HTMLButtonElement>("button", { name: /^sent$/i })).disabled,
    ).toBe(true);
    expect(screen.getAllByText("Sent to GG Coder")).toHaveLength(1);
  });

  it("shows a plain prompt from another client live, without marking Ken's block", async () => {
    const { emit } = await resume([ASKED, KEN_REPLY]);
    await screen.findByRole("button", { name: /send to gg coder/i });

    emit("prompt_accepted", {
      id: "bridge-7",
      text: "Add a retry to the upload",
      queued: false,
      attachments: 0,
    });

    // A normal user bubble (not Ken's own, not a "Sent to GG Coder" label).
    await waitFor(() => {
      const rows = [...document.querySelectorAll(".user-msg:not(.user-ken)")];
      expect(rows.map((row) => row.textContent)).toEqual([
        expect.stringContaining("Add a retry to the upload"),
      ]);
    });
    expect(screen.queryByText("Sent to GG Coder")).toBeNull();
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: /send to gg coder/i }).disabled,
    ).toBe(false);
  });
});

// Live, then a reload. A reload remounts App, which hydrates the transcript
// from agent_history (the sidecar's GET /history), exactly as a real window
// reload does. The history rows below are the shape GET /history returns for
// these prompts (see app-sidecar-prompt-accepted-live.test.ts in ggcoder).
describe("Ken prompt block live, then reload", () => {
  const ASKED: HistoryEntry = { role: "user", ken: true, text: "what next?" };
  const SENT_ROW = {
    role: "user",
    text: "Add a retry to the upload",
    images: [],
    hook: null,
    command: false,
    compacted: false,
    kenSent: true,
  } as unknown as HistoryEntry;
  const DONE: HistoryEntry = { role: "assistant", text: "Done." };

  const userRows = () => [...document.querySelectorAll(".transcript .user-msg")];
  const sentRows = () => screen.queryAllByText("Sent to GG Coder");
  const queuedRows = () => document.querySelectorAll(".transcript .user-msg.queued");

  /** One finished run of the prompt, as the sidecar streams it. */
  function runIt(emit: Resumed["emit"], text: string): void {
    emit("run_start", { text, runState: "running", continued: false });
    emit("text_delta", { text: "Done." });
    emit("run_end", { failed: false, reviewPending: false, runState: "idle" });
    emit("queued", { count: 0, messages: [] });
  }

  async function expectSentOnce(): Promise<void> {
    expect(
      (await screen.findByRole<HTMLButtonElement>("button", { name: /^sent$/i })).disabled,
    ).toBe(true);
    expect(screen.queryByRole("button", { name: /send to gg coder/i })).toBeNull();
    await waitFor(() => expect(sentRows()).toHaveLength(1));
    expect(queuedRows()).toHaveLength(0);
  }

  it("a prompt from another client: one Sent row live, still exactly one after reload", async () => {
    const { emit } = await resume([ASKED, KEN_REPLY]);
    await screen.findByRole("button", { name: /send to gg coder/i });
    emit("prompt_accepted", {
      id: "glasses-1",
      text: "Add a retry to the upload",
      kenSent: true,
      queued: false,
      attachments: 0,
    });
    runIt(emit, "Add a retry to the upload");
    await expectSentOnce();
    // Ken's question plus the one sent prompt.
    expect(userRows()).toHaveLength(2);

    cleanup();
    await resume([ASKED, KEN_REPLY, SENT_ROW, DONE]);
    await expectSentOnce();
    expect(userRows()).toHaveLength(2);
  });

  it("a click in this window: one Sent row live (echo ignored), still exactly one after reload", async () => {
    const { emit, sends } = await resume([ASKED, KEN_REPLY]);
    fireEvent.click(await screen.findByRole("button", { name: /send to gg coder/i }));
    await waitFor(() => expect(sends).toHaveBeenCalledOnce());
    const payload = sends.mock.calls[0]?.[0] as { text: string; meta: Record<string, unknown> };
    emit("prompt_accepted", {
      id: payload.meta.promptId,
      text: payload.text,
      kenSent: true,
      queued: false,
      attachments: 0,
    });
    runIt(emit, payload.text);
    await expectSentOnce();
    expect(userRows()).toHaveLength(2);

    cleanup();
    await resume([ASKED, KEN_REPLY, SENT_ROW, DONE]);
    await expectSentOnce();
    expect(userRows()).toHaveLength(2);
  });

  it("a prompt from another client that queues: one row, its queued pill clears when the agent takes it", async () => {
    // A plain prompt: a Ken-sent row renders as the "Sent to GG Coder" label,
    // which never shows the queued pill, so only a plain one can prove it clears.
    const { emit } = await resume([ASKED, KEN_REPLY]);
    await screen.findByRole("button", { name: /send to gg coder/i });
    emit("run_start", { text: "first task", runState: "running", continued: false });
    emit("prompt_accepted", {
      id: "glasses-2",
      text: "Then run the linter",
      queued: true,
      attachments: 0,
    });
    emit("queued", { count: 1, messages: [{ id: "q1", text: "Then run the linter" }] });
    await waitFor(() => expect(queuedRows()).toHaveLength(1));
    // The agent takes it at a turn boundary (queue_drained -> queued count 0).
    emit("queued", { count: 0, messages: [] });
    emit("run_end", { failed: false, reviewPending: false, runState: "idle" });
    await waitFor(() => expect(queuedRows()).toHaveLength(0));
    const rows = userRows().filter((row) => row.textContent?.includes("Then run the linter"));
    expect(rows).toHaveLength(1);
    // A plain prompt never marks Ken's block.
    expect(sentRows()).toHaveLength(0);

    cleanup();
    await resume([
      ASKED,
      KEN_REPLY,
      { role: "user", text: "Then run the linter" } as HistoryEntry,
      DONE,
    ]);
    await waitFor(() =>
      expect(
        userRows().filter((row) => row.textContent?.includes("Then run the linter")),
      ).toHaveLength(1),
    );
    expect(queuedRows()).toHaveLength(0);
  });
});
