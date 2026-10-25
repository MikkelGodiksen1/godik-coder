import { describe, expect, it } from "vitest";
import { toggleMentorPrefix } from "./mentor";

describe("toggleMentorPrefix", () => {
  it("adds @Mentor to an empty draft", () => {
    expect(toggleMentorPrefix("")).toBe("@Mentor ");
  });
  it("adds @Mentor in front of an existing draft", () => {
    expect(toggleMentorPrefix("  why is this slow?")).toBe("@Mentor why is this slow?");
  });
  it("removes a leading @Mentor or @ken (any casing, optional colon)", () => {
    expect(toggleMentorPrefix("@Mentor: why is this slow?")).toBe("why is this slow?");
    expect(toggleMentorPrefix("@Ken: why is this slow?")).toBe("why is this slow?");
    expect(toggleMentorPrefix("@mentor ")).toBe("");
  });
  it("leaves a file mention like @kennedy.ts alone", () => {
    expect(toggleMentorPrefix("@kennedy.ts")).toBe("@Mentor @kennedy.ts");
  });
});
