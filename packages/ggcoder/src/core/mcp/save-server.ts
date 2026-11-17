import { addServer, type MCPScope } from "./store.js";
import type { MCPServerConfig } from "./types.js";

/** What a connection probe reports; never throws (see `probeMcp`). */
export interface McpProbeOutcome {
  ok: boolean;
  toolCount: number;
  error?: string;
  requiresAuth?: boolean;
}

export interface SaveMcpServerDeps {
  probe: (config: MCPServerConfig) => Promise<McpProbeOutcome>;
  /** Called after a project-scope save: the add is the user's trust signal. */
  trustProject: (cwd: string) => Promise<void>;
  onAdded?: () => void;
}

export type SaveMcpServerResult =
  | {
      ok: true;
      name: string;
      connected: boolean;
      toolCount: number;
      error?: string;
      requiresAuth?: boolean;
    }
  | { ok: false; error: string };

/**
 * Probe a parsed server, persist it to `scope`, and trust the project for a
 * project-scope add. The one save path behind the MCP modal's `/mcp/add` and
 * the agent's `mcp_add` tool. A failed probe never blocks the save (mirrors
 * the CLI); a write failure throws for the caller to report.
 */
export async function saveMcpServer(
  config: MCPServerConfig,
  scope: MCPScope,
  cwd: string,
  overwrite: boolean,
  deps: SaveMcpServerDeps,
): Promise<SaveMcpServerResult> {
  const probe = await deps.probe(config);
  const saved = await addServer(config, scope, cwd, overwrite);
  if (!saved.ok) return { ok: false, error: saved.error };
  if (scope === "project") await deps.trustProject(cwd);
  deps.onAdded?.();
  return {
    ok: true,
    name: config.name,
    connected: probe.ok,
    toolCount: probe.toolCount,
    error: probe.error,
    requiresAuth: probe.requiresAuth,
  };
}
