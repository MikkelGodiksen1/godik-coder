import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logs: Array<{ level: string; msg: string; data?: Record<string, string> }> = [];
vi.mock("../logger.js", () => ({
  log: (level: string, _cat: string, msg: string, data?: Record<string, string>) => {
    logs.push({ level, msg, ...(data ? { data } : {}) });
  },
}));

const { McpOAuthStore } = await import("./oauth-store.js");
const { guardRefreshFetch } = await import("./oauth-refresh.js");

const TOKEN_URL = "https://auth.example.test/oauth/token";
const refreshBody = (rt: string) =>
  new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt, client_id: "cid" });

describe("guardRefreshFetch", () => {
  let dir: string;
  let store: InstanceType<typeof McpOAuthStore>;

  beforeEach(async () => {
    logs.length = 0;
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-mcp-refresh-"));
    store = new McpOAuthStore(path.join(dir, "mcp-auth.json"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("passes non-refresh requests straight through, unlogged", async () => {
    const base = vi.fn(async () => new Response("{}", { status: 200 }));
    const f = guardRefreshFetch("trello", store, base);
    await f("https://mcp.example.test/v1", { method: "POST", body: "{}" });
    expect(base).toHaveBeenCalledTimes(1);
    expect(logs).toEqual([]);
  });

  it("logs a refresh attempt and its success (expiry + rotation, never token values)", async () => {
    await store.patch("trello", {
      tokens: { access_token: "A1", refresh_token: "R1", token_type: "Bearer" },
    });
    const base = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "A2",
            refresh_token: "R2",
            token_type: "Bearer",
            expires_in: 28800,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    const res = await guardRefreshFetch(
      "trello",
      store,
      base,
    )(TOKEN_URL, { method: "POST", body: refreshBody("R1") });
    expect(res.ok).toBe(true);
    expect(logs.map((l) => l.msg)).toEqual([
      'MCP OAuth refresh attempt for "trello"',
      'MCP OAuth refresh ok for "trello"',
    ]);
    expect(logs[1].data).toEqual({ expiresIn: "28800", rotated: "true" });
    expect(JSON.stringify(logs)).not.toMatch(/A1|A2|R1|R2/);
  });

  it("logs a failed refresh with the OAuth error code and description (no secrets)", async () => {
    await store.patch("trello", {
      tokens: { access_token: "A1", refresh_token: "R1", token_type: "Bearer" },
    });
    const base = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: "invalid_grant",
            error_description: "Unknown or invalid refresh token.",
          }),
          {
            status: 403,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    const res = await guardRefreshFetch(
      "trello",
      store,
      base,
    )(TOKEN_URL, { method: "POST", body: refreshBody("R1") });
    expect(res.status).toBe(403);
    expect(logs[1]).toEqual({
      level: "WARN",
      msg: 'MCP OAuth refresh failed for "trello"',
      data: {
        status: "403",
        error: "invalid_grant",
        description: "Unknown or invalid refresh token.",
      },
    });
    expect(JSON.stringify(logs)).not.toMatch(/R1|A1/);
  });

  it("logs a network failure of the refresh and rethrows it", async () => {
    await store.patch("trello", {
      tokens: { access_token: "A1", refresh_token: "R1", token_type: "Bearer" },
    });
    const base = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(
      guardRefreshFetch(
        "trello",
        store,
        base,
      )(TOKEN_URL, { method: "POST", body: refreshBody("R1") }),
    ).rejects.toThrow("fetch failed");
    expect(logs[1]).toMatchObject({
      level: "WARN",
      msg: 'MCP OAuth refresh failed for "trello"',
      data: { error: "fetch failed" },
    });
  });

  it("serializes concurrent refreshes: the second session reuses the rotated pair instead of replaying the spent token", async () => {
    await store.patch("trello", {
      tokens: { access_token: "A1", refresh_token: "R1", token_type: "Bearer" },
    });
    let calls = 0;
    const base = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      calls++;
      const sent = (init?.body as URLSearchParams).get("refresh_token");
      if (sent !== "R1") {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 403 });
      }
      // The SDK persists the new pair right after the response.
      setTimeout(() => {
        void store.patch("trello", {
          tokens: { access_token: "A2", refresh_token: "R2", token_type: "Bearer" },
        });
      }, 20);
      return new Response(
        JSON.stringify({
          access_token: "A2",
          refresh_token: "R2",
          token_type: "Bearer",
          expires_in: 28800,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    const sessionA = guardRefreshFetch("trello", store, base);
    const sessionB = guardRefreshFetch("trello", store, base);
    const [a, b] = await Promise.all([
      sessionA(TOKEN_URL, { method: "POST", body: refreshBody("R1") }),
      sessionB(TOKEN_URL, { method: "POST", body: refreshBody("R1") }),
    ]);
    expect(calls).toBe(1);
    expect(a.ok && b.ok).toBe(true);
    const bBody = (await b.json()) as { access_token: string; refresh_token: string };
    expect(bBody).toMatchObject({ access_token: "A2", refresh_token: "R2" });
    expect(logs.map((l) => l.msg)).toContain(
      'MCP OAuth refresh for "trello" skipped: already refreshed by another session',
    );
  });
});
