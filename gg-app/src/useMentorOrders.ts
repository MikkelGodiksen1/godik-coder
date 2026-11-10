/**
 * GODIK CODER: Mentor-ordre rows. Follows the sidecar's mentor_order_* frames
 * and keeps each "Ordre til mentor" row's status current. On every `ready`
 * (a fresh or reconnected event stream) it asks the sidecar which order is
 * still waiting, so an order a sidecar restart lost says so instead of
 * sitting at "Venter" forever.
 */
import { useCallback, type Dispatch, type SetStateAction } from "react";
import { getMentorOrderSnapshot, type MentorOrderStatus, type SidecarEvent } from "./agent";
import type { Item } from "./transcript-item";

type OrderItem = Extract<Item, { kind: "mentor_order" }>;

const OUTCOMES: readonly MentorOrderStatus[] = ["prompted", "held", "done", "nothing", "cancelled"];
const OPEN: readonly MentorOrderStatus[] = ["pending", "reviewing"];

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

export function useMentorOrders({
  setItems,
  nextId,
}: {
  setItems: Dispatch<SetStateAction<Item[]>>;
  nextId: () => number;
}): {
  /** Add the row for an order this window just stored (no-op if the frame beat it). */
  addOrder: (orderId: string, text: string) => void;
  handleMentorOrderEvent: (e: SidecarEvent) => boolean;
} {
  const update = useCallback(
    (orderId: string, patch: Partial<OrderItem>, onlyOpen = false) => {
      setItems((prev) =>
        prev.map((it) =>
          it.kind === "mentor_order" &&
          it.orderId === orderId &&
          (!onlyOpen || OPEN.includes(it.status))
            ? { ...it, ...patch }
            : it,
        ),
      );
    },
    [setItems],
  );

  const addOrder = useCallback(
    (orderId: string, text: string) => {
      setItems((prev) =>
        prev.some((it) => it.kind === "mentor_order" && it.orderId === orderId)
          ? prev
          : [...prev, { kind: "mentor_order", id: nextId(), orderId, text, status: "pending" }],
      );
    },
    [setItems, nextId],
  );

  const reconcile = useCallback(async () => {
    const snapshot = await getMentorOrderSnapshot();
    if (!snapshot) return;
    setItems((prev) =>
      prev.map((it) => {
        if (it.kind !== "mentor_order" || !OPEN.includes(it.status)) return it;
        if (snapshot.pending?.id === it.orderId) return { ...it, status: "pending" };
        if (snapshot.firing?.id === it.orderId) return { ...it, status: "reviewing" };
        const result = snapshot.recent.find((r) => r.id === it.orderId);
        if (result && OUTCOMES.includes(result.outcome)) {
          return {
            ...it,
            status: result.outcome,
            ...(result.reason ? { reason: result.reason } : {}),
            ...(result.body ? { body: result.body } : {}),
          };
        }
        return { ...it, status: "lost" };
      }),
    );
  }, [setItems]);

  const handleMentorOrderEvent = useCallback(
    (e: SidecarEvent): boolean => {
      const d = e.data as Record<string, unknown>;
      const orderId = str(d.id);
      switch (e.type) {
        case "mentor_order":
          if (orderId) addOrder(orderId, typeof d.text === "string" ? d.text : "");
          return true;
        case "mentor_order_fired":
          if (orderId) update(orderId, { status: "reviewing" }, true);
          return true;
        case "mentor_order_result": {
          const outcome = d.outcome as MentorOrderStatus;
          if (orderId && OUTCOMES.includes(outcome)) {
            const patch = {
              status: outcome,
              ...(str(d.reason) ? { reason: str(d.reason) } : {}),
              ...(str(d.body) ? { body: str(d.body) } : {}),
            };
            const text = str(d.text);
            // An approved plan starts a fresh session, which clears the
            // transcript and the order's row with it. The result carries the
            // order text, so the row comes back with its outcome.
            setItems((prev) =>
              prev.some((it) => it.kind === "mentor_order" && it.orderId === orderId)
                ? prev.map((it) =>
                    it.kind === "mentor_order" && it.orderId === orderId ? { ...it, ...patch } : it,
                  )
                : text
                  ? [...prev, { kind: "mentor_order", id: nextId(), orderId, text, ...patch }]
                  : prev,
            );
          }
          return true;
        }
        case "mentor_order_cleared":
          if (orderId) update(orderId, { status: "cancelled" }, true);
          return true;
        case "ready":
          // Peek only: the main handler still processes `ready`.
          void reconcile();
          return false;
        default:
          return false;
      }
    },
    [addOrder, update, reconcile, setItems, nextId],
  );

  return { addOrder, handleMentorOrderEvent };
}
