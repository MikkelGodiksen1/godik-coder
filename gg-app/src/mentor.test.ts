import { describe, expect, it } from "vitest";
import { toggleMentorPrefix } from "./mentor";

describe("toggleMentorPrefix", () => {
  it("adds @ken to an empty draft", () => {
    expect(toggleMentorPrefix("")).toBe("@ken ");
  });
  it("adds @ken in front of an existing draft", () => {
    expect(toggleMentorPrefix("  why is this slow?")).toBe("@ken why is this slow?");
  });
  it("removes a leading @ken (any casing, optional colon)", () => {
    expect(toggleMentorPrefix("@Ken: why is this slow?")).toBe("why is this slow?");
    expect(toggleMentorPrefix("@ken ")).toBe("");
  });
  it("leaves a file mention like @kennedy.ts alone", () => {
    expect(toggleMentorPrefix("@kennedy.ts")).toBe("@ken @kennedy.ts");
  });
});
