# GODIK CODER: what differs from upstream, and how to merge upstream safely

GODIK CODER is a whitelabel fork of Ken Kai's GG Coder
(`upstream` = https://github.com/KenKaiii/gg-framework, `origin` =
https://github.com/MikkelGodiksen1/godik-coder). It is upstream plus a small,
fixed set of changes. Read this before merging an upstream tag or touching any
file listed below.

To list every fork change against the upstream tag main is on:

```bash
git describe --tags --match 'v[0-9]*' --abbrev=0 HEAD   # e.g. v0.97.5
git diff --stat v0.97.5 HEAD                            # the whole fork delta
git log --no-merges --oneline v0.97.5..HEAD             # fork commits, oldest last
```

## Golden rules

1. **Upstream wins, then re-apply ours.** Take Ken's code for everything he
   changed and put the fork's additions back on top. Never drop an upstream fix
   to keep a fork line.
2. **Never rename internal identifiers.** File names (`ken-*.ts`, `KenFace.tsx`),
   types, functions, `ken*`/`gg*` ids, routes, SSE event names (`ken_*`), CSS
   classes (`.ken-*`), settings keys and on-disk paths (`~/.gg`, `.gg/`,
   the `GG Motion` folder) keep upstream's names. Only display text is rebranded.
3. **Display names come from `brand.ts`**, never a hard-coded "Ken", "GG" or
   "GG Coder". See _Whitelabel_ below.
4. **`gg-app/src-tauri/tauri.conf.json` stays byte-identical to upstream**
   (version included). GODIK's identity lives in `tauri.macos.conf.json`.
5. **`gg-app/src/changelog.ts` and `packages/ggcoder/src/core/trophies/catalog*.ts`
   stay byte-identical to upstream.** They are rebranded at display time.
6. Never weaken or skip tests, never `--no-verify`, never force-push main.
7. Never run upstream's `/release` flow (npm publish, `v*` tags, `pnpm --filter gg-app bump`):
   that is Ken's release. This fork releases only through `godik-v*` tags.

## Whitelabel

| Upstream                                   | GODIK CODER                               | Constant                                   |
| ------------------------------------------ | ----------------------------------------- | ------------------------------------------ |
| Ken / Ken Kai (the mentor)                 | Godik                                     | `MENTOR_NAME`                              |
| `@Ken`                                     | `@Mentor` (`@ken` still works when typed) | `MENTOR_HANDLE`                            |
| GG / GG Coder (the coding agent)           | GC                                        | `CODER_NAME`                               |
| GG Goals / GG Chat / GG Motion             | GC Goals / GC Chat / GC Motion            | `GOALS_NAME` / `CHAT_NAME` / `MOTION_NAME` |
| "By Ken Kai" (CLI banners, agent identity) | By Godik                                  | `MAKER_NAME`                               |
| GG Coder (app, OAuth client, window title) | GODIK CODER                               | `APP_NAME`                                 |

**Two copies of the brand module, kept identical:**
`packages/ggcoder/src/core/brand.ts` (sidecar, prompts, CLI) and
`gg-app/src/brand.ts` (UI; gg-app can't import ggcoder).
`gg-app/src/brand.test.ts` fails if their code differs.

**Three ways a string gets branded:**

1. **Constants in our own strings.** UI labels, tooltips, toasts, the mentor's
   prompts (`ken-prompt.ts`, `ken-context.ts`, `max-gas.ts`, autopilot
   rule prompts), agent identities (`system-prompt.ts`, goals, chat, motion)
   and sidecar messages use the constants above.
2. **`brandText()` at display time** for upstream copy we don't edit:
   - release notes: `gg-app/src/changelog-brand.ts` wraps `changelog.ts`
     (What's New, About). Import `CHANGELOG`/`recentChangelog` from
     `./changelog-brand`, never from `./changelog`.
   - trophies: `buildTrophySnapshot` in `core/trophies/engine.ts`.
   - every error notice: `readChatError` in `gg-app/src/chat-error.ts` (covers
     gg-ai `formatError`, gg-agent hints and sidecar errors).
   - What's New highlight terms: `HIGHLIGHT_TERMS.map(brandText)`.

   `brandText` only rewrites whole words, so `Kencode`, `KenKaiii`, `GG_*` env
   vars, `GG-WORLD-PRIVACY.md`, `.gg/` paths and pixel-art rows are untouched.

3. **Guard:** the "whitelabel guard" test in `gg-app/src/brand.test.ts` scans
   `gg-app/src` for any hard-coded Ken / GG / GG Coder outside comments. When a
   merge brings a new upstream label, CI goes red and names the file:line. Fix it
   with a constant or `brandText`, not by adding it to the allowlist (that list
   is for things that must keep the upstream name, like the `GG Motion` folder).
   The guard covers the app only: sidecar strings need a manual grep (below).

**Persisted text keeps working.** The autopilot preamble and the
"`<mentor>` autopilot (injected)" label are written into session files and
matched on read. `autopilot-cycle.ts` keeps upstream's wording in
`AUTOPILOT_INJECTION_PREAMBLES` and `autopilotPreambleOf()` accepts both;
`session-preview.ts` lists both prefixes. Never remove the upstream entry: old
sessions would show the raw preamble as a user bubble.

**Look:** Godik's pixel face (`ken-face.ts`, 18x18 frames) and portrait
(`goal-ken-portrait.ts`) have blond hair with a fringe, the home title is
`assets/home/godik-coder-title.png` (`scripts/gen-godik-title.py`), and the
About page introduces Godik with no Skool/YouTube links. LICENSE and its
copyright line are untouched (MIT requires them).

**Deliberately still upstream-named:** the `GG Motion` folder on disk (renaming
it would orphan existing videos), internal benchmarks, the Windows/Linux
keep-awake ids, gg-core's CLI npm auto-update messages, model-facing strings
inside the Motion skills, and the CLI's ASCII "GG" logo. The CLI isn't shipped
by this fork.

## Fork features (beyond the rebrand)

| Feature                                                                                                                                             | Main files                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mentor key** in the deck: toggles `@Mentor` in front of the draft; on an empty composer fills "hvad siger du?" selected                           | `gg-app/src/mentor.ts`, `Deck.tsx`, `App.tsx`, `Composer.tsx`                                                                               |
| **Mentor takes images** (pasted/dropped/picked screenshots go to the mentor)                                                                        | `prompt-routes.ts`, `agent-session.ts`, `transcript-markers.ts`, `session-manager.ts`, `commands/agent.rs`, `agent.ts`                      |
| **Max Gas** deck key: the task goes to the mentor wrapped in a production-run brief; he answers with one runnable prompt                            | `gg-app/src/max-gas.ts`, `Deck.tsx`, `App.tsx`                                                                                              |
| **Autopilot deck key** + **user rules** in `.gg/autopilot-rules.md` ("if X, send Y"), fired rule named in the transcript                            | `core/autopilot-rules.ts`, `autopilot-verdict.ts`, `autopilot-cycle.ts`, `ken-context.ts`, `useAutopilot.ts`, `TranscriptRow.tsx`           |
| **Rule suggestions**: after a HUMAN stop, the user's reply can become a rule (card with Save/Dismiss)                                               | `core/autopilot-rule-suggestions.ts`, `RuleSuggestionCard.tsx`, `autopilot-runner.ts`, `route-context.ts`, Rust `agent_autopilot_rule_save` |
| **Mentor digest extras**: the user's other active goals, and `ask_user` questions GC asked                                                          | `core/goal-board.ts`, `core/ken-context.ts`, `app-sidecar/ken-context.ts`                                                                   |
| **Sent state for mentor prompts** (live, after reload, from other clients, when queued) and `prompt_accepted`                                       | `Markdown.tsx`, `markdown-prompt.ts`, `local-prompt-ids.ts`, `useAgentEvents.ts`, `prompt-routes.ts`, `autopilot-runner.ts`                 |
| **Multi-client ask_user**: answered or overtaken from another client (e.g. glasses via `POST /ask/:id`) reads as answered in every window           | `core/ask-user.ts`, `app-sidecar.ts`, `gg-app/src/ask-user.ts`, `useAgentEvents.ts`                                                         |
| **MCP OAuth refresh**, and live sessions reconnect after login                                                                                      | `core/mcp/oauth-refresh.ts`, `oauth-events.ts`, `oauth-store.ts`, `client.ts`, `mcp-routes.ts`, `mcp-tools.ts`                              |
| **Patch: mentor turns replay after the reply they followed** when a tool call was interrupted (`mapCustomEntriesInFileOrder`, `repairedCountAfter`) | `core/session-manager.ts`; guarded by `core/ken-turn-anchor.test.ts`                                                                        |
| **Patch: stop the daemon's process tree synchronously on macOS Quit**                                                                               | `gg-app/src-tauri/src/process.rs`, `lib.rs`                                                                                                 |

## Identity, updates and releases

- `.github/workflows/ci.yml`: the `test` job's `timeout-minutes` is 30, not
  upstream's 15 (the limit includes waiting for a macOS runner). Keep it on merges.

- `gg-app/src-tauri/tauri.macos.conf.json`: product name `GODIK CODER`,
  bundle id `dk.godik.coder`, the fork's updater public key and endpoint
  (`releases/latest/download/latest.json` on origin). `gg-app/index.html`
  title is `GODIK CODER`.
- `.github/workflows/godik-sync.yml` (every 6 h): picks Ken's newest app tag
  `v<x.y.z>` not yet shipped as `godik-v<x.y.z>`, merges it into main, runs
  `ken-turn-anchor.test.ts`, pushes main, tags `godik-v<x.y.z>`, creates the
  release and starts `godik-release.yml` (macOS Apple Silicon, ad-hoc signed,
  uploads `.app.tar.gz` + `.sig` + `latest.json`). On a merge conflict it stops
  without pushing.
- Ken's `release.yml` only fires on `v*` tags; this fork only creates
  `godik-v*`, so it never runs here.
- Local: `./sync-upstream` merges `upstream/main`; `./godik-update` syncs,
  builds and installs the app into `~/Applications` (refuses while it's open).

## Merging an upstream tag (step by step)

1. Clean tree on main: `git status`, `git fetch upstream --tags`.
2. Merge in a throwaway worktree whose path has no spaces and is not under
   `/tmp` (see step 5): `git worktree add -b sync/v<x.y.z> ~/godik-sync main &&
cd ~/godik-sync && git merge v<x.y.z>`.
3. Resolve conflicts with the rules above. Usual hot spots:
   - `gg-app/src/App.tsx`, `Deck.tsx`, `TranscriptRow.tsx`: keep Ken's
     structure; re-add the Mentor/Max Gas/Autopilot keys, rule-suggestion
     wiring, `@Mentor` routing and brand constants.
   - `ken-prompt.ts` / `ken-context.ts`: take Ken's new wording, then put back
     `${MENTOR_NAME}`/`${CODER_NAME}`, the rules section and the digest extras.
     Keep the mentor's voice and rules as Ken wrote them.
   - `session-manager.ts`: if `ken-turn-anchor.test.ts` fails after the merge,
     Ken may have fixed the drift upstream; then drop our patch instead.
   - `tauri.conf.json`: take Ken's file whole.
   - `changelog.ts`, trophy catalogs: take Ken's files whole (no branding there).
4. Rebrand new upstream text:
   - `pnpm --filter gg-app exec vitest run src/brand.test.ts` lists new UI labels.
   - For the sidecar, prompts and errors, grep what the merge added:
     `git diff ORIG_HEAD -- packages | grep -E '^\+.*\b(Ken|GG|GG Coder)\b'`.
     Brand user- or model-visible text; leave ids, paths and comments.
5. Build the framework (gg-ai → gg-agent + gg-core → ggcoder), then run each
   check: `pnpm check`, `pnpm lint`, `pnpm format:check`,
   `pnpm --filter gg-app test`, `pnpm --filter @kenkaiiii/ggcoder test`.
   Known local-only ggcoder failures on macOS, all passing in CI:
   `motion-blur` (a colour off by one level), `lsp/windows.test.ts` when the
   repo path contains a space, and `sandbox.test.ts` ("refuses a tool cache
   repointed at the SSH keys") when the checkout lives under `/tmp`. Anything
   else is real.
6. Fast-forward main to the merge, push, and let CI (`ci.yml`) go green. Tag
   `godik-v<x.y.z>` only if godik-sync isn't going to do it.
