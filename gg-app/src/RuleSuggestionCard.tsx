/**
 * GODIK CODER: Ken's "make this a rule?" card (Autopilot rules v2).
 *
 * After Autopilot stopped for the user and they replied, Ken may propose one
 * "if X, send Y" rule. The card shows it under that turn with Save rule, Edit
 * and Dismiss. Only Save writes anything (one line in the project's
 * `.gg/autopilot-rules.md`); Dismiss just takes the card down.
 */
import { useState } from "react";
import type { Item } from "./transcript-item";

export type RuleSuggestionItem = Extract<Item, { kind: "rule_suggestion" }>;

export type RuleSuggestionAction =
  { type: "save"; suggestionId: string; text: string } | { type: "dismiss" };

export function RuleSuggestionCard({
  item,
  onAction,
}: {
  item: RuleSuggestionItem;
  onAction?: (itemId: number, action: RuleSuggestionAction) => void;
}): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);
  const saving = item.status === "saving";

  if (item.status === "saved") {
    return (
      <div className="assistant-msg ken-msg">
        <section className="rule-suggestion" aria-label="Autopilot rule" role="status">
          <p className="rule-suggestion-title rule-suggestion-saved">
            Saved to .gg/autopilot-rules.md
          </p>
          <p className="rule-suggestion-text">{item.text}</p>
        </section>
      </div>
    );
  }

  return (
    <div className="assistant-msg ken-msg">
      <section className="rule-suggestion" aria-label="Rule suggestion">
        <p className="rule-suggestion-title">Make this an Autopilot rule?</p>
        {editing ? (
          <textarea
            className="rule-suggestion-input"
            aria-label="Rule text"
            value={draft}
            maxLength={500}
            rows={3}
            disabled={saving}
            onChange={(e) => setDraft(e.target.value)}
          />
        ) : (
          <p className="rule-suggestion-text">{draft}</p>
        )}
        {item.status === "error" && (
          <p className="rule-suggestion-error" role="alert">
            Couldn't save the rule: {item.error ?? "unknown error"}
          </p>
        )}
        <div className="rule-suggestion-actions">
          <button
            type="button"
            className="rule-suggestion-save"
            disabled={saving || !draft.trim()}
            onClick={() =>
              onAction?.(item.id, {
                type: "save",
                suggestionId: item.suggestionId,
                text: draft.trim(),
              })
            }
          >
            {saving ? "Saving…" : "Save rule"}
          </button>
          <button
            type="button"
            aria-pressed={editing}
            disabled={saving}
            onClick={() => setEditing((on) => !on)}
          >
            Edit
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => onAction?.(item.id, { type: "dismiss" })}
          >
            Dismiss
          </button>
        </div>
      </section>
    </div>
  );
}
