import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ASK_DEFERRED_RESULT,
  ASK_USER_INTERACTIVE_DEADLINE_MS,
  ASK_USER_UNATTENDED_DEADLINE_MS,
  askSoftDeadlineMs,
  createAskUserBridge,
  deliverLateAnswer,
  formatLateAnswer,
  type AskUserPrompt,
  type LateAskAnswer,
} from "./ask-user.js";
import { createAskUserTool } from "../tools/ask-user.js";

/**
 * The soft-deadline ("async ask") contract: past the deadline the tool call
 * returns "proceed on your best guess", the question stays answerable, and a
 * later answer reaches the agent exactly once as a message.
 */
function harness(timeoutMs: number | (() => number) = 1000) {
  const broadcast = vi.fn<(prompt: AskUserPrompt) => void>();
  const onLateAnswer = vi.fn<(late: LateAskAnswer) => void>();
  const onClosed = vi.fn<(ids: string[]) => void>();
  const onAnswered =
    vi.fn<(answered: { id: string; answers: Record<string, string | string[]> }) => void>();
  const onSuperseded = vi.fn<(id: string) => void>();
  const bridge = createAskUserBridge({
    broadcast,
    timeoutMs,
    onLateAnswer,
    onClosed,
    onAnswered,
    onSuperseded,
  });
  const tool = createAskUserTool(bridge.park);
  const call = (question = "Ship it?"): Promise<string> =>
    tool.execute({ questions: [{ id: "q", question, kind: "confirm" }] }, {
      signal: new AbortController().signal,
      toolCallId: "t1",
      onUpdate: () => {},
    } as never) as Promise<string>;
  const lastPrompt = (): AskUserPrompt => {
    const calls = broadcast.mock.calls;
    const last = calls[calls.length - 1];
    if (!last) throw new Error("nothing broadcast");
    return last[0];
  };
  return { bridge, call, lastPrompt, onLateAnswer, onClosed, onAnswered, onSuperseded };
}

