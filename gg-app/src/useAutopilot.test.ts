// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Item } from "./App";
import { playSound } from "./sounds";
import { useAutopilot } from "./useAutopilot";

// playSound builds an <audio> element, which jsdom can't play.
vi.mock("./sounds", () => ({ playSound: vi.fn() }));
import { driveAutopilotCycle } from "../../packages/ggcoder/src/core/autopilot-cycle";
import {
  CORPUS_UNVERIFIED_REASON,
  parseAutopilotVerdict,
} from "../../packages/ggcoder/src/core/autopilot-verdict";

describe("Autopilot evidence limitation delivery", () => {
  it("carries a parsed warning through the cycle event into the live transcript", async () => {
    let items: Item[] = [];
    let id = 0;
    const { result } = renderHook(() =>
      useAutopilot({
        setItems: (update) => {
          items = typeof update === "function" ? update(items) : update;
        },
        nextId: () => ++id,
      }),
    );
    const unexpected = async () => {
      throw new Error("A limitation must not trigger another run");
    };
    await act(async () =>
      driveAutopilotCycle({
        maxRounds: 1,
        isCancelled: () => false,
        verificationProblem: () => null,
        isPlanMode: () => false,
        planPending: () => false,
        resetReviewer: async () => {},
        review: async () =>
          parseAutopilotVerdict('{"verdict":"ALL_CLEAR","evidenceLimitation":"corpus_unverified"}'),
        reviewPlan: unexpected,
        acceptPlan: unexpected,
        runImplement: unexpected,
        runPrompt: unexpected,
        onInjected: () => {
          throw new Error("Unexpected repair");
        },
        emit: (event) => {
          result.current.handleAutopilotEvent(event);
        },
      }),
    );
    expect(items).toEqual([
      expect.objectContaining({
        kind: "autopilot",
        phase: "done",
        reason: CORPUS_UNVERIFIED_REASON,
      }),
    ]);
    expect(result.current.autopilotReviewing).toBe(false);
  });
});

describe("Autopilot errors", () => {
  it("adds the error row and plays the error sound when the cycle stops", () => {
    let items: Item[] = [];
    const { result } = renderHook(() =>
      useAutopilot({
        setItems: (update) => {
          items = typeof update === "function" ? update(items) : update;
        },
        nextId: () => 1,
      }),
    );
    act(() => {
      result.current.handleAutopilotEvent({
        type: "autopilot_error",
        data: { headline: "Review failed" },
      });
    });
    expect(items.map((it) => it.kind)).toEqual(["error"]);
    expect(vi.mocked(playSound)).toHaveBeenCalledWith("error");
  });
});

describe("Autopilot prompted marker with a user rule", () => {
  function hook(): { items: () => Item[]; handle: (type: string, data: unknown) => void } {
    let items: Item[] = [];
    let id = 0;
    const { result } = renderHook(() =>
      useAutopilot({
        setItems: (update) => {
          items = typeof update === "function" ? update(items) : update;
        },
        nextId: () => ++id,
      }),
    );
    return {
      items: () => items,
      handle: (type, data) => {
        act(() => {
          result.current.handleAutopilotEvent({ type, data } as never);
        });
      },
    };
  }

  it("carries the fired rule onto the marker", () => {
    const h = hook();
    h.handle("autopilot_prompted", { round: 1, body: "fix it", rule: " tests red " });
    expect(h.items()).toEqual([
      expect.objectContaining({ kind: "autopilot", phase: "prompted", rule: "tests red" }),
    ]);
  });

  it("leaves rule off when the frame has none or a non-string", () => {
    const h = hook();
    h.handle("autopilot_prompted", { round: 1, body: "fix it" });
    h.handle("autopilot_prompted", { round: 2, body: "fix more", rule: 7 });
    expect(h.items()).toHaveLength(2);
    for (const item of h.items()) expect(item).not.toHaveProperty("rule");
  });
});
