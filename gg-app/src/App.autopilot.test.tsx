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

const ORDER_OFF = "Mentor-ordre: giv Godik én ordre til GC's næste færdige tur";
const ORDER_ON = "Mentor-ordre til: det du skriver, går til Godik som en ordre, ikke til GC";

/** What the (fake) sidecar says it still holds, for the reconnect check. */
let sidecarOrders: Record<string, unknown> = { pending: null, firing: null, recent: [] };

beforeEach(() => {
  sidecarOrders = { pending: null, firing: null, recent: [] };
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
  saves: ReturnType<typeof vi.fn>;
  /** Every agent_mentor_order call's text. */
  orders: ReturnType<typeof vi.fn>;
  /** Every agent_prompt call's text (messages to GC). */
  prompts: ReturnType<typeof vi.fn>;
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
  const saves = vi.fn();
  const orders = vi.fn();
  const prompts = vi.fn();
  let orderSeq = 0;
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
      case "agent_mentor_order": {
        const { text } = payload as { text: string };
        orders(text);
        if (!text) return { ok: true, cleared: `order-${orderSeq}` };
        orderSeq++;
        return { ok: true, order: { id: `order-${orderSeq}`, text } };
      }
      case "agent_mentor_order_get":
        return sidecarOrders;
      case "agent_prompt":
        prompts((payload as { text: string }).text);
        return null;
      case "agent_autopilot_rule_save": {
        const { id, text } = payload as { id: string; text: string };
        saves(id, text);
        return { ok: true, line: `- ${text}` };
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
  return { emit, toggles, saves, orders, prompts };
}

/** The composer box (its wrapper carries the blue order look). */
function composerWrap(): HTMLElement {
  const wrap = screen.getByRole("textbox").closest(".inputwrap");
  if (!(wrap instanceof HTMLElement)) throw new Error("no composer");
  return wrap;
}

/** Turn the key on, type `text` and press Enter. */
async function giveOrder(text: string): Promise<void> {
  fireEvent.click(screen.getByTitle(ORDER_OFF));
  const input = screen.getByRole<HTMLTextAreaElement>("textbox");
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: "Enter" });
  await screen.findByRole("region", { name: "Ordre til mentor" });
}

