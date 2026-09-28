// Text PV (文字PV / kinetic typography): the lyrics are the picture. Each line gets a layout from the pool
// (never the same as the line before), characters enter as they are sung, the previous line exits when the
// next begins. Behind: faint repeated lyrics scrolling in bands. Kicks drive CA, shake and a zoom pulse.
// params: { pack, layouts?, config (TextPVConfig) }
import { Scene, type Frame, type PostOverrides } from '../engine/scene';
import { Layer2D, W, H } from '../engine/gl';
import { clamp, ease, hash, lerp, noise1, prog } from '../engine/util';
import * as THREE from 'three';
import { PACKS, type Enter, type Exit, type Layout, type StylePack, type TextPVConfig } from '../config';
import { isLatin, isRhymeWord, measure, phrases, sungState, tokenFont, type LineX, type WordX } from '../textkit';

/** A word's resting placement for a layout (centre of its box, font size, rotation, colour role). */
interface Place { w: WordX; x: number; y: number; size: number; rot: number; font: string; width: number; invert?: boolean }
interface Plan { line: LineX; layout: Layout; enter: Enter; exit: Exit; places: Place[] }

const ENTER_S = 0.22; // a character's entrance
const EXIT_S = 0.3; // the previous line's exit
const PRE_S = 0.12; // a line's layout appears this long before its first character

export default class TextPV extends Scene {
  private layer = new Layer2D();
  private plans: Plan[] = [];
  private pack!: StylePack;
  private cfg!: TextPVConfig;
  private band = '';

  override init() {
    const p = this.ctx.params;
    this.cfg = p.config;
    this.pack = PACKS[p.pack ?? this.cfg.pack] ?? PACKS.jade!;
    const layouts: Layout[] = p.layouts ?? this.cfg.layouts;
    const lines = (this.ctx.lyrics.lines as LineX[]).filter((l) => l.start >= this.ctx.start - 0.3 && l.start < this.ctx.end);
    const c = this.layer.ctx;
    let prevLayout: Layout | null = null;
    lines.forEach((l, k) => {
      let li = Math.floor(hash(l.i, 11) * layouts.length);
      if (layouts[li] === prevLayout) li = (li + 1) % layouts.length; // adjacent lines never repeat a layout
      const layout = layouts[li]!;
      prevLayout = layout;
      const enter = this.cfg.enters[Math.floor(hash(l.i, 23) * this.cfg.enters.length)]!;
      const exit = this.cfg.exits[Math.floor(hash(l.i, 37) * this.cfg.exits.length)]!;
      this.plans.push({ line: l, layout, enter, exit, places: this.place(c, l, layout, k) });
    });
    this.band = lines.map((l) => l.text).join('  ·  ');
  }

  // ------------------------------------------------------------------ layouts
  private font(w: string, size: number) { return tokenFont(w, size, this.pack.cn, this.pack.latin); }

  /** Lay words in one row centred at (cx, cy), fitted to maxW (size capped at maxSize). */
  private row(c: CanvasRenderingContext2D, ws: WordX[], cx: number, cy: number, maxW: number, maxSize: number, rot = 0): Place[] {
    const width = (s: number) => ws.reduce((a, w) => a + measure(c, w.w, this.font(w.w, s)) + (w.sp ? s * 0.3 : 0), 0);
    let size = maxSize;
    const w0 = width(100);
    if (w0 > 0) size = Math.min(maxSize, (maxW / w0) * 100);
    const total = width(size);
    let x = cx - total / 2;
    return ws.map((w) => {
      const f = this.font(w.w, size), wd = measure(c, w.w, f);
      const pl: Place = { w, x: x + wd / 2, y: cy, size, rot, font: f, width: wd };
      x += wd + (w.sp ? size * 0.3 : 0);
      return pl;
    });
  }

