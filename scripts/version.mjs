// The build's identity, baked into the bundle by vite.config.ts (define __MKWAVEZ_BUILD__):
// the package version, the tag when HEAD is tagged, else the short commit and its date, and
// whether tracked files had local edits. Read from git at build time (empty when unavailable).
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function git(args) {
  try {
    return execSync(`git ${args}`, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

export function buildVersion() {
  const pkg = JSON.parse(readFileSync(`${root}/package.json`, 'utf8'));
  const commit = git('rev-parse --short=8 HEAD');
  return {
    version: String(pkg.version ?? ''),
    tag: git('describe --tags --exact-match HEAD'),
    commit,
    date: git('log -1 --format=%cs HEAD'),
    dirty: commit !== '' && git('status --porcelain --untracked-files=no') !== '',
  };
}
