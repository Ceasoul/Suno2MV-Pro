// Boot an engine for one song (shared by the preview/export page and the editor):
// song.json + mv.json -> timeline, engine, global karaoke layer; apply() swaps the config live.
import { Engine } from './engine/engine';
import { makeTimelineFor } from './timeline';
import { loadConfig, type MVConfig } from './config';
import { Karaoke } from './karaoke';

export interface SongMeta { id: string; title?: string; artist?: string; audio: string; cover: string | null; chars: string; tags?: string }

export interface App {
  engine: Engine;
  cfg: MVConfig;
  meta: SongMeta;
  base: string;
  /** Apply a new config without reloading the page (rebuilds the timeline and scenes). */
  apply(cfg: MVConfig): Promise<void>;
}

export async function bootApp(canvas: HTMLCanvasElement, song: string, only?: Set<string> | null, cfgName = 'mv.json'): Promise<App> {
  const base = `songs/${song}/`;
  const meta: SongMeta = await (await fetch(`${base}song.json`)).json();
  let cfg = await loadConfig(base, cfgName);
  const engine = new Engine(canvas, makeTimelineFor(cfg, { base, cover: meta.cover }));
  engine.base = base;
  await engine.init(only ? (e) => only.has(e.id) : undefined);
  let kara = new Karaoke(engine.lyrics, cfg.karaoke);
  // global karaoke layer: over scenes whose entry has params.karaoke (images), not once a Text PV is on
  engine.overlay = (t, rt, active) => {
    if (active.some((e) => e.params?.karaoke) && !active.some((e) => e.params?.karaoke === false && t >= e.start)) kara.draw(t, engine.renderer, engine.comp, rt);
  };
  const app: App = {
    engine, meta, base,
    get cfg() { return cfg; },
    async apply(next) {
      cfg = next;
      kara = new Karaoke(engine.lyrics, cfg.karaoke);
      engine.makeTimeline = makeTimelineFor(cfg, { base, cover: meta.cover });
      await engine.rebuild();
    },
  };
  return app;
}
