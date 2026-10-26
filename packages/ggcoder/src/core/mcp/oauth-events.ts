import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import path from "node:path";
import { log } from "../logger.js";

/**
 * "Remote-MCP OAuth tokens changed" notifications, so a session that cached a
 * "Requires login." result reconnects as soon as credentials appear instead of
 * staying dead until restart.
 *
 * Two sources:
 * - in-process: `McpOAuthStore.patch` emits whenever a patch carries tokens
 *   (login in the sidecar, a silent refresh in another session of the daemon);
 * - cross-process: a debounced `fs.watch` on the auth file (a CLI login, another
 *   daemon) emits with no server name, meaning "re-check every pending server".
 *
 * Listeners get `undefined` for a file-level change. Never carries token values.
 */
const emitter = new EventEmitter();
emitter.setMaxListeners(0);
const EVENT = "tokens";

export type McpTokensListener = (serverName: string | undefined) => void;

export function emitMcpTokensChanged(serverName: string | undefined): void {
  emitter.emit(EVENT, serverName);
}

interface FileWatch {
  watcher: fsSync.FSWatcher | undefined;
  listeners: Set<McpTokensListener>;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const fileWatches = new Map<string, FileWatch>();

/** Debounce for bursty editor/atomic-rename writes of the auth file. */
export const MCP_AUTH_WATCH_DEBOUNCE_MS = 250;

function startFileWatch(filePath: string): FileWatch {
  const entry: FileWatch = { watcher: undefined, listeners: new Set(), timer: undefined };
  const base = path.basename(filePath);
  try {
    // Watch the directory, not the file: writers may replace the file, which a
    // file-level watch on macOS silently stops following.
    entry.watcher = fsSync.watch(path.dirname(filePath), (_event, name) => {
      if (name && name.toString() !== base) return;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        entry.timer = undefined;
        for (const fn of [...entry.listeners]) fn(undefined);
      }, MCP_AUTH_WATCH_DEBOUNCE_MS);
      entry.timer.unref?.();
    });
    entry.watcher.unref?.();
    entry.watcher.on("error", () => {
      // The directory vanished or the platform dropped the watch; in-process
      // events still work, so degrade quietly.
      entry.watcher?.close();
      entry.watcher = undefined;
    });
  } catch (err) {
    log("WARN", "mcp", "could not watch the MCP OAuth store for logins", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
  return entry;
}

/**
 * Subscribe to token changes: in-process store writes for any server, plus
 * cross-process changes of `filePath`. Returns the unsubscribe function.
 */
export function onMcpTokensChanged(filePath: string, fn: McpTokensListener): () => void {
  emitter.on(EVENT, fn);
  let watch = fileWatches.get(filePath);
  if (!watch) {
    watch = startFileWatch(filePath);
    fileWatches.set(filePath, watch);
  }
  watch.listeners.add(fn);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    emitter.off(EVENT, fn);
    const w = fileWatches.get(filePath);
    if (!w) return;
    w.listeners.delete(fn);
    if (w.listeners.size === 0) {
      if (w.timer) clearTimeout(w.timer);
      w.watcher?.close();
      fileWatches.delete(filePath);
    }
  };
}
