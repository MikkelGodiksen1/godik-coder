import { describe, expect, it } from "vitest";
import {
  orderReviewingPlan,
  shouldOfferPendingPlan,
  type PendingPlanOfferInput,
} from "./plan-handoff.js";

const settled: PendingPlanOfferInput = {
  planPath: "/repo/.gg/plans/p.md",
  generation: 3,
  offeredGeneration: -1,
  running: false,
  starting: false,
  autopilotActive: false,
  queued: 0,
};

describe("shouldOfferPendingPlan", () => {
  it("offers a pending plan once everything has settled", () => {
    expect(shouldOfferPendingPlan(settled)).toBe(true);
  });

  it.each<[string, Partial<PendingPlanOfferInput>]>([
    ["no plan is pending", { planPath: null }],
    ["this plan was already offered", { offeredGeneration: 3 }],
    ["the submitting run is still finishing", { running: true }],
    ["a run is about to start", { starting: true }],
    ["Ken is still reviewing", { autopilotActive: true }],
    ["a queued message will supersede it", { queued: 1 }],
    ["a Mentor-ordre will decide about it first", { orderPending: true }],
  ])("holds back when %s", (_label, change) => {
    expect(shouldOfferPendingPlan({ ...settled, ...change })).toBe(false);
  });

  it("offers a resubmitted plan again (new generation)", () => {
    expect(shouldOfferPendingPlan({ ...settled, generation: 5, offeredGeneration: 3 })).toBe(true);
  });
});

describe("orderReviewingPlan", () => {
  const reviewing = {
    orderFiring: true,
    reviewing: true,
    planPath: "/p/plan.md",
    running: false,
  };
  it("is true only while a firing order reviews a pending plan with GC idle", () => {
    expect(orderReviewingPlan(reviewing)).toBe(true);
    expect(orderReviewingPlan({ ...reviewing, orderFiring: false })).toBe(false);
    expect(orderReviewingPlan({ ...reviewing, reviewing: false })).toBe(false);
    expect(orderReviewingPlan({ ...reviewing, planPath: null })).toBe(false);
    expect(orderReviewingPlan({ ...reviewing, running: true })).toBe(false);
  });
});
