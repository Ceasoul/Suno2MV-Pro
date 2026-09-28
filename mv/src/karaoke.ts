// Global karaoke subtitle layer (suno.bi-style), drawn over the scenes before post-processing.
// Lines are grouped into pages of 1–2 lines inside a section; a page shows `lead` s before its first
// character and holds until the next page. Characters: unsung (faint or hidden) -> active (blue, pops in)
// -> sung (white); the rhyming last character of a line turns the rhyme colour once sung.
import * as THREE from 'three';
import { Layer2D, W, H, type Compositor } from './engine/gl';
import type { Lyrics } from './engine/lyrics';
import { clamp, ease, prog } from './engine/util';
import type { KaraokeConfig } from './config';
import { isRhymeWord, measure, sungState, tokenFont, type LineX, type WordX } from './textkit';

interface Page { lines: LineX[]; show: number; hide: number }

export class Karaoke {
  private layer = new Layer2D();
  private pages: Page[] = [];

  constructor(ly: Lyrics, private cfg: KaraokeConfig) {
    const lines = ly.lines as LineX[];
    let cur: LineX[] = [];
    const flush = () => { if (cur.length) this.pages.push({ lines: cur, show: 0, hide: 0 }); cur = []; };
    lines.forEach((l, i) => {
      const prev = lines[i - 1];
      if (cur.length >= cfg.lines || (prev && (prev.section !== l.section || l.start - prev.end > 3))) flush();
      cur.push(l);
    });
    flush();
    // show: `lead` before the first character, but not before the previous page's last character ends
    this.pages.forEach((p, i) => {
      const first = p.lines[0]!.start;
      p.show = Math.min(first, Math.max(first - cfg.lead, i ? this.pages[i - 1]!.lines.at(-1)!.end : 0));
    });
    // hide: exactly when the next page shows (no gap), but not held through a long instrumental gap
    this.pages.forEach((p, i) => {
      const next = this.pages[i + 1], hold = p.lines.at(-1)!.end + 2.5;
      p.hide = next ? Math.min(next.show, Math.max(hold, p.show)) : hold;
    });
  }

  /** Draw the page at t into `target` (HDR). */
  draw(t: number, renderer: THREE.WebGLRenderer, comp: Compositor, target: THREE.WebGLRenderTarget) {
    const page = this.pages.find((p) => t >= p.show && t < p.hide);
    if (!page || !this.cfg.enabled) return;
    const c = this.layer.ctx, cfg = this.cfg;
    this.layer.clear();
    const fade = Math.min(prog(t, page.show, page.show + 0.25), 1 - prog(t, page.hide - 0.25, page.hide));
    const lh = cfg.size * 1.4;
    const n = page.lines.length;
    const baseY = cfg.position === 'bottom' ? H - 96 - cfg.offsetY : cfg.position === 'top' ? 90 + cfg.size + (n - 1) * lh - cfg.offsetY : H / 2 + ((n - 1) * lh) / 2 + cfg.size * 0.35 - cfg.offsetY;
    c.textBaseline = 'alphabetic';
    c.shadowColor = cfg.colors.shadow;
    c.shadowBlur = 14;
    c.shadowOffsetY = 2;

    page.lines.forEach((l, li) => {
      const y = baseY - (n - 1 - li) * lh;
      const words = l.words as WordX[];
      const fonts = words.map((w) => tokenFont(w.w, cfg.size, cfg.font));
      const gap = cfg.size * 0.35;
      const widths = words.map((w, i) => measure(c, w.w, fonts[i]!));
      const total = widths.reduce((a, b, i) => a + b + (words[i]!.sp ? gap : 0), 0);
      let x = cfg.align === 'center' ? (W - total) / 2 : 110;
      words.forEach((w, i) => {
        const wd = widths[i]!;
        const st = sungState(w, t);
        if (!(st === 'unsung' && cfg.reveal === 'appear')) {
          c.font = fonts[i]!;
          c.fillStyle = st === 'active' ? cfg.colors.active
            : st === 'sung' ? (cfg.rhymeHighlight && isRhymeWord(l, w) ? cfg.colors.rhyme : cfg.colors.sung)
            : cfg.colors.unsung;
          const k = cfg.pop && st !== 'unsung' ? prog(t, w.start, w.start + 0.18, ease.outCubic) : 1;
          const s = 1 + 0.28 * (1 - k);
          c.save();
          c.globalAlpha = fade * (st === 'unsung' ? 1 : clamp(0.35 + k));
          c.translate(x + wd / 2, y - cfg.size * 0.35);
          c.scale(s, s);
          c.fillText(w.w, -wd / 2, cfg.size * 0.35);
          c.restore();
        }
        x += wd + (w.sp ? gap : 0);
      });
    });
    c.shadowBlur = 0;
    comp.draw(renderer, this.layer.upload(), target, { mode: 'normal', tint: [0.92, 0.92, 0.92] });
  }
}
