/**
 * GODIK CODER: the deck's Mentor key. Pressing it puts `@ken ` in front of the
 * draft so the next message goes to Ken (the mentor), not the code session;
 * pressing it again takes it off. Sending clears the draft, so the composer
 * goes back to normal after one message.
 */
/** The mentor's visible handle. `@ken` still works as a typed alias. */
export const MENTOR_HANDLE = "@Mentor";

const KEN_PREFIX = /^\s*@(?:ken|mentor)\b:?\s*/i;

export function toggleMentorPrefix(input: string): string {
  return KEN_PREFIX.test(input)
    ? input.replace(KEN_PREFIX, "")
    : `${MENTOR_HANDLE} ${input.trimStart()}`;
}
