// Ids of the prompts this window sent (sendPrompt attaches one as
// meta.promptId). The sidecar echoes the id in `prompt_accepted`, so the
// window can tell its own prompts (already shown) from another client's
// (the glasses, another window), which it adds live. Per window: each window
// has its own JS context.

const MAX_REMEMBERED = 500;
const ids = new Set<string>();

/** A fresh id for a prompt this window is about to send. */
export function newPromptId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Remember that this window sent `id`; the oldest ids are forgotten first. */
export function rememberLocalPromptId(id: string): void {
  ids.add(id);
  if (ids.size > MAX_REMEMBERED) {
    const oldest = ids.values().next().value;
    if (oldest !== undefined) ids.delete(oldest);
  }
}

/** Did this window send the prompt with this id? */
export function isLocalPromptId(id: unknown): boolean {
  return typeof id === "string" && ids.has(id);
}
