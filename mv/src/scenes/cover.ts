// Background images for a section: one shot per image (cut on downbeats, 0.5 s crossfade), each with a slow
// Ken Burns move, a small zoom pulse on kicks and a dark gradient at the bottom for the subtitles.
// params: { base, images: string[] (paths under base), cuts: number[] (shot start times), seed, title? }
import { Scene, type Frame } from '../engine/scene';
import { Layer2D, W, H } from '../engine/gl';
import { F, font } from '../engine/type';
import { clamp, ease, lerp, prog, smoothstep } from '../engine/util';
import * as THREE from 'three';

const images = new Map<string, Promise<HTMLImageElement>>();
function loadImage(url: string) {
  if (!images.has(url)) images.set(url, new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; }));
  return images.get(url)!;
}
/** Forget a cached image (the editor replaced the file). */
export function forgetImage(url: string) { images.delete(url); }

const XFADE = 0.5;

export default class Cover extends Scene {
  private layer = new Layer2D();
  private imgs: HTMLImageElement[] = [];
  private cuts: number[] = [];

  override async init() {
    const p = this.ctx.params;
    const list: string[] = p.images?.length ? p.images : [p.cover];
    this.imgs = await Promise.all(list.map((u) => loadImage(`${p.base}${encodeURI(u)}?v=${p.rev ?? 0}`)));
    this.cuts = p.cuts?.length === list.length ? p.cuts : list.map((_, i) => this.ctx.start + (i * (this.ctx.end - this.ctx.start)) / list.length);
  }

  /** Draw image `img` full-bleed with a Ken Burns move at progress q (0..1) of its shot. */
  private shot(c: CanvasRenderingContext2D, img: HTMLImageElement, q: number, seed: number, kick: number) {
    const zoom = lerp(1.04, 1.14, ease.inOutQuad(clamp(q))) + 0.008 * kick;
    const sc = Math.max(W / img.width, H / img.height) * zoom; // cover the frame
    const sw = W / sc, sh = H / sc;
    const a = [0.1, 0.55, 0.3, 0.7][seed % 4]!, b = [0.45, 0.2, 0.6, 0.35][seed % 4]!;
    const k = lerp(a, b, ease.inOutQuad(clamp(q)));
    const sx = (img.width - sw) * (img.width / img.height > W / H ? k : 0.5) + Math.sin(q * 3 + seed) * 6;
    const sy = (img.height - sh) * (img.width / img.height > W / H ? 0.5 : k);
    c.drawImage(img, sx, sy, sw, sh, 0, 0, W, H);
  }

  render(f: Frame, out: THREE.WebGLRenderTarget) {
    const c = this.layer.ctx, p = this.ctx.params;
    const seed = p.seed ?? 0;
    this.layer.clear('#000');
    let k = 0;
    for (let i = 0; i < this.cuts.length; i++) if (this.cuts[i]! <= f.t) k = i;
    const s0 = this.cuts[k]!, s1 = this.cuts[k + 1] ?? this.ctx.end;
    const q = (f.t - s0) / Math.max(0.1, s1 - s0);
    if (k > 0 && f.t < s0 + XFADE) { // crossfade from the previous shot
      const pq = (f.t - this.cuts[k - 1]!) / Math.max(0.1, s0 - this.cuts[k - 1]!);
      this.shot(c, this.imgs[k - 1]!, pq, seed + k - 1, f.a.kick);
      c.globalAlpha = ease.inOutQuad(prog(f.t, s0, s0 + XFADE));
    }
    this.shot(c, this.imgs[k]!, q, seed + k, f.a.kick);
    c.globalAlpha = 1;
    // bottom gradient for the subtitles + overall dim
    const g = c.createLinearGradient(0, H * 0.45, 0, H);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.72)');
    c.fillStyle = g;
    c.fillRect(0, 0, W, H);
    c.fillStyle = 'rgba(0,0,0,0.18)';
    c.fillRect(0, 0, W, H);

    if (p.title) this.titleCard(c, f, p.title);
    this.ctx.comp.draw(this.ctx.renderer, this.layer.upload(), out, { mode: 'replace' });
    return { bloom: 0.45, grain: 0.05, vignette: 0.45, ca: 1.2, fade: 1 - smoothstep(0, 1.2, f.t) };
  }

  /** Intro title: SOLO wordmark (serif, tracked) + 千里走单骑 + GUAN YUNCHANG, before the first vocal. */
  private titleCard(c: CanvasRenderingContext2D, f: Frame, title: { main: string; sub?: string; small?: string; until?: number }) {
    const t0 = 0.6, t1 = title.until ?? 6.2;
    const a = Math.min(prog(f.t, t0, t0 + 1.2, ease.outCubic), 1 - prog(f.t, t1 - 0.7, t1));
    if (a <= 0 || !title.main) return;
    const rise = (1 - prog(f.t, t0, t0 + 1.6, ease.outCubic)) * 30;
    c.save();
    c.globalAlpha = a;
    c.fillStyle = 'rgba(0,0,0,0.35)';
    c.fillRect(0, 0, W, H);
    c.textAlign = 'center';
    c.fillStyle = '#f3ecdd';
    c.shadowColor = 'rgba(0,0,0,0.6)';
    c.shadowBlur = 24;
    c.font = font(F.serif(600), 250);
    (c as any).letterSpacing = '26px';
    c.fillText(title.main, W / 2 + 13, H / 2 + 40 + rise);
    if (title.small) {
      c.font = font(F.serif(400), 40);
      (c as any).letterSpacing = '18px';
      c.fillText(title.small, W / 2 + 9, H / 2 + 118 + rise);
    }
    if (title.sub) {
      c.font = font(F.song(900), 64);
      (c as any).letterSpacing = '22px';
      c.fillStyle = '#e2b458';
      c.fillText(title.sub, W / 2 + 11, H / 2 - 190 + rise);
    }
    c.restore();
    (c as any).letterSpacing = '0px';
  }
}
