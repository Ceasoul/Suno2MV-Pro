// L1 settings: karaoke subtitles (suno.bi-style) and Text PV style packs.
// Defaults here; a song overrides them in songs/<id>/mv.json (deep-merged).

export type FontKind = 'sans' | 'song' | 'brush';

export interface KaraokeConfig {
  enabled: boolean;
  font: FontKind;
  /** px at 1080p */
  size: number;
  position: 'bottom' | 'center' | 'top';
  /** extra px offset (positive = up) */
  offsetY: number;
  align: 'left' | 'center';
  /** lines per page (suno.bi shows 1–2) */
  lines: 1 | 2;
  /** unsung characters: 'appear' = hidden until sung (char by char), 'dim' = shown faint */
  reveal: 'appear' | 'dim';
  colors: { sung: string; active: string; unsung: string; rhyme: string; shadow: string };
  /** colour the rhyming last character of a line */
  rhymeHighlight: boolean;
  /** a character pops in (scale + fade) when it starts */
  pop: boolean;
  /** seconds a page shows before its first character */
  lead: number;
}

export type Layout = 'center' | 'giant' | 'vertical' | 'scatter' | 'split' | 'marquee';
export type Enter = 'pop' | 'slice' | 'blur' | 'glitch' | 'rise' | 'type';
export type Exit = 'drift' | 'shrink' | 'blur' | 'scatter' | 'glitch';

export interface StylePack {
  name: string;
  bg: string;
  fg: string;
  /** the character being sung */
  accent: string;
  /** rhyme / line-end highlight */
  accent2: string;
  /** the faint repeated lyric texture behind */
  bgText: string;
  cn: FontKind;
  /** Latin face (for SOLO / POLO) */
  latin: 'archivo' | 'serif';
  /** post: chromatic aberration px, grain, vignette */
  ca: number;
  grain: number;
  vignette: number;
  /** paper stock: brighter frame, less bloom */
  paper: boolean;
}

export interface TextPVConfig {
  pack: string;
  layouts: Layout[];
  enters: Enter[];
  exits: Exit[];
  /** 0..2 motion strength (shake/zoom on kicks, entrance distance) */
  intensity: number;
  /** 0..1 the repeated-lyric background texture */
  bgTexture: number;
}

/** Per-section settings, keyed by section id ("3-chorus": index + name, so repeated sections can differ). */
export interface SectionConfig {
  /** 'cover' = images (the section's own, or the album cover) with karaoke; 'textpv' = kinetic type;
   *  any other name = a scene module in src/scenes/ (L4), with `params` */
  scene?: 'cover' | 'textpv' | (string & {});
  params?: Record<string, any>;
  pack?: string;
  layouts?: Layout[];
  /** image paths under the song folder (e.g. images/3-chorus-1.png); one shot each, cut on downbeats */
  images?: string[];
  /** custom prompt for this section's generated images (else built from lyrics + style + protagonist) */
  prompt?: string;
}

/** AI image generation (server side: OpenAI-compatible images API, key in .env). */
export interface AIConfig {
  /** visual style preset key (STYLES) */
  style: string;
  /** protagonist description kept in every prompt (character consistency) */
  protagonist: string;
  /** extra words appended to every prompt */
  extra: string;
  /** images per section when generating all */
  perSection: number;
}

export interface MVConfig {
  karaoke: KaraokeConfig;
  textpv: TextPVConfig;
  sections: Record<string, SectionConfig>;
  ai: AIConfig;
  /** bumped when image files are renamed (cache busting) */
  rev?: number;
  /** intro title card */
  title?: { main: string; sub?: string; small?: string; until?: number };
}

