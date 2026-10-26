import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { MCPClientManager } from "./client.js";
import { McpCatalogCache } from "./catalog-cache.js";
import { McpOAuthStore } from "./oauth-store.js";
import { mcpOAuthRedirectUrl } from "./oauth-provider.js";
import type { MCPServerConfig } from "./types.js";

/**
 * A fake REMOTE MCP server behind OAuth (a non-loopback host, so the manager
 * attaches its OAuth provider exactly as for Trello), served from a stubbed
 * global fetch: protected-resource metadata, authorization-server metadata,
 * a rotating-refresh token endpoint and a minimal Streamable-HTTP MCP endpoint.
 */
const MCP_URL = "https://mcp.example.test/v1";
const ISSUER = "https://auth.example.test";
const TOKEN_URL = `${ISSUER}/oauth/token`;

interface FakeRemote {
  validAccess: Set<string>;
  refreshes: number;
  /** refresh token → the pair it mints (single use: rotates). */
  refreshable: Map<string, { access: string; refresh: string }>;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function fakeFetch(remote: FakeRemote) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? String(input) : input.url,
    );
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.href === "https://mcp.example.test/.well-known/oauth-protected-resource/v1") {
      return json({ resource: MCP_URL, authorization_servers: [ISSUER] });
    }
    if (
      url.origin === ISSUER &&
      url.pathname.startsWith("/.well-known/oauth-authorization-server")
    ) {
      return json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: TOKEN_URL,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (url.origin === ISSUER && url.pathname.startsWith("/.well-known/"))
      return new Response("", { status: 404 });
    if (url.href === TOKEN_URL && method === "POST") {
      const params = new URLSearchParams(String(init?.body ?? ""));
      const minted =
        params.get("grant_type") === "refresh_token"
          ? remote.refreshable.get(params.get("refresh_token") ?? "")
          : undefined;
      if (!minted) return json({ error: "invalid_grant" }, 403);
      remote.refreshes++;
      remote.refreshable.delete(params.get("refresh_token") ?? "");
      remote.validAccess.add(minted.access);
      return json({
        access_token: minted.access,
        refresh_token: minted.refresh,
        token_type: "Bearer",
        expires_in: 28800,
      });
    }
    if (url.href === MCP_URL) {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      const token = auth.replace(/^Bearer /i, "");
      if (!remote.validAccess.has(token)) {
        return json({ error: "invalid_token" }, 401, {
          "www-authenticate": `Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/v1"`,
        });
      }
      if (method !== "POST") return new Response("", { status: 405 });
      const msg = JSON.parse(String(init?.body ?? "{}")) as { id?: number; method?: string };
      if (msg.id === undefined) return new Response("", { status: 202 });
      if (msg.method === "initialize") {
        return json(
          {
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "fake-trello", version: "1" },
            },
          },
          200,
          { "mcp-session-id": "s1" },
        );
      }
      if (msg.method === "tools/list") {
        return json({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            tools: [
              {
                name: "get_me",
                description: "Who am I",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          },
        });
      }
      return json({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "nope" } });
    }
    return new Response("not found", { status: 404 });
  };
}

const config: MCPServerConfig = { name: "trello", url: MCP_URL } as MCPServerConfig;
const clientInformation = {
  client_id: "cid",
  redirect_uris: [mcpOAuthRedirectUrl()],
  token_endpoint_auth_method: "none",
};

