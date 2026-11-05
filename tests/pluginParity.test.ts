/**
 * The native plugin decodes the page's voices by name (plugin/source/SynthJson.cpp) into
 * C++ enums (plugin/core). The golden renders drive the engine by index, so a name missing
 * on the native side would pass them and silently do nothing in the plugin (as MPE Slide's
 * matrix source once did). This reads the C++ sources and checks them against src/core,
 * so it runs with the web tests on every push (the plugin build itself is on demand).
 */
import synthJson from '../plugin/source/SynthJson.cpp?raw';
import synthH from '../plugin/core/include/mkwavez/synth.h?raw';
import modulationH from '../plugin/core/include/mkwavez/modulation.h?raw';
import voiceH from '../plugin/core/include/mkwavez/voice.h?raw';
import webLink from '../plugin/source/WebLink.cpp?raw';
import parametersCpp from '../plugin/source/Parameters.cpp?raw';
import hostTs from '../src/plugin/host.ts?raw';
import { describe, expect, it } from 'vitest';
import { CC_PARAMS } from '../src/core/midi';
import { DEFAULT_LFO, LFO_DIVS, LFO_SHAPES, MOD_DESTS, MOD_SOURCES } from '../src/core/modulation';
import { DEFAULT_SYNTH, FILTER_MODES, NOISE_TYPES, NOTE_PRIORITIES, PHASE_MODES, PITCH_TARGETS, SUB_WAVES, VOICE_TYPES, WARP_MODES } from '../src/core/synth';

const headers = [synthH, modulationH, voiceH].join('\n');

/** The quoted strings of the first `{...}` list after `decl` in `src` (a C++ string table or a TS Set). */
function listAfter(src: string, decl: string): string[] {
  const at = src.indexOf(decl);
  if (at < 0) throw new Error(`no ${decl}`);
  const body = /[{[]([^}\]]*)[}\]]/.exec(src.slice(at + decl.length));
  const items = [...(body?.[1] ?? '').matchAll(/["']([^"']*)["']/g)].map((x) => x[1]);
  if (!items.length) throw new Error(`empty list after ${decl}`);
  return items;
}
/** A `const char* const NAME[] = {...}` table in SynthJson.cpp. */
const table = (name: string) => listAfter(synthJson, `const char* const ${name}[] =`);

/** Enumerators of a C++ enum (without NONE / sentinel values). */
function enumerators(name: string): string[] {
  const m = new RegExp(`enum (?:class )?${name}\\s*:\\s*\\w+\\s*\\{([^}]*)\\}`).exec(headers);
  if (!m) throw new Error(`no enum ${name}`);
  return m[1]
    .split(',')
    .map((s) => s.replace(/=.*$/, '').trim())
    .filter((s) => s && !/NONE$/.test(s));
}
/** SRC_MACRO1 / DST_POSY_A / lfo1Rate → a comparable key. */
const norm = (s: string) => s.replace(/^(SRC|DST)_/, '').replace(/_/g, '').toLowerCase();

describe('plugin parity (C++ names and enums vs src/core)', () => {
  const tables: [string, readonly string[]][] = [
    ['FILTER_MODES', FILTER_MODES],
    ['SUB_WAVES', SUB_WAVES],
    ['NOISE_TYPES', NOISE_TYPES],
    ['PITCH_TARGETS', PITCH_TARGETS],
    ['MOD_MODES', ['ad', 'adsr']],
    ['PHASE_MODES', PHASE_MODES],
    ['NOTE_PRIORITIES', NOTE_PRIORITIES],
    ['WARP_MODES', WARP_MODES],
    ['LFO_SHAPES', LFO_SHAPES],
    ['LFO_DIVS', LFO_DIVS],
    ['MOD_SOURCES', MOD_SOURCES],
    ['MOD_DESTS', MOD_DESTS],
  ];
  it.each(tables)('SynthJson %s names every value, in order', (name, ts) => {
    expect(table(name)).toEqual([...ts]);
  });

  const enums: [string, readonly string[]][] = [
    ['VoiceType', VOICE_TYPES],
    ['FilterMode', FILTER_MODES],
    ['SubWave', SUB_WAVES],
    ['NoiseType', NOISE_TYPES],
    ['PitchTarget', PITCH_TARGETS],
    ['WarpMode', WARP_MODES],
    ['PhaseMode', PHASE_MODES],
    ['NotePriority', NOTE_PRIORITIES],
    ['LfoShape', LFO_SHAPES],
    ['ModEnvMode', ['ad', 'adsr']],
    ['ModSource', MOD_SOURCES],
    ['ModDest', MOD_DESTS],
    ['CcParam', CC_PARAMS],
  ];
  it.each(enums)('C++ enum %s matches, in order (indices are shared)', (name, ts) => {
    expect(enumerators(name).map(norm)).toEqual(ts.map(norm));
  });

  it("WebLink decodes the page's CC map in CC_PARAMS order", () => {
    expect(listAfter(webLink, 'const char* keys[CC_PARAM_COUNT] =')).toEqual([...CC_PARAMS]);
  });

  it('host parameters: the page and the plugin agree on the automatable voice and Synth fields', () => {
    expect(listAfter(parametersCpp, 'const char* const fieldIds[VOICE_FIELD_COUNT] =')).toEqual(listAfter(hostTs, 'const AUTOMATED = new Set<string>('));
    expect(listAfter(parametersCpp, 'const char* const synthIds[SYNTH_FIELD_COUNT] =')).toEqual(listAfter(hostTs, 'const SYNTH_AUTOMATED = new Set<string>('));
    for (const k of listAfter(parametersCpp, 'const char* const synthIds[SYNTH_FIELD_COUNT] =')) expect(Object.keys(DEFAULT_SYNTH)).toContain(k);
  });

  it('SynthJson reads and writes every Synth and LFO field', () => {
    const missing = [...Object.keys(DEFAULT_SYNTH), ...Object.keys(DEFAULT_SYNTH.b), ...Object.keys(DEFAULT_LFO)].filter((k) => !synthJson.includes(`"${k}"`));
    expect(missing).toEqual([]);
  });
});
