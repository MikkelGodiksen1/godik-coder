import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { codeLanguage, codeNodeText, isPromptSent, sentPromptsAfterKen } from "./markdown-prompt";

// These two helpers are the core of the "Send to GG Coder" button: ReactMarkdown
// hands the `pre` override a `<code class="language-xxx">…</code>` child.
// codeLanguage decides whether the block becomes a Ken prompt button (lang ===
// "prompt"); codeNodeText extracts the exact body that gets sent to GG Coder.

describe("codeLanguage (button trigger detection)", () => {
  it("detects a ```prompt fence (turns the block into the Send button)", () => {
    const code = createElement("code", { className: "language-prompt" }, "do the thing");
    expect(codeLanguage(code)).toBe("prompt");
  });

  it("returns the real language for ordinary fences (stays a code block)", () => {
    const ts = createElement("code", { className: "language-ts hljs" }, "const x = 1");
    expect(codeLanguage(ts)).toBe("ts");
  });

  it("returns null for a fence with no language class", () => {
    const plain = createElement("code", {}, "plain");
    expect(codeLanguage(plain)).toBeNull();
  });

  it("returns null when the child isn't an element (e.g. raw string)", () => {
    expect(codeLanguage("just text")).toBeNull();
  });

  it("is case-sensitive: ```Prompt is NOT the button (must be lowercase)", () => {
    const code = createElement("code", { className: "language-Prompt" }, "x");
    // Markdown lowercases fence info strings, so the real path is always
    // lowercase; this documents that "Prompt" != "prompt" in our matcher.
    expect(codeLanguage(code)).toBe("Prompt");
    expect(codeLanguage(code) === "prompt").toBe(false);
  });
});

describe("codeNodeText (what actually gets sent to GG Coder)", () => {
  it("extracts a plain string body", () => {
    const code = createElement("code", { className: "language-prompt" }, "Add a footer");
    expect(codeNodeText(code)).toBe("Add a footer");
  });

  it("joins multi-node children (syntax-highlight spans)", () => {
    const code = createElement(
      "code",
      { className: "language-prompt" },
      "Add ",
      createElement("span", {}, "dark mode"),
      " toggle",
    );
    expect(codeNodeText(code)).toBe("Add dark mode toggle");
  });

  it("preserves multi-line prompt bodies", () => {
    const body = "Line one of the prompt.\nLine two with detail.";
    const code = createElement("code", { className: "language-prompt" }, body);
    expect(codeNodeText(code)).toBe(body);
  });

  it("returns empty string for a null/empty node", () => {
    expect(codeNodeText(null)).toBe("");
    expect(codeNodeText(undefined)).toBe("");
  });
});

// A prompt block reads "Sent" when a later "Send to GG Coder" turn (kenSent)
// carries its text, from this window or another client (e.g. the glasses).
describe("isPromptSent (Sent state from the transcript)", () => {
  const sentTurn = (text: string) => ({ kind: "user", text, kenSent: true });

  it("is sent when a later kenSent turn has the same text", () => {
    expect(isPromptSent("Add a retry\n", [sentTurn("Add a retry")])).toBe(true);
  });

  it("is not sent without a matching kenSent turn", () => {
    expect(
      isPromptSent("Add a retry", [
        sentTurn("Add a footer"),
        { kind: "user", text: "Add a retry" },
        { kind: "assistant", text: "Add a retry" },
      ]),
    ).toBe(false);
  });

  it("matches after trimming whitespace on both sides", () => {
    expect(isPromptSent("  Add a retry\n", [sentTurn("\nAdd a retry  ")])).toBe(true);
  });

  it("never treats an empty block as sent", () => {
    expect(isPromptSent("\n", [sentTurn("")])).toBe(false);
  });
});

describe("sentPromptsAfterKen (per Ken bubble)", () => {
  it("counts only kenSent turns AFTER each Ken bubble", () => {
    const items = [
      { kind: "user", id: 1, text: "Add a retry", kenSent: true },
      { kind: "ken", id: 2, text: "```prompt\nAdd a retry\n```" },
      { kind: "assistant", id: 3, text: "ok" },
      { kind: "ken", id: 4, text: "```prompt\nAdd a footer\n```" },
      { kind: "user", id: 5, text: " Add a footer\n", kenSent: true },
    ];
    const map = sentPromptsAfterKen(items);
    // The earlier identical send (id 1) comes BEFORE bubble 2: it doesn't count.
    expect(map.get(2)).toEqual(["Add a footer"]);
    expect(map.get(4)).toEqual(["Add a footer"]);
    expect(isPromptSent("Add a retry", items.slice(2))).toBe(false);
  });

  it("reuses an unchanged list so the context doesn't churn", () => {
    const items = [
      { kind: "ken", id: 1, text: "k" },
      { kind: "user", id: 2, text: "Add a retry", kenSent: true },
    ];
    const first = sentPromptsAfterKen(items);
    const second = sentPromptsAfterKen([...items, { kind: "assistant", id: 3, text: "x" }], first);
    expect(second.get(1)).toBe(first.get(1));
  });
});