  private place(c: CanvasRenderingContext2D, l: LineX, layout: Layout, k: number): Place[] {
    const ws = l.words as WordX[];
    const r = (n: number) => hash(l.i, n);
    switch (layout) {
      case 'center':
        return this.row(c, ws, W / 2, H / 2, 1560, 190);
      case 'giant': // small running line at the bottom; the sung word is drawn huge separately
        return this.row(c, ws, W / 2, H - 120, 1500, 64);
      case 'marquee':
        return this.row(c, ws, W / 2, H / 2, 3000, 230);
      case 'split': {
        const ph = phrases(l);
        const cut = Math.max(1, Math.ceil(ph.length / 2));
        const left = ph.slice(0, cut).flat(), right = ph.slice(cut).flat();
        const a = this.row(c, left, W / 4, H / 2, 820, 170);
        const b = right.length ? this.row(c, right, (3 * W) / 4, H / 2, 820, 170) : [];
        b.forEach((p) => (p.invert = true));
        return [...a, ...b];
      }
      case 'vertical': { // 竖排: phrases as columns, right to left
        const ph = phrases(l);
        const longest = Math.max(...ph.map((p) => p.reduce((a, w) => a + (isLatin(w.w) ? 2 : 1), 0)));
        const size = Math.min(150, 860 / Math.max(1, longest));
        const colW = size * 1.5, x0 = W / 2 + ((ph.length - 1) * colW) / 2;
        const out: Place[] = [];
        ph.forEach((p, ci) => {
          const n = p.reduce((a, w) => a + (isLatin(w.w) ? 2 : 1), 0);
          let y = H / 2 - (n * size) / 2 + size * 0.5 + (ci % 2) * size * 0.4;
          for (const w of p) {
            const f = this.font(w.w, size), lat = isLatin(w.w);
            out.push({ w, x: x0 - ci * colW, y: y + (lat ? size * 0.5 : 0), size, rot: lat ? Math.PI / 2 : 0, font: f, width: measure(c, w.w, f) });
            y += lat ? size * 2 : size;
          }
        });
        return out;
      }
      case 'scatter': { // 混排: phrase chunks at mixed sizes on two rows, slight tilt
        const ph = phrases(l);
        const rows = ph.length > 2 ? 2 : 1;
        const out: Place[] = [];
        ph.forEach((p, i) => {
          const row = rows === 2 ? (i < Math.ceil(ph.length / 2) ? 0 : 1) : 0;
          const inRow = rows === 2 ? (row === 0 ? Math.ceil(ph.length / 2) : ph.length - Math.ceil(ph.length / 2)) : ph.length;
          const col = row === 0 ? i : i - Math.ceil(ph.length / 2);
          const cx = W * ((col + 0.5) / inRow) * 0.86 + W * 0.07 + (r(i + 5) - 0.5) * 60;
          const cy = (rows === 2 ? H * (row ? 0.64 : 0.36) : H / 2) + (r(i + 9) - 0.5) * 70;
          const size = lerp(110, 200, r(i + 13));
          out.push(...this.row(c, p, cx, cy, (W / inRow) * 0.9, size, (r(i + 17) - 0.5) * 0.12));
        });
        return out;
      }
    }
    void k;
    return [];
  }

  // ------------------------------------------------------------------ drawing
  private colour(pl: Place, l: LineX, t: number) {
    const st = sungState(pl.w, t), pk = this.pack;
    if (st === 'active') return pk.accent;
    if (st === 'sung' && isRhymeWord(l, pl.w)) return pk.accent2;
    return pl.invert ? pk.bg : pk.fg;
  }

  /** One word at its place, with the entrance (0..1 progress `e`) and exit (`x`) applied. */
  private word(c: CanvasRenderingContext2D, pl: Place, l: LineX, t: number, enter: Enter, e: number, exit: Exit, x: number, idx: number) {
    const I = this.cfg.intensity;
    let dx = 0, dy = 0, s = 1, rot = pl.rot, alpha = 1, blur = 0, clipK = 1, glitch = 0;
    switch (enter) {
      case 'pop': s *= lerp(1.8, 1, ease.outBack(e)); alpha *= clamp(e * 3); break;
      case 'rise': dy += 70 * I * (1 - ease.outCubic(e)); alpha *= e; break;
      case 'blur': blur += 18 * (1 - e); alpha *= e; break;
      case 'slice': clipK = ease.outCubic(e); break;
      case 'glitch': glitch = 1 - e; alpha *= e > 0 ? 1 : 0; break;
      case 'type': alpha *= e > 0 ? 1 : 0; break;
    }
    if (x > 0) switch (exit) {
      case 'drift': dy -= 90 * ease.inCubic(x); alpha *= 1 - x; break;
      case 'shrink': s *= 1 - 0.7 * ease.inCubic(x); alpha *= 1 - x; break;
      case 'blur': blur += 24 * x; alpha *= 1 - x; break;
      case 'scatter': {
        const a = hash(l.i, idx, 3) * Math.PI * 2;
        dx += Math.cos(a) * 420 * ease.inCubic(x); dy += Math.sin(a) * 420 * ease.inCubic(x); rot += (hash(l.i, idx, 5) - 0.5) * 2 * x; alpha *= 1 - x;
        break;
      }
      case 'glitch': glitch = Math.max(glitch, x); alpha *= hash(Math.floor(t * 60), idx) > x ? 1 - x * 0.5 : 0; break;
    }
    if (alpha <= 0.001 || s <= 0.01) return;
    c.save();
    c.globalAlpha = alpha;
    if (blur > 0.3) c.filter = `blur(${blur.toFixed(1)}px)`;
    c.translate(pl.x + dx, pl.y + dy);
    c.rotate(rot);
    c.scale(s, s);
    c.font = pl.font;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    if (clipK < 1) { c.beginPath(); c.rect(-pl.width, pl.size * (0.6 - 1.2 * clipK), pl.width * 2, pl.size * 1.2 * clipK); c.clip(); }
    if (glitch > 0) {
      const j = (hash(Math.floor(t * 60), idx, 7) - 0.5) * 36 * glitch * I;
      c.globalCompositeOperation = this.pack.paper ? 'multiply' : 'lighter';
      c.fillStyle = this.pack.paper ? '#00c8ff' : '#ff2a2a'; c.fillText(pl.w.w, j + 8 * glitch, 0);
      c.fillStyle = this.pack.paper ? '#ff3060' : '#2af0ff'; c.fillText(pl.w.w, -j - 8 * glitch, 0);
      c.globalCompositeOperation = 'source-over';
    }
    c.fillStyle = this.colour(pl, l, t);
    c.fillText(pl.w.w, 0, 0);
    c.restore();
  }

