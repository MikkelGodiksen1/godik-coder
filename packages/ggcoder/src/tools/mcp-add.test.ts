import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentTool, ToolContext } from "@kenkaiiii/gg-agent";
import type * as ConfigModule from "../config.js";

// Point the global mcp file at a temp home so tests never touch the real ~/.gg.
vi.mock("../config.js", async () => {
  const actual = await vi.importActual<typeof ConfigModule>("../config.js");
  return {
    ...actual,
    getAppPaths: () => ({
      ...actual.getAppPaths(),
      mcpFile: path.join(process.env.GG_TEST_HOME ?? "", ".gg", "mcp.json"),
    }),
  };
});

import { saveMcpServer } from "../core/mcp/save-server.js";
import { addServer } from "../core/mcp/store.js";
import { createMcpAddTool, type McpAddApproval, type McpAddToolDeps } from "./mcp-add.js";
import { partitionToolsByTier } from "./tool-tiers.js";

let home: string;
let project: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "gg-mcp-add-home-"));
  project = await fs.mkdtemp(path.join(os.tmpdir(), "gg-mcp-add-proj-"));
  process.env.GG_TEST_HOME = home;
});

afterEach(async () => {
  delete process.env.GG_TEST_HOME;
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(project, { recursive: true, force: true });
});

const globalFile = () => path.join(home, ".gg", "mcp.json");
const projectFile = () => path.join(project, ".gg", "mcp.json");

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, "utf-8"));
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

interface Harness {
  tool: ReturnType<typeof createMcpAddTool>;
  trusted: string[];
  asked: McpAddApproval[];
}

function harness(overrides: Partial<McpAddToolDeps> = {}): Harness {
  const trusted: string[] = [];
  const asked: McpAddApproval[] = [];
  const tool = createMcpAddTool({
    cwd: () => project,
    save: (config, scope, cwd) =>
      saveMcpServer(config, scope, cwd, false, {
        probe: async () => ({ ok: false, toolCount: 0, requiresAuth: true }),
        trustProject: async (dir) => {
          trusted.push(dir);
        },
      }),
    approve: async (approval) => {
      asked.push(approval);
      return "declined";
    },
    checkLaunch: async () => null,
    ...overrides,
  });
  return { tool, trusted, asked };
}

const ctx: ToolContext = { signal: new AbortController().signal, toolCallId: "call-1" };

async function run(
  tool: Harness["tool"],
  args: { command: string; scope?: "global" | "project" },
): Promise<string> {
  const result = await tool.execute(args, ctx);
  return typeof result === "string" ? result : JSON.stringify(result);
}

