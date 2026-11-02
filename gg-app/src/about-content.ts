import { CODER_NAME, MENTOR_NAME } from "./brand";
import type { KenFace } from "./goal-ken-talk";
import { formatMonthYear, type ShipLog } from "./about-ship-log";

/**
 * When GG Coder began: the repo's first commit, as the command-line tool. The
 * desktop app came later; its first release is the changelog's oldest entry.
 */
export const GG_CODER_STARTED = "2026-03-04";

/** One thing Ken says in his box, with the face he says it with. */
export interface KenSay {
  readonly face: KenFace;
  readonly text: string;
}

/**
 * What Ken says on the About page: a few plain sentences, each short enough to
 * fit his box's three lines.
 */
export function aboutLines(log: ShipLog): readonly KenSay[] {
  return [
    {
      face: "happy",
      text: `Hey, I'm ${MENTOR_NAME}, your mentor in GODIK CODER. I read along while ${CODER_NAME} builds.`,
    },
    {
      face: "neutral",
      text: `${CODER_NAME} started as a command-line tool in ${formatMonthYear(GG_CODER_STARTED)}. This desktop app came along in ${formatMonthYear(log.firstDate)}.`,
    },
    {
      face: "thinking",
      text: `Stuck or unsure? Press Mentor and ask me. I'll hand you a prompt you can send to ${CODER_NAME}.`,
    },
    {
      face: "happy",
      text: `Turn on Autopilot and I'll review every turn, so ${CODER_NAME} keeps going until the work holds up.`,
    },
  ];
}
