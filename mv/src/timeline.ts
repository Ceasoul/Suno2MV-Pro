// The edit, generated from the song's sections (audio.json, cut on downbeats by tools/make_mv_data.py):
// choruses play the Text PV scene (karaoke layer off), everything else the cover with karaoke subtitles.
// songs/<id>/mv.json can override a section's scene, style pack and layouts.
import type { TimelineEntry } from './engine/engine';
import type { SceneClass } from './engine/scene';
import type { Lyrics } from './engine/lyrics';
import type { AudioData } from './engine/audio';
import type { MVConfig } from './config';

const modules = import.meta.glob<{ default: SceneClass }>('./scenes/*.ts');
const scene = (name: string) => () => {
  const m = modules[`./scenes/${name}.ts`];
  return m ? m() : Promise.reject(new Error(`scene module not found: scenes/${name}.ts`));
};

/** Style packs for successive choruses when mv.json doesn't pick one. */
const CHORUS_PACKS = ['jade', 'noir', 'caution', 'paper'];
const XFADE = 0.6; // cover -> cover crossfade

/** Section id used as the key in mv.json: index + name ("3-chorus"), so repeated sections can differ. */
export const sectionId = (i: number, name: string) => `${i}-${name.replace(/\s+/g, '').toLowerCase()}`;

/** Shot start times for n images over [s, e): evenly spaced, snapped to the nearest downbeat inside. */
function cutsFor(n: number, s: number, e: number, downbeats: number[]) {
  const inside = downbeats.filter((d) => d > s + 1 && d < e - 1);
  return Array.from({ length: n }, (_, i) => {
    if (i === 0) return s;
    const ideal = s + (i * (e - s)) / n;
    return inside.reduce((b, d) => (Math.abs(d - ideal) < Math.abs(b - ideal) ? d : b), inside[0] ?? ideal);
  });
}

export function makeTimelineFor(cfg: MVConfig, song: { base: string; cover: string | null }) {
  return (_ly: Lyrics, au: AudioData): TimelineEntry[] => {
    let chorus = 0;
    const out: TimelineEntry[] = au.sections.map((s, i) => {
      const id = sectionId(i, s.name);
      const own = cfg.sections[id] ?? cfg.sections[s.name] ?? {};
      // choruses (not pre-choruses) get the Text PV
      const isChorus = /chorus/i.test(s.name) && !/pre-?\s*chorus/i.test(s.name);
      const kind = own.scene ?? (isChorus || !song.cover ? 'textpv' : 'cover');
      if (isChorus && !own.pack) chorus++;
      if (kind !== 'textpv' && kind !== 'cover') { // an L4 scene module
        return { id, load: scene(kind), start: s.start, end: s.end, params: { karaoke: false, base: song.base, section: s.name, ...own.params } };
      }
      if (kind === 'textpv') {
        const pack = own.pack ?? CHORUS_PACKS[(Math.max(1, chorus) - 1) % CHORUS_PACKS.length];
        return { id, load: scene('textpv'), start: s.start, end: s.end, params: { karaoke: false, pack, layouts: own.layouts, config: cfg.textpv, section: s.name } };
      }
      const images = own.images?.length ? own.images : song.cover ? [song.cover] : [];
      return { id, load: scene('cover'), start: s.start, end: s.end, params: { karaoke: true, base: song.base, images, rev: cfg.rev ?? 0, cuts: cutsFor(images.length, s.start, s.end, au.downbeats), seed: i, title: i === 0 ? cfg.title : undefined, section: s.name } };
    });
    // soften image -> image cuts (other cuts land hard on the downbeat)
    out.forEach((e, i) => { const n = out[i + 1]; if (n && e.params?.images && n.params?.images) e.end = n.start + XFADE; });
    return out;
  };
}
