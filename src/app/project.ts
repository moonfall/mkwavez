/**
 * Project data: everything needed to restore an AppModel (timeline, recipes, wavetables,
 * voices, sequences, selection, Breed parents, tempo, id counters) as plain JSON. Table
 * sample data is either inline (base64 float32, a self-contained file) or supplied
 * separately (the plugin keeps it in its native state). Undo history is not saved.
 */
import type { SequenceData } from '../core/sequence';
import type { Recipe, TableId } from '../core/table';
import type { VoiceParams } from '../core/voice';
import type { Wavetable } from '../core/wavetable';

export const PROJECT_FORMAT = 'mkwavez-project';
export const PROJECT_VERSION = 1;

export interface ProjectTable {
  readonly id: TableId;
  readonly recipe: Recipe;
  /** Base64 little-endian float32 × TABLE_SIZE, when the project is self-contained. */
  readonly data?: string;
}

export interface ProjectData {
  readonly format: typeof PROJECT_FORMAT;
  readonly version: number;
  /** Timeline order. */
  readonly tables: readonly ProjectTable[];
  readonly wavetables: readonly Wavetable[];
  readonly voices: readonly VoiceParams[];
  readonly sequences: readonly SequenceData[];
  readonly selectedId: TableId | null;
  readonly breedParents: readonly TableId[];
  readonly bpm: number;
  readonly next: { readonly table: number; readonly voice: number; readonly sequence: number };
  /** Small per-project settings (e.g. MIDI routing inside the plugin). */
  readonly settings?: Readonly<Record<string, string>>;
}

/** Parse untrusted JSON; throws with a reason if it isn't a project this version can load. */
export function parseProject(json: string): ProjectData {
  const p = JSON.parse(json) as Partial<ProjectData> | null;
  if (!p || p.format !== PROJECT_FORMAT) throw new Error('not an mkwavez project');
  if (typeof p.version !== 'number' || p.version > PROJECT_VERSION) throw new Error(`unsupported project version ${String(p.version)}`);
  for (const k of ['tables', 'wavetables', 'voices', 'sequences', 'breedParents'] as const) {
    if (!Array.isArray(p[k])) throw new Error(`project: ${k} missing`);
  }
  if (!p.next || typeof p.next.table !== 'number') throw new Error('project: id counters missing');
  return p as ProjectData;
}
