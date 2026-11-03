import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const makeChild = (streams: Record<string, unknown> = {}) => ({
    pid: 987_654_321,
    exitCode: null,
    killed: false,
    once: vi.fn(),
    unref: vi.fn(),
    kill: vi.fn(),
    ...streams,
  });
  const child = makeChild();
  const ffmpeg = makeChild({ stdin: { on: vi.fn(), write: vi.fn() } });
  let installed: readonly string[] = ["mpv"];
  return {
    install(players: readonly string[]) {
      installed = players;
    },
    spawn: vi.fn((command: unknown, _args: readonly string[], _options: unknown) =>
      String(command).endsWith("/ffmpeg") ? ffmpeg : child,
    ),
    existsSync: vi.fn((candidate: unknown) =>
      installed.some((player) => String(candidate).endsWith(`/${player}`)),
    ),
    createConnection: vi.fn(() => ({ once: vi.fn(), end: vi.fn(), destroy: vi.fn() })),
  };
});

vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:fs", () => ({ existsSync: mocks.existsSync }));
vi.mock("node:net", () => ({ createConnection: mocks.createConnection }));

import { RADIO_STATIONS, getCurrentStation, playRadio, stopRadio } from "./radio.js";
import { EIGHT_D_FILTER, EIGHT_D_STATIONS } from "./radio-8d.js";

afterEach(() => {
  stopRadio();
  mocks.install(["mpv"]);
  vi.clearAllMocks();
});

describe("8D radio", () => {
  it("lists 8D stations built on the radio's own verified streams", () => {
    const upstream = RADIO_STATIONS.filter((station) => station.effect !== "8d");
    expect(RADIO_STATIONS).toEqual(expect.arrayContaining([...EIGHT_D_STATIONS]));
    for (const station of EIGHT_D_STATIONS) {
      expect(station.id).toMatch(/^8d-/);
      expect(station.name).toMatch(/^8D · /);
      expect(station.description).toMatch(/circling your head \(use headphones\)$/);
      expect(station.effect).toBe("8d");
      expect(upstream.map((s) => s.url)).toContain(station.url);
    }
  });

  it("plays an 8D station through mpv with the 8D filter before the url", () => {
    expect(playRadio("8d-groove-salad")).toEqual({ ok: true });
    const args = mocks.spawn.mock.calls[0]?.[1] ?? [];
    expect(args.slice(-2)).toEqual([
      `--af=lavfi=[${EIGHT_D_FILTER}]`,
      "http://ice1.somafm.com/groovesalad-128-mp3",
    ]);
    expect(getCurrentStation()).toBe("8d-groove-salad");
  });

  it("leaves ordinary stations without the 8D filter", () => {
    expect(playRadio("somafm-groove-salad")).toEqual({ ok: true });
    const args = mocks.spawn.mock.calls[0]?.[1] ?? [];
    expect(args.join(" ")).not.toContain("apulsator");
  });

  it.runIf(process.platform === "darwin")(
    "adds the 8D filter after the live volume on native macOS ffmpeg",
    () => {
      mocks.install(["ffplay", "ffmpeg"]);
      expect(playRadio("8d-chillsynth")).toEqual({ ok: true });
      expect(mocks.spawn).toHaveBeenCalledWith(
        expect.stringMatching(/ffmpeg$/),
        expect.arrayContaining([`volume@radio=0.7,${EIGHT_D_FILTER}`, "audiotoolbox"]),
        expect.anything(),
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "refuses to play 8D as plain stereo when only mpg123 is installed",
    () => {
      mocks.install(["mpg123"]);
      const result = playRadio("8d-nightwave-plaza");
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/8D radio needs mpv or ffmpeg/);
      expect(mocks.spawn).not.toHaveBeenCalled();
      expect(getCurrentStation()).toBeNull();
    },
  );
});
