/**
 * GODIK CODER: the "Ordre til mentor" row. Shows the order the user gave with
 * the deck's Mentor-ordre key and where it stands: waiting for GC's turn to
 * end, being reviewed, sent to GC, held (with why), done, nothing to do,
 * cancelled, or lost to a sidecar restart. A waiting order can be cancelled.
 */
import { useState } from "react";
import { setMentorOrder } from "./agent";
import { CODER_NAME, MENTOR_NAME } from "./brand";
import { Markdown } from "./Markdown";
import { toast } from "./toast";
import type { Item } from "./transcript-item";

export type MentorOrderItem = Extract<Item, { kind: "mentor_order" }>;

const STATUS_LABEL: Record<MentorOrderItem["status"], string> = {
  pending: `Venter på at ${CODER_NAME} bliver færdig`,
  reviewing: `${MENTOR_NAME} læser ${CODER_NAME}'s tur`,
  prompted: `Sendt til ${CODER_NAME}`,
  held: "Holdt",
  done: "Udført",
  nothing: "Intet at gøre",
  cancelled: "Annulleret",
  lost: "Mistet: sidecaren genstartede, før ordren nåede at køre. Giv den igen.",
};

export function MentorOrderRow({ item }: { item: MentorOrderItem }): React.ReactElement {
  const [cancelling, setCancelling] = useState(false);
  const detail = item.status === "prompted" ? item.body : item.reason;
  async function cancel(): Promise<void> {
    setCancelling(true);
    const res = await setMentorOrder("");
    // The sidecar's mentor_order_cleared frame flips the row to Annulleret.
    if (!res.ok) {
      setCancelling(false);
      toast(`Kunne ikke annullere ordren: ${res.error}`, "error");
    }
  }
  return (
    <div className="assistant-msg ken-msg mentor-order-row" data-status={item.status}>
      <section className="rule-suggestion mentor-order" aria-label="Ordre til mentor">
        <p className="rule-suggestion-title">Ordre til mentor</p>
        <p className="rule-suggestion-text">{item.text}</p>
        <p className="mentor-order-status" role="status">
          {STATUS_LABEL[item.status]}
        </p>
        {detail?.trim() && (
          <div className="mentor-order-detail">
            <Markdown>{detail.trim()}</Markdown>
          </div>
        )}
        {item.status === "pending" && (
          <div className="rule-suggestion-actions">
            <button type="button" disabled={cancelling} onClick={() => void cancel()}>
              Annuller ordre
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
