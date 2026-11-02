import { describe, expect, it } from "vitest";
import * as brand from "./brand";
import { brandText, CODER_NAME, MENTOR_HANDLE, MENTOR_NAME } from "./brand";

/** The app's own source files as text, keyed by "./Name.tsx" (tests excluded). */
const SOURCES = import.meta.glob<string>(["./**/*.{ts,tsx}", "!./**/*.test.{ts,tsx}"], {
  query: "?raw",
  import: "default",
  eager: true,
});
const BRAND_FILES = import.meta.glob<string>(
  ["./brand.ts", "../../packages/ggcoder/src/core/brand.ts"],
  { query: "?raw", import: "default", eager: true },
);

describe("brandText", () => {
  it("renames the mentor and the coding agent in upstream copy", () => {
    expect(
      brandText("Say hey to `@Ken`. Ken Kai built GG Coder; Ken's review keeps GG honest."),
    ).toBe(
      `Say hey to \`${MENTOR_HANDLE}\`. ${MENTOR_NAME} built ${CODER_NAME}; ${MENTOR_NAME}'s review keeps ${CODER_NAME} honest.`,
    );
    expect(brandText("Open GG Goals, GG Chat or GG Motion. Checks passed. GG.")).toBe(
      `Open ${CODER_NAME} Goals, ${CODER_NAME} Chat or ${CODER_NAME} Motion. Checks passed. ${CODER_NAME}.`,
    );
  });

  it("leaves names inside identifiers, paths, links and pixel art alone", () => {
    for (const text of [
      "`Kencode search` is back",
      "github.com/KenKaiii/gg-framework/blob/main/GG-WORLD-PRIVACY.md",
      "GG_DEBUG=1 and ~/.gg/auth.json",
      "GG.....",
      "..GG..",
    ])
      expect(brandText(text)).toBe(text);
  });
});

describe("brand.ts", () => {
  it("matches packages/ggcoder/src/core/brand.ts exactly, apart from the header comment", () => {
    const code = (file: string) =>
      (BRAND_FILES[file] ?? "")
        .split("\n")
        .filter((line) => !line.startsWith("//"))
        .join("\n");
    expect(code("./brand.ts")).toContain("export function brandText");
    expect(code("./brand.ts")).toBe(code("../../packages/ggcoder/src/core/brand.ts"));
    expect(Object.keys(brand).sort()).toContain("APP_NAME");
  });
});

// Guard for upstream merges: a new hard-coded "Ken" / "GG" / "GG Coder" label in
// the app's own code fails here. Use a brand.ts constant (or brandText for
// upstream copy) instead. See GODIK.md.
const UNBRANDED = /(?<![\w/.-])(?:Ken Kai|Ken|GG Coder|GG)(?![\w/-]|\.\.)/;
// changelog.ts stays byte-identical to upstream; changelog-brand.ts brands it.
const SKIP_FILES = new Set(["changelog.ts", "brand.ts"]);
// Deliberate upstream names: an on-disk folder that must keep its name, and
// upstream's highlight terms, which WhatsNewParts maps through brandText.
const ALLOWED: Readonly<Record<string, readonly RegExp[]>> = {
  "motion-workspace.ts": [/MOTION_FOLDER_NAME = "GG Motion"/],
  "WhatsNewParts.tsx": [/^\s*"(Send to GG Coder|@Ken)",$/],
};

/** Source lines with comments blanked out, line numbers kept. */
function codeLines(source: string): string[] {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, ""));
}

describe("whitelabel guard", () => {
  it("has no unbranded Ken / GG labels in gg-app/src", () => {
    const files = Object.entries(SOURCES).filter(
      ([file]) => !SKIP_FILES.has(file.slice(file.lastIndexOf("/") + 1)),
    );
    expect(files.length).toBeGreaterThan(100);
    const hits = files.flatMap(([file, source]) => {
      const allowed = ALLOWED[file.slice(file.lastIndexOf("/") + 1)] ?? [];
      return codeLines(source)
        .map((line, i) => ({ line, at: `${file}:${i + 1}` }))
        .filter(({ line }) => UNBRANDED.test(line) && !allowed.some((ok) => ok.test(line)))
        .map(({ line, at }) => `${at}: ${line.trim()}`);
    });
    expect(hits).toEqual([]);
  });
});
