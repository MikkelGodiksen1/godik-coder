import { describe, expect, it } from "vitest";
import { MENTOR_DEFAULT_QUESTION, toggleMentorPrefix } from "./mentor";

const caret = (text: string) => ({ text, selection: { start: text.length, end: text.length } });

describe("toggleMentorPrefix", () => {
  it("fills an empty draft with @Mentor and the default question, selecting the question", () => {
    const filled = "@Mentor hvad siger du?";
    const want = { text: filled, selection: { start: "@Mentor ".length, end: filled.length } };
    expect(MENTOR_DEFAULT_QUESTION).toBe("hvad siger du?");
    expect(toggleMentorPrefix("")).toEqual(want);
    expect(toggleMentorPrefix("  \n\t ")).toEqual(want);
    const { text, selection } = toggleMentorPrefix("");
    expect(text.slice(selection.start, selection.end)).toBe(MENTOR_DEFAULT_QUESTION);
  });
  it("adds only @Mentor in front of an existing draft, caret at the end", () => {
    expect(toggleMentorPrefix("  why is this slow?")).toEqual(caret("@Mentor why is this slow?"));
  });
  it("removes a leading @Mentor or @ken (any casing, optional colon)", () => {
    expect(toggleMentorPrefix("@Mentor: why is this slow?")).toEqual(caret("why is this slow?"));
    expect(toggleMentorPrefix("@Ken: why is this slow?")).toEqual(caret("why is this slow?"));
    expect(toggleMentorPrefix("@mentor ")).toEqual(caret(""));
  });
  it("clears the composer when toggling off the untouched default question", () => {
    const { text } = toggleMentorPrefix("");
    expect(toggleMentorPrefix(text)).toEqual(caret(""));
  });
  it("keeps an edited question when toggling off", () => {
    expect(toggleMentorPrefix("@Mentor hvad siger du? om testen")).toEqual(
      caret("hvad siger du? om testen"),
    );
    expect(toggleMentorPrefix("@Mentor hvad siger du")).toEqual(caret("hvad siger du"));
  });
  it("leaves a file mention like @kennedy.ts alone", () => {
    expect(toggleMentorPrefix("@kennedy.ts")).toEqual(caret("@Mentor @kennedy.ts"));
  });
});