describe("ask_user soft deadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a proceed-on-best-judgment result with the safety rule", async () => {
    const { call } = harness();
    const result = call();
    await vi.advanceTimersByTimeAsync(1001);
    const text = await result;
    expect(text).toBe(ASK_DEFERRED_RESULT);
    expect(text).toContain("best judgment");
    expect(text).toContain("state the assumption");
    expect(text).toContain("reversible");
    expect(text).toMatch(/Do NOT delete data, push, publish/);
    expect(text).toContain("Late answer to:");
  });

  it("keeps the question open after the deadline", async () => {
    const { bridge, call } = harness();
    const result = call();
    await vi.advanceTimersByTimeAsync(1001);
    await result;
    expect(bridge.pendingCount).toBe(0);
    expect(bridge.deferredCount).toBe(1);
  });

  it("lists every open question with its prompt, so a reloaded window can show it again", async () => {
    // Live bug: a webview reload while GG Goals waited on a question lost the
    // card, and nothing re-sent it.
    const { bridge, call, lastPrompt } = harness();
    const first = call("Use Postgres?");
    await vi.advanceTimersByTimeAsync(1001);
    await first;
    const deferredPrompt = lastPrompt();
    void call("Which tool do you deploy with?");
    const pendingPrompt = lastPrompt();
    // The newer question supersedes the deferred one.
    expect(bridge.openPrompts()).toEqual([{ prompt: pendingPrompt, deferred: false }]);
    expect(deferredPrompt.id).not.toBe(pendingPrompt.id);
    bridge.cancelAll();
    expect(bridge.openPrompts()).toEqual([]);
  });

  it("delivers a late answer exactly once", async () => {
    const { bridge, call, lastPrompt, onLateAnswer } = harness();
    const result = call("Use Postgres?");
    await vi.advanceTimersByTimeAsync(1001);
    await result;
    const { id } = lastPrompt();
    expect(bridge.settle(id, { action: "answer", answers: { q: "No" } })).toBe(true);
    expect(bridge.settle(id, { action: "answer", answers: { q: "No" } })).toBe(false);
    expect(onLateAnswer).toHaveBeenCalledTimes(1);
    const late = onLateAnswer.mock.calls[0]?.[0];
    if (!late) throw new Error("no late answer");
    const text = formatLateAnswer(late);
    expect(text).toContain("Late answer to: Use Postgres?\n→ No");
    expect(bridge.deferredCount).toBe(0);
  });

  it("dismissing a deferred question delivers nothing", async () => {
    const { bridge, call, lastPrompt, onLateAnswer } = harness();
    const result = call();
    await vi.advanceTimersByTimeAsync(1001);
    await result;
    expect(bridge.settle(lastPrompt().id, { action: "cancel" })).toBe(true);
    expect(onLateAnswer).not.toHaveBeenCalled();
  });

  it("answering before the deadline returns the answer and never defers", async () => {
    const { bridge, call, lastPrompt, onLateAnswer } = harness();
    const result = call();
    await vi.advanceTimersByTimeAsync(10);
    bridge.settle(lastPrompt().id, { action: "answer", answers: { q: "Yes" } });
    await expect(result).resolves.toContain("The user answered");
    await vi.advanceTimersByTimeAsync(5000);
    expect(bridge.deferredCount).toBe(0);
    expect(onLateAnswer).not.toHaveBeenCalled();
  });

  it("a typed user message still supersedes a deferred question", async () => {
    const { bridge, call, lastPrompt, onLateAnswer, onClosed } = harness();
    const result = call();
    await vi.advanceTimersByTimeAsync(1001);
    await result;
    const { id } = lastPrompt();
    // What POST /prompt does.
    bridge.cancelAll({ action: "cancel", superseded: true });
    expect(onClosed).toHaveBeenCalledWith([id]);
    expect(bridge.settle(id, { action: "answer", answers: { q: "Yes" } })).toBe(false);
    expect(onLateAnswer).not.toHaveBeenCalled();
  });

  it("a newer question supersedes a deferred one", async () => {
    const { bridge, call, lastPrompt, onClosed } = harness();
    const first = call("First?");
    await vi.advanceTimersByTimeAsync(1001);
    await first;
    const firstId = lastPrompt().id;
    const second = call("Second?");
    expect(onClosed).toHaveBeenCalledWith([firstId]);
    expect(bridge.deferredCount).toBe(0);
    expect(bridge.pendingCount).toBe(1);
    expect(bridge.settle(firstId, { action: "answer", answers: { q: "Yes" } })).toBe(false);
    bridge.settle(lastPrompt().id, { action: "answer", answers: { q: "Yes" } });
    await expect(second).resolves.toContain("Second?\n→ Yes");
  });

  it("reads the deadline per question, so unattended runs get the short one", async () => {
    let unattended = true;
    const { bridge, call } = harness(() => askSoftDeadlineMs(unattended));
    const auto = call();
    await vi.advanceTimersByTimeAsync(ASK_USER_UNATTENDED_DEADLINE_MS + 1);
    await expect(auto).resolves.toBe(ASK_DEFERRED_RESULT);

    unattended = false;
    const interactive = call();
    await vi.advanceTimersByTimeAsync(ASK_USER_UNATTENDED_DEADLINE_MS + 1);
    expect(bridge.pendingCount).toBe(1);
    await vi.advanceTimersByTimeAsync(ASK_USER_INTERACTIVE_DEADLINE_MS);
    await expect(interactive).resolves.toBe(ASK_DEFERRED_RESULT);
  });

  it("uses 2 minutes unattended and 10 minutes interactive", () => {
    expect(askSoftDeadlineMs(true)).toBe(2 * 60_000);
    expect(askSoftDeadlineMs(false)).toBe(10 * 60_000);
  });
});

