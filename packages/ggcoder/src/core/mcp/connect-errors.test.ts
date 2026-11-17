import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RegistrationRejectedError } from "@modelcontextprotocol/client";
import { FIGMA_DESKTOP_MCP_URL, MCPClientManager, formatConnectError } from "./client.js";
import { McpCatalogCache } from "./catalog-cache.js";
import { McpOAuthStore } from "./oauth-store.js";
import type * as LoopbackModule from "./loopback.js";

// The fixture listens on 127.0.0.1; paths under /remote/ are treated as a
// remote host so the remote-only branches (OAuth, no-fallback rules) run.
vi.mock("./loopback.js", async () => {
  const actual = await vi.importActual<typeof LoopbackModule>("./loopback.js");
  return {
    ...actual,
    isLocalhost: (url: URL) => !url.pathname.startsWith("/remote/") && actual.isLocalhost(url),
  };
});

interface Fixture {
  base: string;
  /** Requests seen, as "METHOD /path". */
  seen: string[];
  close: () => Promise<void>;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

function rpcResult(message: { id?: unknown; method?: string; params?: unknown }): unknown {
  if (message.method === "initialize") {
    const requested = (message.params as { protocolVersion?: string } | undefined)?.protocolVersion;
    return {
      protocolVersion: requested ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "legacy-sse-fixture", version: "1.0.0" },
    };
  }
  if (message.method === "tools/list") {
    return {
      tools: [{ name: "ping_tool", description: "Ping", inputSchema: { type: "object" } }],
    };
  }
  return {};
}

