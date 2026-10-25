/**
 * GODIK CODER: the deck's Mentor key. Pressing it puts `@Mentor ` in front of
 * the draft so the next message goes to Ken (the mentor), not the code
 * session; pressing it again takes it off. On an empty composer it also fills
 * a default question, selected so Enter sends it as-is and typing replaces it.
 * Sending clears the draft, so the composer goes back to normal after one
 * message.
 */
/** The mentor's visible handle. `@ken` still works as a typed alias. */
export const MENTOR_HANDLE = "@Mentor";

/** The question the Mentor key fills in when the composer is empty. */
export const MENTOR_DEFAULT_QUESTION = "hvad siger du?";

const KEN_PREFIX = /^\s*@(?:ken|mentor)\b:?\s*/i;

/** The composer text after a Mentor-key press, plus the range to select. */
export interface MentorToggle {
  text: string;
  /** Selection to apply; `start === end` is a plain caret. */
  selection: { start: number; end: number };
}

function caretAtEnd(text: string): MentorToggle {
  return { text, selection: { start: text.length, end: text.length } };
}

export function toggleMentorPrefix(input: string): MentorToggle {
  if (KEN_PREFIX.test(input)) {
    const rest = input.replace(KEN_PREFIX, "");
    return caretAtEnd(rest === MENTOR_DEFAULT_QUESTION ? "" : rest);
  }
  if (input.trim() === "") {
    const text = `${MENTOR_HANDLE} ${MENTOR_DEFAULT_QUESTION}`;
    return {
      text,
      selection: { start: text.length - MENTOR_DEFAULT_QUESTION.length, end: text.length },
    };
  }
  return caretAtEnd(`${MENTOR_HANDLE} ${input.trimStart()}`);
}
