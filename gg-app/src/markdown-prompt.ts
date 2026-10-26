import { isValidElement, type ReactNode } from "react";

// Pure helpers behind Ken's "Send to GG Coder" button. Kept dependency-free (no
// Tauri/agent imports) so they're unit-testable in a node env and reusable.
// ReactMarkdown hands the `pre` override a `<code class="language-xxx">…</code>`
// child: `codeLanguage` decides whether the fenced block becomes a Ken prompt
// button (language === "prompt"); `codeNodeText` extracts the exact body sent.

/** Extract the raw text from a fenced block's `<code>` child node tree. */
export function codeNodeText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(codeNodeText).join("");
  if (isValidElement(node)) {
    return codeNodeText((node.props as { children?: ReactNode }).children);
  }
  return "";
}

/** Read the `language-xxx` token off a fenced block's `<code>` child. */
export function codeLanguage(children: ReactNode): string | null {
  if (!isValidElement(children)) return null;
  const className = (children.props as { className?: string }).className ?? "";
  const match = /language-([\w-]+)/.exec(className);
  return match ? match[1] : null;
}

/** The exact text a prompt block sends: PromptBlock's own normalization
 *  (drop the fence's trailing newline, then trim). */
export function normalizePromptText(body: string): string {
  return body.replace(/\n$/, "").trim();
}

/** The transcript fields these helpers read; structurally matches `Item`. */
type PromptTurnLike = { kind: string; id?: number; text?: string; kenSent?: boolean };

/**
 * Was this prompt block already sent to GG Coder? True when a later turn in
 * the transcript is a "Send to GG Coder" user turn (`kenSent`) carrying the
 * same text, whichever client sent it (this window, or another one posting
 * /prompt with meta.kenSent). Pass only the items AFTER the Ken bubble the
 * block sits in, so an earlier identical send doesn't count.
 */
export function isPromptSent(body: string, laterItems: readonly PromptTurnLike[]): boolean {
  const text = normalizePromptText(body);
  if (!text) return false;
  return laterItems.some(
    (it) =>
      it.kind === "user" && it.kenSent === true && normalizePromptText(it.text ?? "") === text,
  );
}

/**
 * For each Ken bubble (by id), the prompt texts sent from a "Send to GG Coder"
 * turn after it. One pass from the end. Lists are reused from `previous` when
 * unchanged, so a context carrying them only updates on a real change.
 */
export function sentPromptsAfterKen(
  items: readonly PromptTurnLike[],
  previous?: ReadonlyMap<number, readonly string[]>,
): Map<number, readonly string[]> {
  const out = new Map<number, readonly string[]>();
  const sentLater: string[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "user" && it.kenSent === true) {
      const text = normalizePromptText(it.text ?? "");
      if (text) sentLater.push(text);
    } else if (it.kind === "ken" && typeof it.id === "number") {
      const prev = previous?.get(it.id);
      const same =
        prev !== undefined &&
        prev.length === sentLater.length &&
        prev.every((t, j) => t === sentLater[j]);
      out.set(it.id, same ? prev : [...sentLater]);
    }
  }
  return out;
}
