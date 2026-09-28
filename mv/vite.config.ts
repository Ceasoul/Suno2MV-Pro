import { defineConfig, type Plugin } from 'vite';
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

// songs/<id>/ (lyrics.json, audio.json, song.json, mv.json, audio, cover, fonts/, images/) is served from the app root.
const APP = import.meta.dirname;
const ROOT = path.resolve(APP, '..');

/** .env in the project root (SunoLyricSync/.env, git-ignored): OPENAI_API_KEY etc. Never sent to the browser. */
function loadEnv() {
  const f = path.join(ROOT, '.env');
  if (!existsSync(f)) return;
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith('#') && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }
}

const SONG_RE = /^[\w-]+$/;
// image names follow the naming rule "{序号}-{段落}-{镜头}.png" (spaces allowed, e.g. "4-Pre-Chorus 1-1.png")
const FILE_RE = /^[\w .-]+\.(png|jpe?g|webp)$/i;

function body(req: IncomingMessage, limit = 40 << 20): Promise<Buffer> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => { n += c.length; if (n > limit) { rej(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => res(Buffer.concat(chunks)));
    req.on('error', rej);
  });
}
function send(res: ServerResponse, code: number, obj: unknown) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}
function songDir(q: URLSearchParams) {
  const s = q.get('song') ?? '';
  if (!SONG_RE.test(s)) throw new Error('bad song id');
  const d = path.join(APP, 'songs', s);
  if (!existsSync(path.join(d, 'song.json'))) throw new Error('song not found');
  return d;
}

