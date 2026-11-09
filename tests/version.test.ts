import { describe, expect, it } from 'vitest';
import { BUILD, versionLabel } from '../src/version';

describe('build version', () => {
  it('a tag when the commit has one, else version · commit · date; dirty builds say so', () => {
    expect(versionLabel({ version: '0.1.0', tag: 'v1.2.0', commit: 'abcdef12', date: '2026-11-09', dirty: false })).toBe('v1.2.0');
    expect(versionLabel({ version: '0.1.0', tag: '', commit: 'abcdef12', date: '2026-11-09', dirty: false })).toBe('v0.1.0 · abcdef12 · 2026-11-09');
    expect(versionLabel({ version: '0.1.0', tag: '', commit: 'abcdef12', date: '2026-11-09', dirty: true })).toBe('v0.1.0 · abcdef12 · 2026-11-09 · dirty');
    expect(versionLabel({ version: '', tag: '', commit: '', date: '', dirty: false })).toBe('dev');
  });

  it('is filled in from git at build time (vite.config.ts)', () => {
    expect(BUILD.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(BUILD.commit).toMatch(/^[0-9a-f]{7,}$/);
    expect(BUILD.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