describe("remote MCP OAuth: refresh + reconnect", () => {
  let dir: string;
  let store: McpOAuthStore;
  let remote: FakeRemote;
  const managers: MCPClientManager[] = [];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-mcp-oauth-"));
    store = new McpOAuthStore(path.join(dir, "mcp-auth.json"));
    remote = { validAccess: new Set(), refreshes: 0, refreshable: new Map() };
    vi.stubGlobal("fetch", fakeFetch(remote));
  });
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((m) => m.dispose().catch(() => {})));
    vi.unstubAllGlobals();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const manager = (onLateConnect?: (name: string, tools: AgentTool[]) => void) => {
    const m = new MCPClientManager({
      catalogCache: new McpCatalogCache(path.join(dir, "catalog.json")),
      oauthStore: store,
      ...(onLateConnect ? { onLateConnect } : {}),
    });
    managers.push(m);
    return m;
  };

  it("expired access token + valid refresh token → refreshes silently and connects", async () => {
    await store.patch("trello", {
      clientInformation: clientInformation as never,
      tokens: {
        access_token: "A1-expired",
        refresh_token: "R1",
        token_type: "Bearer",
        issuer: ISSUER,
      } as never,
    });
    remote.refreshable.set("R1", { access: "A2", refresh: "R2" });
    const [result] = await manager().connectAllDetailed([config]);
    expect(result).toMatchObject({ name: "trello", ok: true, toolCount: 1 });
    expect(result.tools.map((t) => t.name)).toEqual(["mcp__trello__get_me"]);
    expect(remote.refreshes).toBe(1);
    const saved = (await store.get("trello")).tokens;
    expect(saved?.access_token).toBe("A2");
    expect(saved?.refresh_token).toBe("R2");
  });

  it("dead refresh token → Requires login (no browser, nothing saved)", async () => {
    await store.patch("trello", {
      clientInformation: clientInformation as never,
      tokens: {
        access_token: "A1-expired",
        refresh_token: "R-dead",
        token_type: "Bearer",
        issuer: ISSUER,
      } as never,
    });
    const [result] = await manager().connectAllDetailed([config]);
    expect(result).toMatchObject({ ok: false, requiresAuth: true, error: "Requires login." });
    expect(remote.refreshes).toBe(0);
  });

  it("login in one session → another live session that cached Requires login reconnects and gets the tools", async () => {
    await store.patch("trello", { clientInformation: clientInformation as never });
    let late: { name: string; tools: AgentTool[] } | undefined;
    let resolveLate!: () => void;
    const lateArrived = new Promise<void>((resolve) => {
      resolveLate = resolve;
    });
    const managerB = manager((name, tools) => {
      late = { name, tools };
      resolveLate();
    });
    const [first] = await managerB.connectAllDetailed([config]);
    expect(first).toMatchObject({ ok: false, requiresAuth: true });

    // Session A finishes an interactive login: the SDK saves tokens through the store.
    remote.validAccess.add("A-login");
    await new McpOAuthStore(store.path).patch("trello", {
      tokens: {
        access_token: "A-login",
        refresh_token: "R-login",
        token_type: "Bearer",
        issuer: ISSUER,
      } as never,
    });

    await lateArrived;
    expect(late?.name).toBe("trello");
    expect(late?.tools.map((t) => t.name)).toEqual(["mcp__trello__get_me"]);
    expect(await managerB.whenConnected("trello", 1000)).toEqual({ ok: true });
  });

  it("a login written by another process (auth file changed on disk) reconnects a live session too", async () => {
    await store.patch("trello", { clientInformation: clientInformation as never });
    let resolveLate!: () => void;
    const lateArrived = new Promise<void>((resolve) => {
      resolveLate = resolve;
    });
    const m = manager(() => resolveLate());
    const [first] = await m.connectAllDetailed([config]);
    expect(first.ok).toBe(false);

    remote.validAccess.add("A-cli");
    const file = JSON.parse(await fs.readFile(store.path, "utf8")) as {
      servers: Record<string, Record<string, unknown>>;
    };
    file.servers.trello.tokens = {
      access_token: "A-cli",
      refresh_token: "R-cli",
      token_type: "Bearer",
      issuer: ISSUER,
    };
    await fs.writeFile(store.path, JSON.stringify(file)); // no in-process event: only the file watch sees it

    await lateArrived;
    expect(await m.whenConnected("trello", 1000)).toEqual({ ok: true });
  }, 10_000);

  it("a session without a late-connect consumer never watches or retries", async () => {
    await store.patch("trello", { clientInformation: clientInformation as never });
    const m = manager();
    const [first] = await m.connectAllDetailed([config]);
    expect(first.ok).toBe(false);
    remote.validAccess.add("A-x");
    await store.patch("trello", {
      tokens: { access_token: "A-x", token_type: "Bearer", issuer: ISSUER } as never,
    });
    await new Promise((r) => setTimeout(r, 400));
    expect((await m.whenConnected("trello", 50)).ok).toBe(false);
  });
});
