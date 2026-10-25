/**
 * GODIK CODER regression: a Ken turn recorded after an interrupted tool call
 * (tool_use on disk with no tool_result) must replay AFTER the messages that
 * came before it. repairToolPairs adds the missing tool_result in memory only,
 * so the live anchor (memory count) and the replay's file-order position
 * (disk count) used to drift apart by one per interrupted call, and the
 * anchor's min() pulled the turn above the preceding assistant reply.
 */
import type { Message } from "@kenkaiiii/gg-ai";
import { describe, expect, it } from "vitest";
import { normalizeKenTurnsForHistory, replayMessagesInOrder } from "./session-history.js";
import { KEN_TURN_CUSTOM_KIND, SessionManager, type SessionEntry } from "./session-manager.js";

const manager = new SessionManager("/unused");

/** Builds a session the way the writer does: messages chained by parentId, Ken
 *  turns as custom entries anchored at the live (repaired, in-memory) count. */
function session() {
  const entries: SessionEntry[] = [];
  let leaf: string | null = null;
  let n = 0;
  const ts = () => new Date(Date.UTC(2026, 9, 25, 12, 0, n)).toISOString();
  const add = (message: Message): void => {
    const id = `m${++n}`;
    entries.push({ type: "message", id, parentId: leaf, timestamp: ts(), message } as SessionEntry);
    leaf = id;
  };
  return {
    user: (text: string) => add({ role: "user", content: text }),
    assistant: (text: string) => add({ role: "assistant", content: [{ type: "text", text }] }),
    /** An assistant tool call whose result never reached disk (app quit mid-call). */
    interruptedCall: (name: string) =>
      add({
        role: "assistant",
        content: [{ type: "tool_call", id: `call-${++n}`, name, args: {} }],
      } as Message),
    ken: (question: string) => {
      // AgentSession.persistedTranscriptCount() after resume: the repaired list.
      const afterMessageCount = manager.getMessages(entries, leaf).length;
      entries.push({
        type: "custom",
        kind: KEN_TURN_CUSTOM_KIND,
        id: `k${++n}`,
        parentId: null,
        timestamp: ts(),
        data: { version: 1, question, reply: `re: ${question}`, afterMessageCount },
      } as SessionEntry);
    },
    entries,
    leaf: () => leaf,
  };
}

/** The transcript order /history replays (history-routes.ts): messages, with
 *  Ken turns flushed after the message count they are anchored to. */
async function replayOrder(s: ReturnType<typeof session>): Promise<string[]> {
  const messages = manager.getMessages(s.entries, s.leaf());
  const turns = normalizeKenTurnsForHistory(
    manager.getKenTurns(s.entries, s.leaf()),
    messages.length,
  );
  const out: string[] = [];
  const flush = (count: number) => {
    for (const t of turns.filter((x) => x.afterMessageCount === count))
      out.push(`ken:${t.question}`);
  };
  flush(0);
  await replayMessagesInOrder(
    messages,
    (m) => {
      if (m.role === "tool") return;
      const text =
        typeof m.content === "string"
          ? m.content
          : m.content.map((c) => ("text" in c ? c.text : `[${c.type}]`)).join("");
      out.push(`${m.role}:${text}`);
    },
    flush,
  );
  return out;
}

describe("Ken turns after an interrupted tool call", () => {
  it("replays after the assistant report that preceded them", async () => {
    const s = session();
    s.user("set up the fork");
    s.interruptedCall("ask_user");
    s.user("go on");
    s.assistant("report");
    s.ken("install now?");
    s.ken("red checks?");
    const order = await replayOrder(s);
    expect(order.slice(-3)).toEqual(["assistant:report", "ken:install now?", "ken:red checks?"]);
  });

  it("does not drift with two interrupted calls", async () => {
    const s = session();
    s.user("start");
    s.interruptedCall("ask_user");
    s.user("again");
    s.interruptedCall("bash");
    s.user("and again");
    s.assistant("first report");
    s.ken("between");
    s.user("next");
    s.assistant("second report");
    s.ken("after");
    const order = await replayOrder(s);
    expect(order.slice(-6)).toEqual([
      "user:and again",
      "assistant:first report",
      "ken:between",
      "user:next",
      "assistant:second report",
      "ken:after",
    ]);
  });

  it("is unchanged when no tool call was interrupted", async () => {
    const s = session();
    s.user("hi");
    s.assistant("hello");
    s.ken("q1");
    s.user("more");
    s.assistant("done");
    s.ken("q2");
    expect(await replayOrder(s)).toEqual([
      "user:hi",
      "assistant:hello",
      "ken:q1",
      "user:more",
      "assistant:done",
      "ken:q2",
    ]);
  });
});