describe("deck Mentor-ordre key", () => {
  it("toggles order mode, turns the composer blue, and never touches Autopilot", async () => {
    const { toggles } = await setup();
    const key = screen.getByTitle(ORDER_OFF);
    expect(key.textContent).toBe("Mentor-ordre");
    expect(key.getAttribute("aria-pressed")).toBe("false");
    expect(composerWrap().classList.contains("ken-active")).toBe(false);

    fireEvent.click(key);
    expect(screen.getByTitle(ORDER_ON).getAttribute("aria-pressed")).toBe("true");
    expect(composerWrap().classList.contains("ken-active")).toBe(true);
    expect(composerWrap().classList.contains("order-active")).toBe(true);

    fireEvent.click(screen.getByTitle(ORDER_ON));
    expect(screen.getByTitle(ORDER_OFF).getAttribute("aria-pressed")).toBe("false");
    expect(composerWrap().classList.contains("ken-active")).toBe(false);
    expect(toggles).not.toHaveBeenCalled();
  });

  it("sends the composer text to the order, not to GC, and turns itself off", async () => {
    const { orders, prompts, toggles } = await setup();
    await giveOrder("sæt det live når testene er grønne");

    expect(orders).toHaveBeenCalledExactlyOnceWith("sæt det live når testene er grønne");
    expect(prompts).not.toHaveBeenCalled();
    expect(toggles).not.toHaveBeenCalled();
    const row = screen.getByRole("region", { name: "Ordre til mentor" });
    expect(row.textContent).toContain("sæt det live når testene er grønne");
    expect(row.textContent).toContain("Venter på at GC bliver færdig");
    // One order, then the key is off and the composer talks to GC again.
    await waitFor(() =>
      expect(screen.getByTitle(ORDER_OFF).getAttribute("aria-pressed")).toBe("false"),
    );
    expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe("");

    const input = screen.getByRole<HTMLTextAreaElement>("textbox");
    fireEvent.change(input, { target: { value: "a normal message" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(prompts).toHaveBeenCalledExactlyOnceWith("a normal message"));
    expect(orders).toHaveBeenCalledTimes(1);
  });

  it("the row follows the order: reviewing, then held with the reason", async () => {
    const { emit } = await setup();
    await giveOrder("deploy it");
    const row = screen.getByRole("region", { name: "Ordre til mentor" });

    emit("mentor_order_fired", { id: "order-1" });
    await waitFor(() => expect(row.textContent).toContain("Godik læser GC's tur"));
    emit("mentor_order_result", {
      id: "order-1",
      outcome: "held",
      reason: "Jeg så ingen testkørsel i GC's sidste tur.",
    });
    await waitFor(() => expect(row.textContent).toContain("Holdt"));
    expect(row.textContent).toContain("Jeg så ingen testkørsel");
    expect(screen.queryByRole("button", { name: "Annuller ordre" })).toBeNull();
  });

  it("a prompted order shows what went to GC", async () => {
    const { emit } = await setup();
    await giveOrder("add a README line");
    emit("mentor_order_result", { id: "order-1", outcome: "prompted", body: "Add ORDER_DONE." });
    const row = screen.getByRole("region", { name: "Ordre til mentor" });
    await waitFor(() => expect(row.textContent).toContain("Sendt til GC"));
    expect(row.textContent).toContain("Add ORDER_DONE.");
  });

  it("Annuller ordre on a waiting order clears it with empty text", async () => {
    const { emit, orders } = await setup();
    await giveOrder("add a README line");
    fireEvent.click(screen.getByRole("button", { name: "Annuller ordre" }));
    await waitFor(() => expect(orders).toHaveBeenLastCalledWith(""));
    emit("mentor_order_cleared", { id: "order-1", reason: "cancelled" });
    const row = screen.getByRole("region", { name: "Ordre til mentor" });
    await waitFor(() => expect(row.textContent).toContain("Annulleret"));
    expect(screen.queryByRole("button", { name: "Annuller ordre" })).toBeNull();
  });

  it("a reconnect to a sidecar that no longer holds the waiting order marks it lost", async () => {
    const { emit } = await setup();
    await giveOrder("add a README line");
    // Still held: a reconnect leaves it waiting.
    sidecarOrders = {
      pending: { id: "order-1", text: "add a README line" },
      firing: null,
      recent: [],
    };
    emit("ready", { sessionId: "s" });
    const row = screen.getByRole("region", { name: "Ordre til mentor" });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(row.textContent).toContain("Venter");
    // The sidecar restarted: nothing pending, no result → lost, said out loud.
    sidecarOrders = { pending: null, firing: null, recent: [] };
    emit("ready", { sessionId: "s2" });
    await waitFor(() => expect(row.textContent).toContain("Mistet"));
  });

  it("a reload restores the outcome, and a lost order says so", async () => {
    await setup([
      { role: "user", text: "hello" },
      {
        role: "assistant",
        text: "",
        mentorOrder: { id: "o1", text: "deploy", status: "held", reason: "no tests" },
      },
      {
        role: "assistant",
        text: "",
        mentorOrder: { id: "o2", text: "add a line", status: "lost" },
      },
    ]);
    const rows = await screen.findAllByRole("region", { name: "Ordre til mentor" });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("Holdt");
    expect(rows[0]?.textContent).toContain("no tests");
    expect(rows[1]?.textContent).toContain("Mistet");
  });
});

/** Open ⋯ (if closed) and return its Autopilot switch. */
function autopilotSwitch(): HTMLElement {
  const open = screen.queryByRole("switch", { name: "Autopilot" });
  if (open) return open;
  fireEvent.click(screen.getByRole("button", { name: "More" }));
  return screen.getByRole("switch", { name: "Autopilot" });
}

describe("⋯ menu Autopilot switch", () => {
  it("toggles the existing Autopilot and reflects it in aria-checked", async () => {
    const { toggles, orders } = await setup();
    expect(autopilotSwitch().getAttribute("aria-checked")).toBe("false");

    fireEvent.click(autopilotSwitch());
    await waitFor(() => expect(toggles).toHaveBeenCalledExactlyOnceWith(true));
    expect(autopilotSwitch().getAttribute("aria-checked")).toBe("true");

    fireEvent.click(autopilotSwitch());
    await waitFor(() => expect(toggles).toHaveBeenLastCalledWith(false));
    expect(toggles).toHaveBeenCalledTimes(2);
    expect(autopilotSwitch().getAttribute("aria-checked")).toBe("false");
    // Autopilot and Mentor-ordre are separate: the switch never stores an order
    // and never turns order mode on.
    expect(orders).not.toHaveBeenCalled();
    expect(screen.getByTitle(ORDER_OFF).getAttribute("aria-pressed")).toBe("false");
  });

  it("starts checked when the project already has Autopilot on", async () => {
    await setup([], true);
    expect(autopilotSwitch().getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTitle(ORDER_OFF).getAttribute("aria-pressed")).toBe("false");
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
    expect(await screen.findByText(/Sending GC back in/)).toBeTruthy();
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

describe("Ken's rule suggestion card", () => {
  const RULE = "if the tests have not run, send: run the tests and fix what fails";
  const offer = (emit: Window["emit"]): void =>
    emit("autopilot_rule_suggestion", { id: "rule-1-1", text: RULE });

  it("renders the proposed rule with Save rule, Edit and Dismiss", async () => {
    const { emit, saves } = await setup([], true);
    offer(emit);
    const card = await screen.findByRole("region", { name: "Rule suggestion" });
    expect(card.textContent).toContain("Make this an Autopilot rule?");
    expect(card.textContent).toContain(RULE);
    for (const name of ["Save rule", "Edit", "Dismiss"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    expect(saves).not.toHaveBeenCalled();
  });

  it("Save sends the rule through the wrapper and shows it saved", async () => {
    const { emit, saves } = await setup([], true);
    offer(emit);
    fireEvent.click(await screen.findByRole("button", { name: "Save rule" }));
    await waitFor(() => expect(saves).toHaveBeenCalledExactlyOnceWith("rule-1-1", RULE));
    expect(await screen.findByText("Saved to .gg/autopilot-rules.md")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save rule" })).toBeNull();
  });

  it("Edit lets the user change the rule before saving", async () => {
    const { emit, saves } = await setup([], true);
    offer(emit);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Rule text" }), {
      target: { value: "if lint fails, send: fix lint" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save rule" }));
    await waitFor(() =>
      expect(saves).toHaveBeenCalledExactlyOnceWith("rule-1-1", "if lint fails, send: fix lint"),
    );
  });

  it("Dismiss takes the card down and saves nothing", async () => {
    const { emit, saves } = await setup([], true);
    offer(emit);
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Rule suggestion" })).toBeNull(),
    );
    expect(saves).not.toHaveBeenCalled();
  });

  it("a cleared suggestion (new prompt or Stop) takes the card down", async () => {
    const { emit, saves } = await setup([], true);
    offer(emit);
    await screen.findByRole("region", { name: "Rule suggestion" });
    emit("autopilot_rule_suggestion_cleared", { id: "rule-1-1" });
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Rule suggestion" })).toBeNull(),
    );
    expect(saves).not.toHaveBeenCalled();
  });
});