  private drawPlan(c: CanvasRenderingContext2D, plan: Plan, t: number, x: number) {
    const l = plan.line;
    if (plan.layout === 'split') { // the right half is inverted
      c.fillStyle = this.pack.fg;
      const k = ease.outExpo(prog(t, l.start - PRE_S, l.start + 0.25));
      c.fillRect(W - (W / 2) * k, 0, (W / 2) * k, H);
    }
    if (plan.layout === 'marquee') { // the whole line slides right-to-left while it is sung
      const drift = -(t - l.start) * 70 * this.cfg.intensity;
      c.save(); c.translate(drift + 260, 0);
    }
    plan.places.forEach((pl, i) => {
      const e = prog(t, pl.w.start, pl.w.start + ENTER_S);
      if (e <= 0 && plan.layout !== 'giant') return;
      if (plan.layout === 'giant' && e <= 0) return;
      this.word(c, pl, l, t, plan.enter, e, plan.exit, x, i);
    });
    if (plan.layout === 'marquee') c.restore();
    if (plan.layout === 'giant' && x <= 0) { // the word being sung, huge
      const cur = [...plan.places].reverse().find((p) => t >= p.w.start);
      if (cur) {
        const size = isLatin(cur.w.w) ? 300 : 520;
        const f = this.font(cur.w.w, size);
        const big: Place = { ...cur, x: W / 2, y: H / 2 - 40, size, rot: 0, font: f, width: measure(c, cur.w.w, f) };
        const k = prog(t, cur.w.start, cur.w.start + 0.16);
        const fade = 1 - prog(t, cur.w.end + 0.05, cur.w.end + 0.25);
        c.save(); c.globalAlpha = fade;
        this.word(c, big, l, t, 'pop', k, plan.exit, 0, 999);
        c.restore();
      }
    }
  }

  private background(c: CanvasRenderingContext2D, f: Frame) {
    const pk = this.pack;
    c.fillStyle = pk.bg;
    c.fillRect(0, 0, W, H);
    if (this.cfg.bgTexture <= 0 || !this.band) return;
    c.save();
    c.globalAlpha = this.cfg.bgTexture;
    c.fillStyle = pk.bgText;
    const size = 72;
    c.font = tokenFont('字', size, pk.cn, pk.latin);
    c.textBaseline = 'middle';
    const bw = Math.max(400, measure(c, this.band + '  ·  ', c.font));
    for (let row = 0; row < 12; row++) {
      const dir = row % 2 ? 1 : -1;
      const off = ((f.t * 40 * dir + row * 377) % bw + bw) % bw;
      for (let x = -off; x < W; x += bw) c.fillText(this.band + '  ·  ', x, row * size * 1.25 + 30);
    }
    c.restore();
  }

  render(f: Frame, out: THREE.WebGLRenderTarget): PostOverrides {
    const c = this.layer.ctx, t = f.t, I = this.cfg.intensity;
    this.layer.clear();
    this.background(c, f);
    // current line: last whose layout has appeared; the previous one exits over EXIT_S
    let k = -1;
    for (let i = 0; i < this.plans.length; i++) if (this.plans[i]!.line.start - PRE_S <= t) k = i;
    const cur = this.plans[k];
    if (cur) {
      const prev = this.plans[k - 1];
      const x = prev ? prog(t, cur.line.start - PRE_S, cur.line.start - PRE_S + EXIT_S) : 1;
      if (prev && x < 1) this.drawPlan(c, prev, t, x);
      // a line whose last character ended long ago fades out (instrumental gaps inside the section)
      const idle = prog(t, cur.line.end + 1.2, cur.line.end + 1.6);
      if (idle < 1) this.drawPlan(c, cur, t, idle);
    }
    this.ctx.comp.draw(this.ctx.renderer, this.layer.upload(), out, { mode: 'replace' });

    const kick = f.a.kick, pk = this.pack;
    const lineHit = cur ? Math.pow(0.5, Math.max(0, t - cur.line.start) / 0.08) * (t >= cur.line.start ? 1 : 0) : 0;
    return {
      ca: pk.ca * (1 + 0.9 * kick * I),
      grain: pk.grain,
      vignette: pk.vignette,
      bloom: pk.paper ? 0.15 : 0.5,
      bloomThreshold: pk.paper ? 1.4 : 0.9,
      halation: pk.paper ? 0.05 : 0.25,
      shake: [noise1(t * 30, 1) * 7 * kick * I, noise1(t * 30, 2) * 7 * kick * I],
      zoom: 1 + 0.014 * kick * I,
      flash: cur?.layout === 'giant' ? 0.12 * lineHit : 0,
    };
  }
}