async function startFixture(): Promise<Fixture> {
  const seen: string[] = [];
  const streams = new Map<string, http.ServerResponse>();
  let base = "";

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", base);
    seen.push(`${req.method} ${url.pathname}`);
    const sendJson = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };

    // A modern server whose OAuth only registers allow-listed clients (Figma).
    if (url.pathname === "/remote/dcr/mcp") {
      if (req.method === "POST") {
        sendJson(
          401,
          { error: "unauthorized" },
          {
            "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/remote/dcr/mcp"`,
          },
        );
      } else {
        res.writeHead(405).end();
      }
      return;
    }
    if (url.pathname === "/.well-known/oauth-protected-resource/remote/dcr/mcp") {
      sendJson(200, { resource: `${base}/remote/dcr/mcp`, authorization_servers: [base] });
      return;
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      sendJson(200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      });
      return;
    }
    if (url.pathname === "/register") {
      sendJson(403, { error: "forbidden", error_description: "Client not allowed" });
      return;
    }

    // A modern server that forbids us outright; GET (the SSE fallback) is 405.
    if (url.pathname === "/remote/forbidden/mcp") {
      if (req.method === "POST") res.writeHead(403, "Forbidden").end();
      else res.writeHead(405, "Method Not Allowed").end();
      return;
    }

    // A legacy HTTP+SSE server: POST to the SSE URL is not offered, GET opens
    // the event stream, and replies to /messages travel back over it.
    if (url.pathname === "/remote/sse" || url.pathname === "/local/sse") {
      if (req.method === "POST") {
        // Localhost servers like Playwright's answer 401 here; it isn't auth.
        res.writeHead(url.pathname === "/local/sse" ? 401 : 405).end();
        return;
      }
      const session = String(streams.size + 1);
      streams.set(session, res);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const messages = url.pathname.replace(/sse$/, "messages");
      res.write(`event: endpoint\ndata: ${messages}?session=${session}\n\n`);
      return;
    }
    if (url.pathname === "/remote/messages" || url.pathname === "/local/messages") {
      void readBody(req).then((raw) => {
        const stream = streams.get(url.searchParams.get("session") ?? "");
        if (!stream) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(202).end();
        const message = JSON.parse(raw) as { id?: unknown; method?: string; params?: unknown };
        if (message.id === undefined || message.id === null) return;
        const reply = { jsonrpc: "2.0", id: message.id, result: rpcResult(message) };
        stream.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
      });
      return;
    }

    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        for (const stream of streams.values()) stream.end();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

let dir: string;
let fixture: Fixture;
const managers: MCPClientManager[] = [];

function manager(): MCPClientManager {
  const instance = new MCPClientManager({
    catalogCache: new McpCatalogCache(path.join(dir, "mcp-catalog.json")),
    oauthStore: new McpOAuthStore(path.join(dir, "mcp-auth.json")),
  });
  managers.push(instance);
  return instance;
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-mcp-connect-errors-"));
  fixture = await startFixture();
});

afterEach(async () => {
  await Promise.all(managers.splice(0).map((instance) => instance.dispose()));
  await fixture.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("remote MCP connect errors", () => {
  it("reports a refused client registration instead of the SSE fallback's 405", async () => {
    const [result] = await manager().connectAllDetailed([
      { name: "allowlisted", url: `${fixture.base}/remote/dcr/mcp`, timeout: 10_000 },
    ]);

    expect(result?.ok).toBe(false);
    expect(result?.requiresAuth).toBe(false);
    expect(result?.error).toContain("only lets approved apps connect");
    expect(result?.error).toContain("HTTP 403 from client registration");
    expect(result?.error).not.toContain("405");
    expect(fixture.seen).toContain("POST /register");
    // No legacy SSE attempt after the auth server's answer.
    expect(fixture.seen).not.toContain("GET /remote/dcr/mcp");
  }, 30_000);

  it("keeps Streamable HTTP's 403 as the error when the SSE fallback gets 405", async () => {
    const [result] = await manager().connectAllDetailed([
      { name: "forbidden", url: `${fixture.base}/remote/forbidden/mcp`, timeout: 10_000 },
    ]);

    expect(result?.ok).toBe(false);
    expect(result?.error).toContain("403");
    expect(result?.error).not.toContain("405");
    // The fallback was still tried: a legacy SSE server would have answered.
    expect(fixture.seen).toContain("GET /remote/forbidden/mcp");
  }, 30_000);

  it("still connects a legacy SSE-only server through the fallback", async () => {
    const [result] = await manager().connectAllDetailed([
      { name: "legacy", url: `${fixture.base}/remote/sse`, timeout: 10_000 },
    ]);

    expect(result?.error).toBeUndefined();
    expect(result?.ok).toBe(true);
    expect(result?.toolCount).toBe(1);
    expect(fixture.seen).toContain("POST /remote/sse");
    expect(fixture.seen).toContain("GET /remote/sse");
  }, 30_000);
});

describe("localhost MCP connect", () => {
  it("still treats a localhost 401 as a protocol mismatch and connects over SSE", async () => {
    const [result] = await manager().connectAllDetailed([
      { name: "local-legacy", url: `${fixture.base}/local/sse`, timeout: 10_000 },
    ]);

    expect(result?.error).toBeUndefined();
    expect(result?.ok).toBe(true);
    expect(result?.toolCount).toBe(1);
    // Localhost never runs OAuth discovery.
    expect(fixture.seen.some((line) => line.includes("/.well-known/"))).toBe(false);
  }, 30_000);
});

describe("formatConnectError for a refused client registration", () => {
  const refused = (status: number) =>
    new RegistrationRejectedError({ status, body: "{}", submittedMetadata: { redirect_uris: [] } });

  it("points Figma users at the desktop server", () => {
    const text = formatConnectError(refused(403), "https://mcp.figma.com/mcp");
    expect(text).toContain("mcp.figma.com only lets approved apps connect");
    expect(text).toContain("GODIK CODER");
    expect(text).toContain("Dev Mode");
    expect(text).toContain(FIGMA_DESKTOP_MCP_URL);
    expect(FIGMA_DESKTOP_MCP_URL).toBe("http://127.0.0.1:3845/mcp");
  });

  it("names other providers without the Figma suggestion", () => {
    const text = formatConnectError(refused(403), "https://mcp.example.com/mcp");
    expect(text).toContain("mcp.example.com only lets approved apps connect");
    expect(text).not.toContain("Figma");
  });

  it("stays a single line so the MCP list shows all of it", () => {
    expect(formatConnectError(refused(403), "https://mcp.figma.com/mcp")).not.toContain("\n");
  });
});
