// GODIK CODER: upstream's release notes, rebranded at display time so
// changelog.ts stays byte-identical to upstream (no merge conflicts).
import {
  CHANGELOG as UPSTREAM_CHANGELOG,
  recentChangelog as upstreamRecentChangelog,
  type ChangelogEntry,
} from "./changelog";
import { brandText } from "./brand";

function brandEntry(entry: ChangelogEntry): ChangelogEntry {
  return { ...entry, items: entry.items.map(brandText) };
}

export type { ChangelogEntry };

export const CHANGELOG: ChangelogEntry[] = UPSTREAM_CHANGELOG.map(brandEntry);

export function recentChangelog(maxItems?: number): ChangelogEntry[] {
  return upstreamRecentChangelog(maxItems).map(brandEntry);
}