describe("late answer delivery", () => {
  const late: LateAskAnswer = {
    prompt: { id: "ask-1", questions: [{ id: "q", question: "Ship it?", kind: "confirm" }] },
    answers: { q: "Yes" },
  };

  it("queues as steering while a run is live, without starting another", () => {
    const queueMessage = vi.fn<(text: string) => number>(() => 1);
    const startIdleRun = vi.fn();
    deliverLateAnswer(late, { queueMessage, isBusy: () => true, startIdleRun });
    expect(queueMessage).toHaveBeenCalledTimes(1);
    expect(queueMessage.mock.calls[0]?.[0]).toContain("Late answer to: Ship it?\n→ Yes");
    expect(startIdleRun).not.toHaveBeenCalled();
  });

  it("queues and starts a run when the session is idle", () => {
    const queueMessage = vi.fn<(text: string) => number>(() => 1);
    const startIdleRun = vi.fn();
    deliverLateAnswer(late, { queueMessage, isBusy: () => false, startIdleRun });
    expect(queueMessage).toHaveBeenCalledTimes(1);
    expect(startIdleRun).toHaveBeenCalledTimes(1);
  });

  it("end to end: a deferred question answered later is delivered once", async () => {
    vi.useFakeTimers();
    try {
      const queueMessage = vi.fn<(text: string) => number>(() => 1);
      const broadcast = vi.fn<(prompt: AskUserPrompt) => void>();
      const bridge = createAskUserBridge({
        broadcast,
        timeoutMs: 1000,
        onLateAnswer: (l) =>
          deliverLateAnswer(l, { queueMessage, isBusy: () => true, startIdleRun: () => {} }),
      });
      const parked = bridge.park({
        questions: [{ id: "q", question: "Ship it?", kind: "confirm" }],
      });
      await vi.advanceTimersByTimeAsync(1001);
      await expect(parked).resolves.toEqual({ action: "deferred" });
      const id = broadcast.mock.calls[0]?.[0].id ?? "";
      bridge.settle(id, { action: "answer", answers: { q: "Yes" } });
      bridge.settle(id, { action: "answer", answers: { q: "Yes" } });
      expect(queueMessage).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Every window must hear that a question was answered, whoever answered it:
 * the app, or another client such as the glasses posting /ask/:id. The app
 * marks its band answered from `ask_user_answered`; without it a question
 * answered elsewhere stayed up as an open card.
 */
describe("ask_user answered by any client", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("an answer from another client (POST /ask/:id) reports it answered, once", async () => {
    const { bridge, call, lastPrompt, onAnswered, onClosed } = harness();
    const result = call();
    await vi.advanceTimersByTimeAsync(10);
    const { id } = lastPrompt();
    expect(bridge.settle(id, { action: "answer", answers: { q: "Yes" } })).toBe(true);
    await expect(result).resolves.toContain("The user answered");
    expect(onAnswered).toHaveBeenCalledTimes(1);
    expect(onAnswered).toHaveBeenCalledWith({ id, answers: { q: "Yes" } });
    // a second answer to the same question reaches nobody and reports nothing
    expect(bridge.settle(id, { action: "answer", answers: { q: "No" } })).toBe(false);
    expect(onAnswered).toHaveBeenCalledTimes(1);
    expect(onClosed).not.toHaveBeenCalled(); // answered is not closed
  });

  it("a late answer to a deferred question reports it answered too", async () => {
    const { bridge, call, lastPrompt, onAnswered, onLateAnswer } = harness();
    const result = call();
    await vi.advanceTimersByTimeAsync(1001);
    await result;
    const { id } = lastPrompt();
    expect(onAnswered).not.toHaveBeenCalled(); // the deadline is no answer
    expect(bridge.settle(id, { action: "answer", answers: { q: "No" } })).toBe(true);
    expect(onLateAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswered).toHaveBeenCalledTimes(1);
    expect(onAnswered).toHaveBeenCalledWith({ id, answers: { q: "No" } });
  });

  it("cancel, dismiss and supersede stay as they were: nothing reported answered", async () => {
    const { bridge, call, lastPrompt, onAnswered } = harness();
    const first = call();
    await vi.advanceTimersByTimeAsync(10);
    expect(bridge.settle(lastPrompt().id, { action: "cancel" })).toBe(true);
    await first;
    const second = call();
    await vi.advanceTimersByTimeAsync(1001);
    await second;
    expect(bridge.settle(lastPrompt().id, { action: "cancel" })).toBe(true); // dismissing a deferred one
    const third = call();
    await vi.advanceTimersByTimeAsync(10);
    bridge.cancelAll({ action: "cancel", superseded: true });
    await third;
    expect(onAnswered).not.toHaveBeenCalled();
  });
});

/**
 * A message of the user's own releases an open question (`cancelAll` with
 * `superseded: true`, prompt-routes) — sent from the app or from the glasses.
 * Every window must hear it: without `ask_user_superseded` a question overtaken
 * from another client stayed up as an open card.
 */
describe("ask_user superseded by a message of the user's own", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports every open question it releases as superseded, once – not answered, not closed", async () => {
    const { bridge, call, lastPrompt, onSuperseded, onAnswered, onClosed } = harness();
    const result = call();
    await vi.advanceTimersByTimeAsync(10);
    const { id } = lastPrompt();
    bridge.cancelAll({ action: "cancel", superseded: true });
    await expect(result).resolves.toContain("sent their own message instead");
    expect(onSuperseded).toHaveBeenCalledTimes(1);
    expect(onSuperseded).toHaveBeenCalledWith(id);
    expect(onAnswered).not.toHaveBeenCalled();
    expect(onClosed).not.toHaveBeenCalled();
    // nothing open any more: a second supersede reports nothing
    bridge.cancelAll({ action: "cancel", superseded: true });
    expect(onSuperseded).toHaveBeenCalledTimes(1);
  });

  it("a plain cancel or reset is not a supersede; deferred questions still close as before", async () => {
    const { bridge, call, lastPrompt, onSuperseded, onClosed } = harness();
    const open = call();
    await vi.advanceTimersByTimeAsync(10);
    bridge.cancelAll({ action: "cancel" }); // a stopped run
    await open;
    bridge.cancelAll(); // a reset
    expect(onSuperseded).not.toHaveBeenCalled();
    // a deferred question: a later supersede closes it through closeDeferred (ask_user_closed), unchanged
    const late = call();
    await vi.advanceTimersByTimeAsync(1001);
    await late;
    const deferredId = lastPrompt().id;
    bridge.cancelAll({ action: "cancel", superseded: true });
    expect(onSuperseded).not.toHaveBeenCalled(); // nothing was pending, only deferred
    expect(onClosed).toHaveBeenCalledWith([deferredId]);
  });
});
