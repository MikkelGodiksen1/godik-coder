// GODIK CODER whitelabel: every user-visible name, in one place. Internal ids
// (ken*/gg* files, functions, routes, events, CSS classes, on-disk folders) keep
// upstream's names so upstream merges stay clean. Mirrors
// packages/ggcoder/src/core/brand.ts (brand.test.ts checks they match). See GODIK.md.
export const MENTOR_NAME = "Godik";
export const MENTOR_HANDLE = "@Mentor";
export const CODER_NAME = "GC";
export const MAKER_NAME = "Godik";
export const APP_NAME = "GODIK CODER";
export const GOALS_NAME = `${CODER_NAME} Goals`;
export const CHAT_NAME = `${CODER_NAME} Chat`;
export const MOTION_NAME = `${CODER_NAME} Motion`;

// World (upstream's 3D game) is hidden in this fork; its code stays so upstream
// merges touching World apply cleanly. Every entry point is gated on this.
export const WORLD_ENABLED = false;

// Whole words only: "Kencode", "KenKaiii", "GG_DEBUG", "GG-WORLD-PRIVACY.md",
// ".gg/" paths and pixel-art rows like "GG....." are left alone.
const REWRITES: ReadonlyArray<readonly [RegExp, string]> = [
  [/(?<![\w/.-])@Ken(?![\w/-])/g, MENTOR_HANDLE],
  [/(?<![\w/.-])Ken Kai(?![\w/-])/g, MENTOR_NAME],
  [/(?<![\w/.-])Ken(?![\w/-])/g, MENTOR_NAME],
  [/(?<![\w/.-])GG Coder(?![\w/-])/g, CODER_NAME],
  [/(?<![\w/.-])GG(?![\w/-]|\.\.)/g, CODER_NAME],
];

/** Rebrand upstream copy (release notes, trophies, error text) at display time. */
export function brandText(text: string): string {
  return REWRITES.reduce((out, [pattern, name]) => out.replace(pattern, name), text);
}