describe("mcp_add", () => {
  it("saves an http server to the global config and says when it loads", async () => {
    const { tool, asked } = harness();
    const out = await run(tool, {
      command: "claude mcp add --transport http figma http://127.0.0.1:3845/mcp",
    });

    expect(await readJson(globalFile())).toEqual({
      mcpServers: { figma: { type: "http", url: "http://127.0.0.1:3845/mcp" } },
    });
    expect(asked).toEqual([]);
    expect(out).toContain('Added MCP server "figma"');
    expect(out).toContain("Settings → MCP → Sign in");
    expect(out).toContain("loads after GODIK CODER restarts");
  });

  it("saves a project-scope server to the project's .gg/mcp.json and trusts the project", async () => {
    const { tool, trusted, asked } = harness();
    await run(tool, {
      command: "claude mcp add --transport http linear https://mcp.linear.app/mcp",
      scope: "project",
    });

    expect(await readJson(projectFile())).toEqual({
      mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp" } },
    });
    expect(await exists(globalFile())).toBe(false);
    expect(trusted).toEqual([project]);
    expect(asked).toEqual([]);
  });

  it("doesn't write a stdio server the user didn't approve", async () => {
    const { tool, asked } = harness();
    const out = await run(tool, { command: "claude mcp add notes -- npx -y some-mcp-server" });

    expect(asked).toHaveLength(1);
    expect(asked[0]?.detail).toContain("npx -y some-mcp-server");
    expect(out).toContain("didn't approve");
    expect(await exists(globalFile())).toBe(false);
  });

  it("doesn't write a stdio server when nobody can approve it", async () => {
    const { tool } = harness({ approve: undefined });
    const out = await run(tool, { command: "claude mcp add notes -- npx -y some-mcp-server" });

    expect(out).toMatch(/^Error: .*needs the user's OK/);
    expect(await exists(globalFile())).toBe(false);
  });

  it("doesn't write a stdio server while the question is unanswered", async () => {
    const { tool } = harness({ approve: async () => "pending" });
    const out = await run(tool, { command: "claude mcp add notes -- npx -y some-mcp-server" });

    expect(out).toContain("hasn't answered");
    expect(await exists(globalFile())).toBe(false);
  });

  it("refuses a stdio package the launch guard blocks, without asking", async () => {
    const { tool, asked } = harness({
      checkLaunch: async () => "Blocked install (malware): evil-pkg is known malware.",
    });
    const out = await run(tool, { command: "claude mcp add evil -- npx -y evil-pkg" });

    expect(out).toContain("Blocked install");
    expect(asked).toEqual([]);
    expect(await exists(globalFile())).toBe(false);
  });

  it("writes a stdio server once the user approves it", async () => {
    const { tool } = harness({ approve: async () => "approved" });
    await run(tool, { command: "claude mcp add notes -- npx -y some-mcp-server" });

    expect(await readJson(globalFile())).toEqual({
      mcpServers: {
        notes: { type: "stdio", command: "npx", args: ["-y", "some-mcp-server"] },
      },
    });
  });

  it("asks before a project add would trust servers already in the repo", async () => {
    const { tool, asked, trusted } = harness({
      untrustedProjectServers: async () => ["repo-shell"],
    });
    const out = await run(tool, {
      command: "claude mcp add --transport http linear https://mcp.linear.app/mcp",
      scope: "project",
    });

    expect(asked[0]?.detail).toContain("repo-shell");
    expect(out).toContain("didn't approve");
    expect(await exists(projectFile())).toBe(false);
    expect(trusted).toEqual([]);
  });

  it("gives a clear error for a line it can't read, and writes nothing", async () => {
    const { tool } = harness();
    const out = await run(tool, { command: "claude mcp add --transport http figma" });

    expect(out).toBe(
      "Error: couldn't read that MCP command: The http transport requires a URL after the name. " +
        "Pass one `claude mcp add` line, e.g. " +
        "`claude mcp add --transport http figma http://127.0.0.1:3845/mcp`.",
    );
    expect(await exists(globalFile())).toBe(false);
  });

  it("never overwrites a server the user already has", async () => {
    await addServer({ name: "figma", url: "https://mcp.figma.com/mcp" }, "global", project);
    const { tool } = harness();
    const out = await run(tool, {
      command: "claude mcp add --transport http figma http://127.0.0.1:3845/mcp",
    });

    expect(out).toContain('A "figma" server already exists');
    expect(await readJson(globalFile())).toEqual({
      mcpServers: { figma: { type: "http", url: "https://mcp.figma.com/mcp" } },
    });
  });
});

describe("mcp_add in the tool tiers", () => {
  const stub = (name: string): AgentTool =>
    ({
      name,
      description: `${name} description`,
      parameters: z.object({ value: z.string() }),
      execute: async () => "",
    }) as unknown as AgentTool;

  const serialize = (tools: AgentTool[]) =>
    tools
      .map((t) =>
        JSON.stringify({
          name: t.name,
          description: t.description,
          input_schema: z.toJSONSchema(t.parameters as z.ZodType),
        }),
      )
      .join("\n");

  it("is deferred and leaves the core tool block byte-identical", () => {
    const base = ["read", "write", "edit", "bash", "grep", "ask_user"].map(stub);
    const withAdd = [...base, harness().tool as unknown as AgentTool];

    const before = partitionToolsByTier(base);
    const after = partitionToolsByTier(withAdd);
    expect(after.deferred.map((t) => t.name)).toEqual(["mcp_add"]);
    expect(serialize(after.core)).toBe(serialize(before.core));
  });
});
