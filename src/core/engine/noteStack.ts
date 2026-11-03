/**
 * Held-note stack for one monophonic voice (last-note priority). Fixed capacity, no
 * allocation: a key pressed while the stack is full drops the oldest held key. Notes are
 * refcounted: the same note held from two channels / inputs (Omni) stays held until
 * both release it.
 */
export class NoteStack {
  static readonly CAPACITY = 16;
  private readonly notes = new Int16Array(NoteStack.CAPACITY);
  private readonly vels = new Uint8Array(NoteStack.CAPACITY);
  private readonly counts = new Uint8Array(NoteStack.CAPACITY);
  size = 0;

  /** Most recent held note, or -1. */
  get top(): number {
    return this.size ? this.notes[this.size - 1] : -1;
  }

  get topVelocity(): number {
    return this.size ? this.vels[this.size - 1] : 0;
  }

  has(note: number): boolean {
    return this.indexOf(note) >= 0;
  }

  /** Press: the note becomes the top (moved there, one more holder, if it was already held). */
  push(note: number, velocity: number): void {
    const i = this.indexOf(note);
    let count = 1;
    if (i >= 0) {
      count = Math.min(255, this.counts[i] + 1);
      this.removeAt(i);
    }
    if (this.size === NoteStack.CAPACITY) this.removeAt(0);
    this.notes[this.size] = note;
    this.vels[this.size] = velocity;
    this.counts[this.size] = count;
    this.size++;
  }

  /** Release one holder: returns true if the note is no longer held at all. */
  remove(note: number): boolean {
    const i = this.indexOf(note);
    if (i < 0) return false;
    if (--this.counts[i] > 0) return false;
    this.removeAt(i);
    return true;
  }

  clear(): void {
    this.size = 0;
  }

  private indexOf(note: number): number {
    for (let i = 0; i < this.size; i++) if (this.notes[i] === note) return i;
    return -1;
  }

  private removeAt(i: number): void {
    this.notes.copyWithin(i, i + 1, this.size);
    this.vels.copyWithin(i, i + 1, this.size);
    this.counts.copyWithin(i, i + 1, this.size);
    this.size--;
  }
}
