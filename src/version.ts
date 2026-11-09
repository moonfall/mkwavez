/**
 * Which build this is (shown in the Session menu and on the title; logged at startup): set at
 * build time from git by vite.config.ts (scripts/version.mjs). Inside the plugin it names the
 * plugin build too, since the plugin embeds the page built with it.
 */
export interface BuildInfo {
  readonly version: string;
  /** The tag on the built commit ('' if none). */
  readonly tag: string;
  readonly commit: string;
  /** The commit's date, YYYY-MM-DD. */
  readonly date: string;
  /** Tracked files had local edits. */
  readonly dirty: boolean;
}

declare const __MKWAVEZ_BUILD__: BuildInfo | undefined;

export const BUILD: BuildInfo =
  typeof __MKWAVEZ_BUILD__ !== 'undefined' && __MKWAVEZ_BUILD__ ? __MKWAVEZ_BUILD__ : { version: '', tag: '', commit: '', date: '', dirty: false };

/** "v1.2.0" on a tagged build, else "v0.1.0 · 3f2a1bc4 · 2026-11-09" (· dirty with local edits). */
export function versionLabel(b: BuildInfo = BUILD): string {
  const parts = b.tag ? [b.tag] : [b.version ? `v${b.version}` : 'dev', b.commit, b.date];
  if (b.dirty) parts.push('dirty');
  return parts.filter(Boolean).join(' · ');
}
