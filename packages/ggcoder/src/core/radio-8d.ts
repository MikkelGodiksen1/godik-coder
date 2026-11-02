import type { RadioStation } from "./radio.js";

// GODIK CODER fork: 8D radio. Royalty-free streams get an 8D effect applied
// locally (the sound circles the listener's head), since no reliable free 8D
// stream exists. Kept out of radio.ts so upstream merges stay small.

/** ffmpeg filter: pan left↔right once every 8 s, plus a light room echo. */
export const EIGHT_D_FILTER = "apulsator=hz=0.125:amount=0.85,aecho=0.8:0.7:50:0.2";

export const EIGHT_D_STATIONS: readonly RadioStation[] = [
  {
    id: "8d-groove-salad",
    name: "8D · Groove Salad",
    description: "Chilled downtempo circling your head (use headphones)",
    url: "http://ice1.somafm.com/groovesalad-128-mp3",
    effect: "8d",
  },
  {
    id: "8d-chillsynth",
    name: "8D · Chillsynth",
    description: "Downtempo synthwave circling your head (use headphones)",
    url: "https://stream.nightride.fm/chillsynth.mp3",
    effect: "8d",
  },
  {
    id: "8d-nightwave-plaza",
    name: "8D · Nightwave Plaza",
    description: "Vaporwave and future funk circling your head (use headphones)",
    url: "https://radio.plaza.one/mp3",
    effect: "8d",
  },
];

/**
 * Player args with the 8D filter added before the stream url, or null when the
 * player can't run ffmpeg filters (mpg123, cvlc), so 8D never plays as plain stereo.
 */
export function withEightD(cmd: string, args: readonly string[]): string[] | null {
  const url = args.at(-1);
  if (url === undefined) return null;
  const head = args.slice(0, -1);
  if (cmd === "mpv") return [...head, `--af=lavfi=[${EIGHT_D_FILTER}]`, url];
  if (cmd === "ffplay") return [...head, "-af", EIGHT_D_FILTER, url];
  return null;
}

export const EIGHT_D_INSTALL_HINT =
  "8D radio needs mpv or ffmpeg. On macOS: `brew install mpv` (or `brew install ffmpeg`).";
