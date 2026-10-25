/**
 * GODIK CODER: the deck's Mentor key. Pressing it puts `@ken ` in front of the
 * draft so the next message goes to Ken (the mentor), not the code session;
 * pressing it again takes it off. Sending clears the draft, so the composer
 * goes back to normal after one message.
 */
const KEN_PREFIX = /^\s*@ken\b:?\s*/i;

export function toggleMentorPrefix(input: string): string {
  return KEN_PREFIX.test(input) ? input.replace(KEN_PREFIX, "") : `@ken ${input.trimStart()}`;
}
