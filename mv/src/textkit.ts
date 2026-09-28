// Shared helpers for lyric typography: which face a token uses, measuring, and a token's sung state.
import type { Line, Word } from './engine/lyrics';
import { F, fontStack } from './engine/type';
import type { FontKind } from './config';

/** Extra fields tools/make_mv_data.py adds to lines/words. */
export type LineX = Line & { section?: string; singer?: string; rhyme?: boolean; para?: boolean };
export type WordX = Word & { sp?: boolean };

export const isLatin = (s: string) => /[A-Za-z]/.test(s);

export function cnFamily(kind: FontKind): string {
  return kind === 'brush' ? F.brush() : kind === 'song' ? F.song(900) : F.sans(900);
}
export function latinFamily(kind: 'archivo' | 'serif'): string {
  return kind === 'serif' ? F.serif(600) : F.archivo(100, 900);
}

/** Canvas font for a token: Latin words get the Latin face first (CJK face as fallback for their punctuation). */
export function tokenFont(w: string, size: number, cn: FontKind, latin: 'archivo' | 'serif' = 'archivo') {
  return isLatin(w) ? fontStack([latinFamily(latin), cnFamily(cn)], size) : fontStack([cnFamily(cn), latinFamily(latin)], size);
}

export function measure(c: CanvasRenderingContext2D, w: string, font: string) {
  c.font = font;
  return c.measureText(w).width;
}

export type SungState = 'unsung' | 'active' | 'sung';
export function sungState(w: Word, t: number): SungState {
  return t < w.start ? 'unsung' : t < w.end ? 'active' : 'sung';
}

/** Is this word the rhyming last word of its line? */
export function isRhymeWord(l: LineX, w: Word) {
  return !!l.rhyme && w.index === l.words.length - 1;
}

/** Split a line into phrases at spaces and CJK punctuation (for vertical / scatter / split layouts). */
export function phrases(l: LineX): WordX[][] {
  const out: WordX[][] = [[]];
  for (const w of l.words as WordX[]) {
    out[out.length - 1]!.push(w);
    if (w.sp || /[，。！？、；：,.!?—]$/.test(w.w)) out.push([]);
  }
  return out.filter((p) => p.length);
}