/** Local editor API (dev server only, localhost): save config, upload/generate images, export video. */
function editorApi(): Plugin {
  let render: { proc: ChildProcess | null; log: string; out: string; done: boolean; code: number | null } | null = null;
  return {
    name: 'editor-api',
    configureServer(server) {
      loadEnv();
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/__api/')) return next();
        const url = new URL(req.url, 'http://x');
        const q = url.searchParams;
        try {
          switch (`${req.method} ${url.pathname}`) {
            case 'GET /__api/songs': {
              const d = path.join(APP, 'songs');
              const list = readdirSync(d).filter((s) => existsSync(path.join(d, s, 'song.json')))
                .map((s) => ({ id: s, title: JSON.parse(readFileSync(path.join(d, s, 'song.json'), 'utf8')).title }));
              return send(res, 200, list);
            }
            case 'POST /__api/config': {
              const cfg = JSON.parse((await body(req, 2 << 20)).toString('utf8'));
              const name = q.get('cfg') ?? 'mv.json';
              if (!/^mv[\w-]*\.json$/.test(name)) throw new Error('bad config name');
              writeFileSync(path.join(songDir(q), name), JSON.stringify(cfg, null, 2), 'utf8');
              return send(res, 200, { ok: true });
            }
            case 'POST /__api/upload': {
              const name = q.get('name') ?? '';
              if (!FILE_RE.test(name)) throw new Error('bad file name (png/jpg/webp only)');
              const dir = path.join(songDir(q), 'images');
              mkdirSync(dir, { recursive: true });
              writeFileSync(path.join(dir, name), await body(req));
              return send(res, 200, { path: `images/${name}` });
            }
            case 'GET /__api/folder': { // list images in a local folder (for "import by naming rule")
              const dir = q.get('path') ?? '';
              if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) throw new Error('文件夹不存在');
              return send(res, 200, { files: readdirSync(dir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)) });
            }
            case 'POST /__api/import': { // copy files from a local folder into songs/<id>/images/
              const { path: dir, items } = JSON.parse((await body(req, 1 << 20)).toString('utf8')) as { path: string; items: { src: string; name: string }[] };
              const dst = path.join(songDir(q), 'images');
              mkdirSync(dst, { recursive: true });
              for (const it of items) {
                if (!FILE_RE.test(it.name) || it.src.includes('..') || /[\/]/.test(it.src)) throw new Error(`bad name: ${it.src}`);
                copyFileSync(path.join(dir, it.src), path.join(dst, it.name));
              }
              return send(res, 200, { paths: items.map((it) => `images/${it.name}`) });
            }
            case 'POST /__api/rename': { // apply the naming rule: [[from, to]] inside images/, two-phase (no clobbering)
              const { pairs } = JSON.parse((await body(req, 1 << 20)).toString('utf8')) as { pairs: [string, string][] };
              const dir = path.join(songDir(q), 'images');
              for (const [a, b] of pairs) if (!FILE_RE.test(a) || !FILE_RE.test(b)) throw new Error(`bad name: ${a} -> ${b}`);
              const tmp = pairs.map(([a], i) => { const t = `.renaming-${i}-${a}`; renameSync(path.join(dir, a), path.join(dir, t)); return t; });
              pairs.forEach(([, b], i) => renameSync(path.join(dir, tmp[i]!), path.join(dir, b)));
              return send(res, 200, { ok: true });
            }
            case 'GET /__api/ai': {
              loadEnv();
              return send(res, 200, { configured: !!process.env.OPENAI_API_KEY, model: process.env.IMAGE_MODEL ?? 'gpt-image-1', base: (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/^(https?:\/\/[^/]+).*/, '$1') });
            }
            case 'POST /__api/generate': {
              loadEnv();
              const key = process.env.OPENAI_API_KEY;
              if (!key) return send(res, 400, { error: '未配置 AI：在项目根目录 .env 里写 OPENAI_API_KEY=...（可选 OPENAI_BASE_URL、IMAGE_MODEL、IMAGE_SIZE）' });
              const { prompt, name } = JSON.parse((await body(req, 1 << 20)).toString('utf8'));
              if (!FILE_RE.test(name)) throw new Error('bad file name');
              const baseUrl = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
              const r = await fetch(`${baseUrl}/images/generations`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: process.env.IMAGE_MODEL ?? 'gpt-image-1', prompt, size: process.env.IMAGE_SIZE ?? '1536x1024', n: 1 }),
              });
              const j: any = await r.json().catch(() => ({}));
              if (!r.ok) return send(res, 502, { error: `生图接口返回 ${r.status}：${j?.error?.message ?? JSON.stringify(j).slice(0, 300)}` });
              const item = j.data?.[0];
              const buf = item?.b64_json ? Buffer.from(item.b64_json, 'base64') : item?.url ? Buffer.from(await (await fetch(item.url)).arrayBuffer()) : null;
              if (!buf) return send(res, 502, { error: '生图接口没有返回图片' });
              const dir = path.join(songDir(q), 'images');
              mkdirSync(dir, { recursive: true });
              writeFileSync(path.join(dir, name), buf);
              return send(res, 200, { path: `images/${name}` });
            }
            case 'POST /__api/render': {
              if (render && !render.done) return send(res, 409, { error: '已有导出在进行' });
              const song = q.get('song')!;
              songDir(q);
              const o = JSON.parse((await body(req, 1 << 16)).toString('utf8') || '{}');
              const d = new Date(), z = (n: number) => String(n).padStart(2, '0');
              const stamp = `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`; // local time
              const out = path.join(ROOT, 'output', 'mv', `${song}_${stamp}.mp4`);
              const args = ['scripts/render-node.ts', 'video', '--song', song, '--url', `http://localhost:${server.config.server.port ?? 5190}`,
                '--fps', String(o.fps ?? 30), '--crf', String(o.crf ?? 20), '--preset', 'medium', '--out', out];
              if (o.cfg && /^mv[\w-]*\.json$/.test(o.cfg)) args.push('--cfg', o.cfg);
              if (o.from != null) args.push('--from', String(o.from));
              if (o.to != null) args.push('--to', String(o.to));
              const proc = spawn(process.execPath, args, { cwd: APP });
              render = { proc, log: '', out, done: false, code: null };
              const onData = (d: Buffer) => { render!.log = (render!.log + d.toString()).slice(-4000); };
              proc.stdout.on('data', onData);
              proc.stderr.on('data', onData);
              proc.on('exit', (code) => { render!.done = true; render!.code = code; });
              return send(res, 200, { out });
            }
            case 'GET /__api/render': {
              if (!render) return send(res, 200, { running: false });
              const m = [...render.log.matchAll(/(\d+)\/(\d+) frames/g)].pop();
              return send(res, 200, { running: !render.done, code: render.code, out: render.out, frames: m ? [+m[1]!, +m[2]!] : null, tail: render.log.slice(-400) });
            }
          }
          next();
        } catch (e) {
          send(res, 400, { error: String((e as Error).message ?? e) });
        }
      });
    },
  };
}

export default defineConfig({
  root: '.',
  publicDir: 'public',
  plugins: [editorApi()],
  // PDOOM_NO_HMR=1: no live reload (export renders must not reload mid-run when a file changes)
  server: { port: 5190, strictPort: false, hmr: process.env.PDOOM_NO_HMR ? false : undefined, watch: { ignored: ['**/songs/**'] } },
  build: { target: 'esnext', assetsInlineLimit: 0, rollupOptions: { input: { main: 'index.html', editor: 'editor.html' } } },
});
