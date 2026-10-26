import { log } from "../logger.js";
import type { McpOAuthStore } from "./oauth-store.js";
import { emitMcpTokensChanged } from "./oauth-events.js";

/** The transport's `fetch` shape (the MCP SDK's FetchLike). */
export type McpFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * How long a successful refresh keeps the per-server lock while waiting for the
 * SDK to persist the new tokens (it saves right after the response returns).
 */
export const REFRESH_SAVE_WAIT_MS = 5_000;

const locks = new Map<string, Promise<void>>();
const savedWaiters = new Map<string, Set<() => void>>();

/** Called by the store after it persisted tokens for `serverName`. */
export function noteMcpTokensSaved(serverName: string): void {
  const waiters = savedWaiters.get(serverName);
  if (!waiters) return;
  savedWaiters.delete(serverName);
  for (const w of waiters) w();
}

function waitForSave(serverName: string, ms: number): Promise<void> {
  return new Promise((resolve) => {
    let set = savedWaiters.get(serverName);
    if (!set) {
      set = new Set();
      savedWaiters.set(serverName, set);
    }
    const done = () => {
      clearTimeout(timer);
      set?.delete(done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    set.add(done);
  });
}

async function withLock<T>(key: string, fn: (release: () => void) => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = prev.then(() => mine);
  locks.set(key, chained);
  await prev;
  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    release();
    if (locks.get(key) === chained) locks.delete(key);
  };
  try {
    return await fn(releaseOnce);
  } catch (err) {
    releaseOnce();
    throw err;
  }
}

function refreshTokenOf(init: RequestInit | undefined): string | undefined {
  const body = init?.body;
  if (body instanceof URLSearchParams) {
    return body.get("grant_type") === "refresh_token"
      ? (body.get("refresh_token") ?? undefined)
      : undefined;
  }
  if (typeof body === "string" && body.includes("grant_type=refresh_token")) {
    const params = new URLSearchParams(body);
    return params.get("refresh_token") ?? undefined;
  }
  return undefined;
}

/** OAuth error code + a short, control-character-free description. Never token values. */
async function describeFailure(res: Response): Promise<Record<string, string>> {
  const out: Record<string, string> = { status: String(res.status) };
  try {
    const body = (await res.clone().json()) as { error?: unknown; error_description?: unknown };
    if (typeof body.error === "string") out.error = body.error.slice(0, 64);
    if (typeof body.error_description === "string") {
      // Control characters are the point: strip them so a server's error text
      // can't break or forge log lines.
      // eslint-disable-next-line no-control-regex
      out.description = body.error_description.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 160);
    }
  } catch {
    // Not JSON — the status alone has to do.
  }
  return out;
}

/**
 * Wrap a transport `fetch` so token REFRESHES for one server are serialized
 * across every session of this process and logged.
 *
 * Why: authorization servers such as Atlassian (Trello) rotate refresh tokens.
 * Each session builds its own OAuth provider, so after an access token expired
 * several sessions reconnecting at once (wake from sleep) all POSTed the SAME
 * refresh token; the first rotated it, the rest got `invalid_grant`, and the
 * last writer could leave a dead pair on disk — "Requires login." from then on.
 *
 * Under the lock the store is re-read: if another session already rotated the
 * token, its fresh pair is answered locally instead of replaying the dead one.
 * Every other request passes straight through.
 */
export function guardRefreshFetch(
  serverName: string,
  store: McpOAuthStore,
  base: McpFetch = fetch,
): McpFetch {
  return async (url, init) => {
    const sent = refreshTokenOf(init);
    if (sent === undefined) return base(url, init);
    return withLock(`refresh:${serverName}`, async (release) => {
      const stored = (await store.get(serverName)).tokens;
      if (stored?.access_token && stored.refresh_token && stored.refresh_token !== sent) {
        release();
        log(
          "INFO",
          "mcp",
          `MCP OAuth refresh for "${serverName}" skipped: already refreshed by another session`,
        );
        const { issuer: _issuer, ...wire } = stored as typeof stored & { issuer?: string };
        return new Response(JSON.stringify(wire), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      log("INFO", "mcp", `MCP OAuth refresh attempt for "${serverName}"`);
      let res: Response;
      try {
        res = await base(url, init);
      } catch (err) {
        release();
        log("WARN", "mcp", `MCP OAuth refresh failed for "${serverName}"`, {
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      if (!res.ok) {
        release();
        log(
          "WARN",
          "mcp",
          `MCP OAuth refresh failed for "${serverName}"`,
          await describeFailure(res),
        );
        return res;
      }
      let expiresIn: string | undefined;
      let rotated: string | undefined;
      try {
        const body = (await res.clone().json()) as {
          expires_in?: unknown;
          refresh_token?: unknown;
        };
        if (typeof body.expires_in === "number") expiresIn = String(body.expires_in);
        rotated =
          typeof body.refresh_token === "string" ? String(body.refresh_token !== sent) : "false";
      } catch {
        // Leave the details out; the SDK reports a malformed body itself.
      }
      log("INFO", "mcp", `MCP OAuth refresh ok for "${serverName}"`, {
        ...(expiresIn ? { expiresIn } : {}),
        ...(rotated ? { rotated } : {}),
      });
      // Hold the lock until the SDK has saved the new pair, so the next waiter
      // re-reads the rotated token instead of replaying the one just spent.
      void waitForSave(serverName, REFRESH_SAVE_WAIT_MS).then(() => {
        release();
        emitMcpTokensChanged(serverName);
      });
      return res;
    });
  };
}
