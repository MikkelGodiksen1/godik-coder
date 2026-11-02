import { useEffect } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { error as logError } from "@tauri-apps/plugin-log";
import { windowLabel, openWhatsNewWindow } from "./agent";

/**
 * "What's new" TRIGGER (renders nothing). Mounted in every window via main.tsx,
 * but it gates hard on the `main` window so the modal opens EXACTLY ONCE no
 * matter how many project windows are tiled open. When it fires, it opens a
 * dedicated, screen-centered Tauri window (see Rust `open_whatsnew_window` +
 * `WhatsNewWindow.tsx`) — the notes appear in the center of the user's SCREEN,
 * not inside whichever app window happens to be focused.
 *
 * Decision: we stash the last-seen app version in localStorage and compare it to
 * the running version (`getVersion`):
 *   - no record yet (fresh install) → remember silently, DON'T open.
 *   - same version → nothing new, stay quiet.
 *   - version changed (the updater downloaded + relaunched) → open once, in
 *     the `hype` mood (the home screen's button opens the calm one).
 * The seen-version is written the moment we decide, so a relaunch only ever
 * shows the notes a single time.
 */
const STORAGE_KEY = "gg-app:whatsNewVersion";

/**
 * DEV ONLY — force the window open on launch so the layout/scroll can be
 * eyeballed without a real version bump. Leave `false`; ignored in production.
 */
const DEV_FORCE_WHATSNEW = false;

export function WhatsNewModal(): null {
  useEffect(() => {
    // Only the main window decides — secondary/tiled windows never trigger it.
    if (windowLabel !== "main") return;

    if (import.meta.env.DEV && DEV_FORCE_WHATSNEW) {
      void openWhatsNewWindow("hype").catch(() => {});
      return;
    }

    let cancelled = false;
    void getVersion()
      .then(async (version) => {
        if (cancelled) return;
        const seen = localStorage.getItem(STORAGE_KEY);
        if (seen === version) return;
        // Only upgrades need the history. Ordinary launches and fresh installs
        // must not load it into every workspace just to check its length.
        if (seen !== null) {
          const { CHANGELOG } = await import("./changelog-brand");
          if (cancelled || CHANGELOG.length === 0) return;
        }
        // Persist before opening so a re-check never re-opens it.
        localStorage.setItem(STORAGE_KEY, version);
        if (seen !== null) void openWhatsNewWindow("hype").catch(() => {});
      })
      .catch((e) => logError(`What's-new version check failed: ${String(e)}`));
    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
