// L4 · the rider emblem (the POLO chest logo, reimagined), rendered from a signed distance field.
// Materials: 'embroidery' (satin border + tatami fill in gold thread, raised over a jade piqué knit, with a
// cast shadow), 'gold' (gilded relief on dark velvet with a travelling highlight), 'neon' (glow tube).
// params: { base, asset: 'emblem_main_2', mode, view: 'full' | 'macro', stitch 0..1, light 0..1 (sweep) }
import * as THREE from 'three';
import { Scene, type Frame } from '../engine/scene';
import { FSPass } from '../engine/gl';

const MODES = { embroidery: 0, gold: 1, neon: 2 } as const;
const loader = new THREE.TextureLoader();

export default class Emblem extends Scene {
  private pass!: FSPass;
  private meta: { spread: number; box: number[] } = { spread: 48, box: [0, 0, 1, 1] };

  override async init() {
    const p = this.ctx.params;
    const asset = p.asset ?? 'emblem_main_2';
    const all = await (await fetch(`${p.base}l4/sdf.json`)).json();
    this.meta = all[asset];
    const tex = await loader.loadAsync(`${p.base}l4/${this.meta ? all[asset].sdf : `${asset}_sdf.png`}`);
    tex.colorSpace = THREE.NoColorSpace; // data, not colour
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    this.pass = new FSPass(FRAG, {
      sdf: { value: tex }, spread: { value: this.meta.spread }, res: { value: new THREE.Vector2(1920, 1080) },
      t: { value: 0 }, mode: { value: 0 }, center: { value: new THREE.Vector2(0.5, 0.5) }, zoom: { value: 1 },
      rot: { value: 0 }, tilt: { value: 0 }, stitch: { value: 1 }, light: { value: 0.3 }, kick: { value: 0 },
    });
  }

  render(f: Frame, out: THREE.WebGLRenderTarget) {
    const p = this.ctx.params, u = this.pass.u;
    const [x0, y0, x1, y1] = this.meta.box as [number, number, number, number];
    const macro = p.view === 'macro';
    // framing (emblem UV, y down like the source image): full = whole rider; macro = rider's torso and blade
    const cx = macro ? (p.cx ?? 0.5) : (x0 + x1) / 2, cy = macro ? (p.cy ?? 0.36) : (y0 + y1) / 2;
    (u.center!.value as THREE.Vector2).set(cx, cy);
    // zoom: emblem height on screen as a fraction of the frame height (slow push over the entry)
    u.zoom!.value = (macro ? 2.6 : 0.82 / (y1 - y0)) * (1 + 0.05 * f.p);
    u.rot!.value = macro ? -0.12 + 0.03 * f.p : 0;
    u.tilt!.value = macro ? 0.18 : 0;
    u.mode!.value = MODES[(p.mode ?? 'embroidery') as keyof typeof MODES] ?? 0;
    u.stitch!.value = p.stitch ?? 1;
    u.light!.value = p.light ?? 0.15 + 0.7 * f.p;
    u.t!.value = f.t;
    u.kick!.value = f.a.kick;
    this.pass.render(this.ctx.renderer, out);
    return p.mode === 'gold' ? { bloom: 0.7, bloomThreshold: 1.0, vignette: 0.55, grain: 0.04, ca: 0.8 }
      : p.mode === 'neon' ? { bloom: 1.1, bloomThreshold: 0.6, vignette: 0.5, grain: 0.05, ca: 2 }
      : { bloom: 0.35, bloomThreshold: 1.1, vignette: 0.5, grain: 0.045, ca: 0.6 };
  }
}