/** Visual style presets for generated images (prompt fragments). */
export const STYLES: Record<string, { name: string; prompt: string }> = {
  cinematic: { name: '电影写实', prompt: 'cinematic film still, dramatic lighting, shallow depth of field, anamorphic lens, rich color grading, 35mm' },
  guofeng: { name: '国风电影', prompt: 'Chinese historical epic cinematography, ink-dark night, lanterns, wet stone streets, cinematic lighting, highly detailed' },
  ink: { name: '水墨', prompt: 'traditional Chinese ink wash painting, sumi-e, expressive brush strokes, rice paper texture, minimal color with vermilion accents' },
  neon: { name: '霓虹赛博', prompt: 'cyberpunk neon night, magenta and cyan lights, rain reflections, high contrast, futuristic' },
  anime: { name: '新海诚动漫', prompt: 'anime key visual, Makoto Shinkai style, vivid sky, detailed light rays, cinematic composition' },
  poster: { name: '潮牌海报', prompt: 'streetwear fashion campaign poster, bold graphic composition, studio lighting, magazine editorial, clean background' },
};

export const PACKS: Record<string, StylePack> = {
  // 墨绿：POLO 衫的墨绿 + 骨白字 + 鎏金正在唱 + 朱砂押韵字，毛笔楷
  jade: { name: '墨绿', bg: '#0e2a1f', fg: '#efe6cf', accent: '#e2b458', accent2: '#d83a2e', bgText: 'rgba(239,230,207,0.07)', cn: 'brush', latin: 'serif', ca: 2.5, grain: 0.07, vignette: 0.45, paper: false },
  noir: { name: 'Noir Chroma', bg: '#0a0a0c', fg: '#f2efe8', accent: '#ff3b3b', accent2: '#35e0ff', bgText: 'rgba(242,239,232,0.06)', cn: 'sans', latin: 'archivo', ca: 5, grain: 0.08, vignette: 0.4, paper: false },
  caution: { name: 'Caution', bg: '#f3d20b', fg: '#121212', accent: '#e0321b', accent2: '#1a1a1a', bgText: 'rgba(0,0,0,0.07)', cn: 'sans', latin: 'archivo', ca: 3, grain: 0.06, vignette: 0.2, paper: true },
  paper: { name: 'Paper Ink', bg: '#ebe5d8', fg: '#1d1b18', accent: '#d9541e', accent2: '#2c6e49', bgText: 'rgba(0,0,0,0.06)', cn: 'song', latin: 'serif', ca: 1.5, grain: 0.09, vignette: 0.25, paper: true },
};

export const DEFAULT_CONFIG: MVConfig = {
  karaoke: {
    enabled: true, font: 'sans', size: 64, position: 'bottom', offsetY: 0, align: 'left', lines: 2, reveal: 'dim',
    colors: { sung: '#ffffff', active: '#3fa9ff', unsung: 'rgba(255,255,255,0.38)', rhyme: '#ffd23f', shadow: 'rgba(0,0,0,0.75)' },
    rhymeHighlight: true, pop: true, lead: 0.6,
  },
  textpv: {
    pack: 'jade', layouts: ['center', 'giant', 'vertical', 'scatter', 'split', 'marquee'],
    enters: ['pop', 'slice', 'blur', 'glitch', 'rise'], exits: ['drift', 'shrink', 'blur', 'scatter', 'glitch'],
    intensity: 1, bgTexture: 1,
  },
  sections: {},
  ai: { style: 'guofeng', protagonist: '', extra: '', perSection: 1 },
};

function isObj(x: unknown): x is Record<string, any> {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}
export function merge<T>(a: T, b: any): T {
  if (!isObj(b)) return (b ?? a) as T;
  const out: any = { ...(a as any) };
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj((a as any)[k]) ? merge((a as any)[k], v) : v;
  return out;
}

export async function loadConfig(base: string, name = 'mv.json'): Promise<MVConfig> {
  const r = await fetch(`${base}${name}?v=${Date.now()}`);
  const own = r.ok && (r.headers.get('content-type') ?? '').includes('json') ? await r.json() : {};
  return merge(DEFAULT_CONFIG, own);
}
