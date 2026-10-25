import { describe, expect, it } from "vitest";
import { MAX_GAS_BACKGROUND, MAX_GAS_INSTRUCTION, wrapMaxGas } from "./max-gas";

describe("MAX_GAS_BACKGROUND", () => {
  it("is the brief verbatim: starts and ends like the pasted text", () => {
    expect(
      MAX_GAS_BACKGROUND.startsWith("FABLE - MAX GAS AUTONOMOUS PRODUCTION MODE\n\nMISSION"),
    ).toBe(true);
    expect(MAX_GAS_BACKGROUND.endsWith("Maksimal produktivitet.\n\nMAX GAS MODE: ENGAGED.")).toBe(
      true,
    );
    // A few lines from the middle, byte for byte (Danish letters, arrows, bullets).
    expect(MAX_GAS_BACKGROUND).toContain(
      "Undersøg → Planlæg → Implementér → Test → Fejlret → Commit → Push → Preview → Verificér → Merge → Production Deploy → Smoke Test → Rapportér.",
    );
    expect(MAX_GAS_BACKGROUND).toContain("🟢 LIVE I PRODUCTION - Klar til brug.");
    expect(MAX_GAS_BACKGROUND).toContain("🔴 IKKE I PRODUCTION - Årsag og resterende handlinger.");
  });
  it("has the placeholder task section taken out, one separator left in its place", () => {
    expect(MAX_GAS_BACKGROUND).not.toContain("[INDSÆT OPGAVER HER]");
    expect(MAX_GAS_BACKGROUND).not.toMatch(/^OPGAVER$/m);
    expect(MAX_GAS_BACKGROUND).toContain("verificeret i production.\n\n⸻\n\nEXECUTION DIRECTIVE");
  });
  it("carries none of the paste markers", () => {
    for (const text of [MAX_GAS_BACKGROUND, MAX_GAS_INSTRUCTION]) {
      expect(text).not.toContain("FABLE_START");
      expect(text).not.toContain("FABLE_END");
      expect(text).not.toContain("<<<");
    }
  });
});

describe("wrapMaxGas", () => {
  it("puts the instruction first, the task second and the background last", () => {
    const text = wrapMaxGas("Ship the invoice export");
    const instruction = text.indexOf(MAX_GAS_INSTRUCTION);
    const task = text.indexOf("Ship the invoice export");
    const background = text.indexOf(MAX_GAS_BACKGROUND);
    expect(instruction).toBe(0);
    expect(task).toBeGreaterThan(instruction + MAX_GAS_INSTRUCTION.length);
    expect(background).toBeGreaterThan(task);
    expect(text.endsWith(MAX_GAS_BACKGROUND)).toBe(true);
  });
  it("includes the background verbatim, once", () => {
    const text = wrapMaxGas("task");
    expect(text.split(MAX_GAS_BACKGROUND)).toHaveLength(2);
  });
  it("trims the task but changes nothing inside it", () => {
    expect(wrapMaxGas("  two\nlines  ")).toContain("\n\ntwo\nlines\n\n");
  });
});