const FRAG = /* glsl */ `
uniform sampler2D sdf; uniform float spread; uniform vec2 res; uniform float t; uniform int mode;
uniform vec2 center; uniform float zoom, rot, tilt, stitch, light, kick;

const float SRC = 2048.0; // source-image pixels per emblem UV unit
float vnoise(vec2 p) { return 0.5 + 0.5 * snoise(p); } // 0..1

// emblem UV (y down) for a screen position
vec2 toUV(vec2 frag) {
  vec2 q = (frag - 0.5 * res) / res.y;          // screen, height = 1
  q.y = -q.y;
  q /= 1.0 + tilt * q.y;                         // cheap perspective: top recedes
  float c = cos(rot), s = sin(rot);
  q = mat2(c, -s, s, c) * q;
  return center + q / zoom;
}
// signed distance in source px (+ inside the ink)
float D(vec2 uv) {
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return -spread;
  return (texture(sdf, vec2(uv.x, 1.0 - uv.y)).r * 255.0 - 128.0) / 127.0 * spread;
}
vec2 gradD(vec2 uv, float e) {
  return vec2(D(uv + vec2(e, 0.0)) - D(uv - vec2(e, 0.0)), D(uv + vec2(0.0, e)) - D(uv - vec2(0.0, e)));
}

// ---- piqué knit (POLO fabric): staggered rounded cells
float pique(vec2 px) {
  vec2 g = px / 9.0;
  g.x += 0.5 * mod(floor(g.y), 2.0);
  vec2 f = fract(g) - 0.5;
  float b = 1.0 - smoothstep(0.18, 0.5, length(f * vec2(1.0, 1.35)));
  return b * 0.8 + 0.2 * vnoise(px * 0.35);
}
vec3 fabric(vec2 uv, vec3 L, float shadow) {
  vec2 px = uv * SRC;
  float e = 1.5;
  float h0 = pique(px), hx = pique(px + vec2(e, 0.0)), hy = pique(px + vec2(0.0, e));
  vec3 n = normalize(vec3((h0 - hx) * 1.6, (h0 - hy) * 1.6, 1.0));
  float dif = max(dot(n, L), 0.0);
  vec3 base = vec3(0.045, 0.11, 0.07);               // dark jade green (linear)
  vec3 col = base * (0.35 + 0.9 * dif) + vec3(0.02, 0.04, 0.03) * pow(max(dot(reflect(-L, n), vec3(0, 0, 1)), 0.0), 8.0);
  return col * mix(1.0, 0.4, shadow);
}

// ---- embroidery thread: satin border (stitches across the edge) + tatami fill (angled brick rows)
vec3 embroidery(vec2 uv, float d, vec3 L) {
  vec2 px = uv * SRC;
  vec2 g = gradD(uv, 1.5 / SRC);
  float gl = length(g);
  vec2 n2 = gl > 1e-4 ? g / gl : vec2(0.0, 1.0);    // points inward
  float border = 11.0;
  float across, along, rowId;
  if (d < border) {                                  // satin: threads run along n2, packed along the tangent
    vec2 tg = vec2(-n2.y, n2.x);
    float s = dot(px, tg) / 2.6;
    across = fract(s); rowId = floor(s); along = d / border;
  } else {                                           // tatami fill at 35 degrees
    vec2 a = vec2(cos(0.61), sin(0.61)), b = vec2(-a.y, a.x);
    float v = dot(px, b) / 3.0;
    rowId = floor(v); across = fract(v);
    along = fract(dot(px, a) / 16.0 + rowId * 0.37);
  }
  // thread as a cylinder across its width; stitch ends pinch in
  float c = 2.0 * across - 1.0;
  float hgt = sqrt(max(0.0, 1.0 - c * c)) * smoothstep(0.0, 0.08, along) * smoothstep(1.0, 0.92, along);
  vec3 tn = normalize(vec3(c * 0.9 * (d < border ? vec2(-n2.y, n2.x) : vec2(-0.57, 0.82)), max(hgt, 0.15)));
  float dif = max(dot(tn, L), 0.0);
  float spec = pow(max(dot(reflect(-L, tn), vec3(0, 0, 1)), 0.0), 18.0);
  float jitter = hash12(vec2(rowId, floor(along * 3.0))) * 0.25;
  vec3 gold = vec3(0.78, 0.5, 0.14) * (0.85 + jitter);
  vec3 col = gold * (0.18 + 0.95 * dif) * (0.45 + 0.55 * hgt) + vec3(1.0, 0.85, 0.55) * spec * 0.9 * (0.6 + 0.8 * light);
  // stitch-by-stitch reveal (0..1): rows appear in a sweep from the blade tip down
  float order = uv.y + 0.08 * hash12(vec2(rowId, 7.0));
  float show = step(order, stitch * 1.1 - 0.05);
  return mix(vec3(-1.0), col, show);                 // -1: not stitched yet (fabric shows)
}

// ---- gilded relief on velvet
vec3 velvet(vec2 uv) {
  float n = vnoise(uv * SRC * 0.6) * 0.5 + vnoise(uv * SRC * 0.13) * 0.5;
  return vec3(0.012, 0.035, 0.024) * (0.7 + 0.6 * n);
}
vec3 gold(vec2 uv, float d, vec3 L) {
  float bevel = 9.0;
  float e = 1.2 / SRC;
  float h0 = smoothstep(0.0, bevel, d), hx = smoothstep(0.0, bevel, D(uv + vec2(e, 0.0))), hy = smoothstep(0.0, bevel, D(uv + vec2(0.0, e)));
  float ham = vnoise(uv * SRC * 0.9) * 0.012;          // hammered surface
  vec3 n = normalize(vec3((h0 - hx) * 2.2 + ham, (h0 - hy) * 2.2 - ham, 1.0));
  vec3 V = vec3(0.0, 0.0, 1.0);
  vec3 R = reflect(-V, n);
  // fake environment: warm softbox sweeping with 'light', dark room below
  float box = exp(-pow((R.x - mix(-0.8, 0.8, light)) * 3.0, 2.0)) * smoothstep(-0.3, 0.6, R.y);
  vec3 env = mix(vec3(0.05, 0.03, 0.01), vec3(0.5, 0.35, 0.15), smoothstep(-0.6, 0.8, R.y)) + vec3(3.2, 2.4, 1.3) * box;
  vec3 base = vec3(1.0, 0.72, 0.3);
  float dif = max(dot(n, L), 0.0);
  float fres = 0.6 + 0.4 * pow(1.0 - max(n.z, 0.0), 3.0);
  return base * (0.12 + 0.25 * dif) + base * env * fres;
}

void main() {
  vec2 frag = vUv * res;
  vec2 uv = toUV(frag);
  float d = D(uv);
  float aa = max(fwidth(d), 0.5);
  float ink = smoothstep(-aa, aa, d);
  vec3 L = normalize(vec3(-0.45, 0.55, 0.7));
  vec3 col;
  if (mode == 0) {
    // shadow of the raised thread onto the knit (offset away from the light)
    float sh = smoothstep(-6.0, 4.0, D(uv + vec2(0.45, -0.55) * 7.0 / SRC));
    vec3 bg = fabric(uv, L, sh * 0.9);
    vec3 th = d > -aa ? embroidery(uv, max(d, 0.0), L) : vec3(-1.0);
    col = th.x < 0.0 ? bg : mix(bg, th, ink);
  } else if (mode == 1) {
    col = mix(velvet(uv), gold(uv, d, L), ink);
    col *= mix(1.0, 0.55, smoothstep(-14.0, 0.0, d) * (1.0 - ink));  // contact shadow around the relief
  } else {
    float glow = exp(-abs(d) / 6.0) + 0.5 * exp(-abs(d) / 30.0);
    vec3 c1 = vec3(0.1, 1.0, 0.65), c2 = vec3(1.0, 0.25, 0.55);
    col = vec3(0.004, 0.01, 0.008) + mix(c1, c2, smoothstep(0.2, 0.8, uv.y)) * glow * (1.2 + kick) * smoothstep(8.0, 0.0, abs(d - 2.0) - 2.0 + 6.0);
  }
  fragColor = vec4(col, 1.0);
}`;
