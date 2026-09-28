// 词影 MV 工作台: settings on the left (rail + panel), live preview on the right, dual-lane timeline at the bottom.
// Every change updates the config, re-applies it to the engine (no reload) and saves songs/<id>/mv.json.
// Section images follow the naming rule in ../naming.ts ("{序号}-{段落}-{镜头}.png").
import { PW, PH } from '../engine/gl';
import { bootApp, type App } from '../boot';
import { PACKS, STYLES, type Enter, type Exit, type Layout, type MVConfig, type SectionConfig } from '../config';
import { sectionId } from '../timeline';
import { parseRule, ruleName, sameLabel, sectionLabels } from '../naming';
import type { LineX } from '../textkit';

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const h = (html: string) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild as HTMLElement; };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const fmt = (t: number) => { const m = Math.floor(t / 60); return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`; };
const base = (p: string) => p.split('/').pop()!;

const params = new URLSearchParams(location.search);
const SONG = params.get('song') ?? 'solo';
// which config file of the song (mv.json = L1/L2; e.g. mv-l4.json for the L4 cut)
const CFG = params.get('cfg') ?? 'mv.json';
const canvas = $<HTMLCanvasElement>('#c');
canvas.width = PW;
canvas.height = PH;

let app: App;
let cfg: MVConfig;
let sel: string | null = null;
const audio = new Audio();

interface Sec { id: string; name: string; label: string; start: number; end: number; lines: LineX[] }
let secs: Sec[] = [];

// ------------------------------------------------------------------ config: apply live + save
let applyTimer = 0;
function status(text: string, cls = '') { const e = $('#status'); e.textContent = text; e.className = cls; }
function changed(rebuildUI = false) {
  if (rebuildUI) renderPanes();
  clearTimeout(applyTimer);
  status('应用中…');
  applyTimer = window.setTimeout(async () => {
    await app.apply(structuredClone(cfg));
    if (rebuildUI) renderPanes();
    drawTimeline();
    try {
      const r = await fetch(`/__api/config?song=${SONG}&cfg=${CFG}`, { method: 'POST', body: JSON.stringify(cfg) });
      if (!r.ok) throw new Error((await r.json()).error);
      status('✓ 已保存 ' + new Date().toLocaleTimeString(), 'ok');
    } catch (e) { status('⚠ 保存失败：' + (e as Error).message, 'bad'); }
  }, 250);
}
const secCfg = (id: string): SectionConfig => (cfg.sections[id] ??= {});
const entry = (id: string) => app.engine.timeline.find((e) => e.id === id);
const isChorus = (name: string) => /chorus/i.test(name) && !/pre-?\s*chorus/i.test(name);
// the UI reads the config (the engine rebuild is debounced); same default rule as timeline.ts
const sceneOf = (s: Sec) => cfg.sections[s.id]?.scene ?? (isChorus(s.name) || !app.meta.cover ? 'textpv' : 'cover');
const imgUrl = (p: string) => `${app.base}${encodeURI(p)}?v=${cfg.rev ?? 0}`;

// ------------------------------------------------------------------ naming rule
/** Rename every section image to the rule (global order in time), then save. */
async function normalizeNames() {
  const pairs: [string, string][] = [];
  let g = 0;
  for (const s of secs) {
    const imgs = cfg.sections[s.id]?.images ?? [];
    imgs.forEach((p, i) => {
      g++;
      const ext = (p.split('.').pop() ?? 'png').toLowerCase().replace('jpeg', 'jpg');
      const want = ruleName(g, s.label, i + 1, ext);
      if (base(p) !== want) pairs.push([base(p), want]);
      imgs[i] = `images/${want}`;
    });
  }
  if (!pairs.length) return;
  const r = await fetch(`/__api/rename?song=${SONG}`, { method: 'POST', body: JSON.stringify({ pairs }) });
  if (!r.ok) throw new Error((await r.json()).error);
  cfg.rev = (cfg.rev ?? 0) + 1;
}

/** Match files named by the rule to sections; returns section id -> files sorted by shot. */
function matchByRule(names: string[]) {
  const out = new Map<string, { file: string; k: number; g: number }[]>();
  const bad: string[] = [];
  for (const f of names) {
    const p = parseRule(f);
    const s = p && secs.find((x) => sameLabel(x.label, p.label));
    if (!p || !s) { bad.push(f); continue; }
    if (!out.has(s.id)) out.set(s.id, []);
    out.get(s.id)!.push({ file: f, k: p.k, g: p.g });
  }
  for (const l of out.values()) l.sort((a, b) => a.k - b.k || a.g - b.g);
  return { out, bad };
}

function report(n: number, bad: string[]) {
  status(`✓ 导入 ${n} 张${bad.length ? `；${bad.length} 个文件名不符合规则未导入` : ''}`, bad.length ? 'bad' : 'ok');
  if (bad.length) alert(`以下文件名不符合命名规则「序号-段落-镜头.png」或段落名对不上，未导入：\n\n${bad.join('\n')}\n\n本曲的段落名：${secs.map((s) => s.label).join('、')}`);
}

async function importFiles(files: File[]) {
  const { out, bad } = matchByRule(files.map((f) => f.name));
  let n = 0;
  for (const [id, list] of out) {
    const own = secCfg(id);
    own.images = [];
    for (const it of list) {
      const f = files.find((x) => x.name === it.file)!;
      const tmp = `in-${Date.now() % 1e7}-${n}.${f.name.split('.').pop()!.toLowerCase()}`;
      const r = await fetch(`/__api/upload?song=${SONG}&name=${encodeURIComponent(tmp)}`, { method: 'POST', body: f });
      if (!r.ok) { status('⚠ 上传失败：' + (await r.json()).error, 'bad'); return; }
      own.images.push((await r.json()).path);
      n++;
    }
    own.scene = 'cover';
  }
  await normalizeNames();
  changed(true);
  report(n, bad);
}

async function importFolder(dir: string) {
  const r = await fetch(`/__api/folder?path=${encodeURIComponent(dir)}`);
  const j = await r.json();
  if (!r.ok) { status('⚠ ' + j.error, 'bad'); return; }
  const { out, bad } = matchByRule(j.files);
  const items: { src: string; name: string }[] = [];
  let n = 0;
  for (const [id, list] of out) {
    const own = secCfg(id);
    own.images = [];
    for (const it of list) {
      const name = `in-${Date.now() % 1e7}-${n++}.${parseRule(it.file)!.ext}`;
      items.push({ src: it.file, name });
      own.images.push(`images/${name}`);
    }
    own.scene = 'cover';
  }
  const c = await fetch(`/__api/import?song=${SONG}`, { method: 'POST', body: JSON.stringify({ path: dir, items }) });
  if (!c.ok) { status('⚠ 导入失败：' + (await c.json()).error, 'bad'); return; }
  await normalizeNames();
  changed(true);
  report(items.length, bad);
}

/** The shot list for generating images elsewhere (e.g. with ChatGPT): file name + prompt per shot. */
function shotList() {
  const n = cfg.ai.perSection;
  let g = 0;
  const lines: string[] = [];
  for (const s of secs) {
    if (sceneOf(s) !== 'cover') continue;
    for (let k = 0; k < n; k++) lines.push(`${ruleName(++g, s.label, k + 1)}\n${buildPrompt(s, k, n)}\n`);
  }
  return lines.join('\n');
}
function dialog(title: string, hint: string, text: string) {
  $('#dlgTitle').textContent = title;
  $('#dlgHint').textContent = hint;
  $<HTMLTextAreaElement>('#dlgText').value = text;
  $<HTMLDialogElement>('#dlg').showModal();
}

// ------------------------------------------------------------------ UI bits
function seg<T extends string>(opts: [T, string][], cur: T, on: (v: T) => void) {
  const e = h(`<span class="seg"></span>`);
  for (const [v, label] of opts) { const b = h(`<button class="${v === cur ? 'on' : ''}">${label}</button>`); b.onclick = () => on(v); e.appendChild(b); }
  return e;
}
function row(label: string, ...els: (HTMLElement | string)[]) {
  const r = h(`<div class="row"><label>${label}</label></div>`);
  for (const x of els) r.append(typeof x === 'string' ? h(`<span class="hint">${x}</span>`) : x);
  return r;
}
function toggle(v: boolean, on: (v: boolean) => void) {
  const e = h(`<input type="checkbox" ${v ? 'checked' : ''}/>`) as HTMLInputElement;
  e.onchange = () => on(e.checked);
  return e;
}
function range(v: number, min: number, max: number, step: number, on: (v: number) => void, unit = '') {
  const wrap = h(`<span style="display:flex;align-items:center;gap:8px;flex:1"><input type="range" min="${min}" max="${max}" step="${step}" value="${v}" style="flex:1;accent-color:var(--jade)"/><span class="hint" style="min-width:44px">${v}${unit}</span></span>`);
  const i = wrap.querySelector('input')!, out = wrap.querySelector('.hint')!;
  i.oninput = () => { out.textContent = i.value + unit; };
  i.onchange = () => on(+i.value);
  return wrap;
}
function swatches(colors: string[], cur: string, on: (c: string) => void) {
  const e = h(`<span style="display:flex;gap:8px"></span>`);
  for (const c of colors) { const b = h(`<button class="swatch ${c === cur ? 'on' : ''}" style="background:${c}"></button>`); b.onclick = () => on(c); e.appendChild(b); }
  return e;
}
function chips<T extends string>(all: [T, string][], cur: T[], on: (v: T[]) => void) {
  const e = h(`<span style="display:flex;gap:6px;flex-wrap:wrap"></span>`);
  for (const [v, label] of all) {
    const b = h(`<button class="chip ${cur.includes(v) ? 'on' : ''}">${label}</button>`);
    b.onclick = () => { const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]; if (next.length) on(next); };
    e.appendChild(b);
  }
  return e;
}

// ------------------------------------------------------------------ panes
const LAYOUTS: [Layout, string][] = [['center', '居中'], ['giant', '巨字'], ['vertical', '竖排'], ['scatter', '错落'], ['split', '对开'], ['marquee', '横移']];
const ENTERS: [Enter, string][] = [['pop', '弹入'], ['slice', '切入'], ['blur', '雾化'], ['glitch', '闪断'], ['rise', '浮起'], ['type', '直现']];
const EXITS: [Exit, string][] = [['drift', '飘走'], ['shrink', '收拢'], ['blur', '雾散'], ['scatter', '四散'], ['glitch', '闪断']];

function renderPanes() { paneStory(); paneSub(); panePV(); paneInfo(); }
let aiInfo: { configured: boolean; model: string; base: string } = { configured: false, model: '', base: '' };

function paneStory() {
  const P = $('#pane-story'), top = $('#panel').scrollTop;
  P.innerHTML = '<h2>段落画面</h2>';
  const ai = cfg.ai;
  // naming rule + import
  const g0 = h(`<div class="group"><h3>图片命名规则</h3>
    <div class="note">自己准备或请 GPT 等工具生成图片时，请按 <code>序号-段落-镜头.png</code> 命名，例如 <code>${esc(ruleName(4, secs[2]?.label ?? 'Pre-Chorus 1', 1))}</code>。
    <br/>· 序号：全曲第几张（按时间顺序）　· 段落：下列段落名之一　· 镜头：该段第几张
    <br/>本曲段落名：${secs.map((s) => `<code>${esc(s.label)}</code>`).join(' ')}
    <br/>建议 1920×1080。导入后程序会按规则统一重命名；AI 生成的图片也按此规则命名。</div></div>`);
  const pick = h(`<input type="file" accept="image/png,image/jpeg,image/webp" multiple hidden/>`) as HTMLInputElement;
  pick.onchange = () => importFiles([...(pick.files ?? [])]);
  const pickB = h(`<button class="primary">按规则导入图片…</button>`);
  pickB.onclick = () => pick.click();
  const dir = h(`<input placeholder="或填本机文件夹路径，如 D:\\...\\image" style="flex:1"/>`) as HTMLInputElement;
  const dirB = h(`<button>导入文件夹</button>`);
  dirB.onclick = () => dir.value.trim() && importFolder(dir.value.trim());
  const listB = h(`<button class="gold">导出生图清单</button>`);
  listB.onclick = () => dialog('外部生图清单', `每张图的文件名和提示词（每段 ${ai.perSection} 张，可在下方「AI 生成」里改张数），可以整段交给 ChatGPT 等工具，生成后按文件名导入。`, shotList());
  g0.append(row('', pickB, listB, pick), row('', dir, dirB));
  P.append(g0);

  // AI
  const g = h(`<div class="group"><h3>AI 生成 <span class="hint">${aiInfo.configured ? `已连接 · ${esc(aiInfo.model)} · ${esc(aiInfo.base)}` : '未连接：在项目根目录 .env 写 OPENAI_API_KEY（见 .env.example），或用上面的导入'}</span></h3></div>`);
  const style = h(`<select></select>`) as HTMLSelectElement;
  for (const [k, s] of Object.entries(STYLES)) style.append(new Option(s.name, k, false, k === ai.style));
  style.onchange = () => { ai.style = style.value; changed(); };
  const prot = h(`<textarea placeholder="主角设定（每张图都会带上，保持人物一致），例如：穿墨绿色 POLO 衫、系绿头巾、长髯的关羽，提青龙偃月刀">${esc(ai.protagonist)}</textarea>`) as HTMLTextAreaElement;
  prot.onchange = () => { ai.protagonist = prot.value; changed(); };
  const extra = h(`<input placeholder="附加提示词（可选）" value="${esc(ai.extra)}" style="flex:1"/>`) as HTMLInputElement;
  extra.onchange = () => { ai.extra = extra.value; changed(); };
  const genAll = h(`<button class="primary" ${aiInfo.configured ? '' : 'disabled'}>全部生成</button>`);
  genAll.onclick = async () => { for (const s of secs) if (sceneOf(s) === 'cover') await generate(s); };
  g.append(row('画面风格', style), prot, row('附加', extra), row('每段张数', range(ai.perSection, 1, 4, 1, (v) => { ai.perSection = v; changed(); }), genAll));
  P.append(g);

  // sections
  const gs = h(`<div class="group"><h3>各段落</h3></div>`);
  let g1 = 0;
  for (const s of secs) {
    const kind = sceneOf(s), own = secCfg(s.id);
    const box = h(`<div class="sec ${s.id === sel ? 'sel' : ''}" id="sec-${s.id}"><div class="hd"><span class="name">${esc(s.label)}</span><span class="t">${fmt(s.start)}–${fmt(s.end)}</span></div><div class="ly">${esc(s.lines.map((l) => l.text).join(' / ') || '（器乐段，无歌词）')}</div></div>`);
    const l4 = kind !== 'cover' && kind !== 'textpv';
    box.querySelector('.hd')!.append(l4 ? h(`<span class="hint">L4 场景：${esc(kind)}</span>`)
      : seg<'cover' | 'textpv'>([['cover', '画面'], ['textpv', '文字PV']], kind as 'cover' | 'textpv', (v) => { own.scene = v; changed(true); }));
    box.querySelector('.name')!.addEventListener('click', () => { sel = s.id; seek(s.start); paneStory(); });
    if (l4) {
      // L4 scene: edited in its config file (mv-l4.json)
    } else if (kind === 'cover') {
      const th = h(`<div class="thumbs"></div>`);
      const imgs = own.images ?? [];
      if (!imgs.length && app.meta.cover) th.append(h(`<div class="thumb" style="background-image:url('${imgUrl(app.meta.cover)}')"><span class="tag">默认封面</span></div>`));
      imgs.forEach((p, i) => {
        g1++;
        const t = h(`<div class="thumb" style="background-image:url('${imgUrl(p)}')" title="${esc(base(p))}"><span class="tag">${esc(base(p))}</span><button class="x">×</button></div>`);
        t.querySelector('.x')!.addEventListener('click', async () => { own.images = imgs.filter((_, j) => j !== i); await normalizeNames(); changed(true); });
        th.append(t);
      });
      const up = h(`<input type="file" accept="image/png,image/jpeg,image/webp" multiple hidden/>`) as HTMLInputElement;
      const upB = h(`<button>添加图片</button>`);
      upB.onclick = () => up.click();
      up.onchange = () => upload(s, [...(up.files ?? [])]);
      const genB = h(`<button ${aiInfo.configured ? '' : 'disabled'}>AI 生成 ${ai.perSection} 张</button>`);
      genB.onclick = () => generate(s);
      const pr = h(`<details><summary class="hint">提示词（留空则按歌词自动生成）</summary><textarea placeholder="${esc(buildPrompt(s, 0, 1))}">${esc(own.prompt ?? '')}</textarea></details>`);
      pr.querySelector('textarea')!.addEventListener('change', (e) => { own.prompt = (e.target as HTMLTextAreaElement).value || undefined; changed(); });
      box.append(th, row('', upB, genB, up), pr);
    } else {
      const packSel = h(`<select></select>`) as HTMLSelectElement;
      const cur = (entry(s.id)?.params?.pack as string) ?? cfg.textpv.pack;
      for (const [k, p] of Object.entries(PACKS)) packSel.append(new Option(p.name, k, false, k === cur));
      packSel.onchange = () => { own.pack = packSel.value; changed(true); };
      box.append(row('风格包', packSel));
    }
    gs.append(box);
  }
  void g1;
  P.append(gs);
  $('#panel').scrollTop = top;
}

function paneSub() {
  const P = $('#pane-sub'), k = cfg.karaoke;
  P.innerHTML = '<h2>字幕</h2>';
  const g1 = h(`<div class="group"><h3>基本</h3></div>`);
  g1.append(
    row('启用', toggle(k.enabled, (v) => { k.enabled = v; changed(); }), '作用于「画面」段落；文字 PV 段落自带歌词'),
    row('字体', seg([['sans', '黑体'], ['song', '宋体'], ['brush', '毛笔楷']], k.font, (v) => { k.font = v; changed(true); })),
    row('字号', range(k.size, 36, 110, 2, (v) => { k.size = v; changed(); }, 'px')),
    row('每屏', seg([['1', '1 行'], ['2', '2 行']], String(k.lines) as '1' | '2', (v) => { k.lines = +v as 1 | 2; changed(true); })),
  );
  const g2 = h(`<div class="group"><h3>逐字演唱</h3></div>`);
  g2.append(
    row('未唱的字', seg([['dim', '淡显'], ['appear', '唱到才现']], k.reveal, (v) => { k.reveal = v; changed(true); })),
    row('跳字动效', toggle(k.pop, (v) => { k.pop = v; changed(); })),
    row('正在唱', swatches(['#3fa9ff', '#2fbf8a', '#dfb055', '#ff5a4a', '#b08cff', '#ffffff'], k.colors.active, (c) => { k.colors.active = c; changed(true); })),
    row('已唱', swatches(['#ffffff', '#efe6cf', '#dfb055', '#bfe8d6'], k.colors.sung, (c) => { k.colors.sung = c; changed(true); })),
    row('提前显示', range(k.lead, 0, 1.5, 0.1, (v) => { k.lead = v; changed(); }, 's')),
  );
  const g3 = h(`<div class="group"><h3>韵脚</h3></div>`);
  g3.append(
    row('韵脚点亮', toggle(k.rhymeHighlight, (v) => { k.rhymeHighlight = v; changed(); }), '行尾押韵的字唱完后变色'),
    row('韵脚色', swatches(['#dfb055', '#ff5a4a', '#2fbf8a', '#35c8ff', '#b08cff', '#ffffff'], k.colors.rhyme, (c) => { k.colors.rhyme = c; changed(true); })),
  );
  const g4 = h(`<div class="group"><h3>位置</h3></div>`);
  g4.append(
    row('位置', seg([['top', '上'], ['center', '中'], ['bottom', '下']], k.position, (v) => { k.position = v; changed(true); })),
    row('对齐', seg([['left', '左'], ['center', '中']], k.align, (v) => { k.align = v; changed(true); })),
    row('上下微调', range(k.offsetY, -200, 200, 5, (v) => { k.offsetY = v; changed(); }, 'px')),
  );
  P.append(g1, g2, g3, g4);
}

function panePV() {
  const P = $('#pane-pv'), t = cfg.textpv;
  P.innerHTML = '<h2>文字 PV</h2>';
  const g1 = h(`<div class="group"><h3>风格包 <span class="hint">未单独指定的文字 PV 段落按 墨绿 → Noir → Caution → Paper 轮换</span></h3><div class="packs"></div></div>`);
  for (const [key, p] of Object.entries(PACKS)) {
    const b = h(`<div class="pack ${key === t.pack ? 'on' : ''}" style="background:${p.bg};color:${p.fg}"><span>词<span style="color:${p.accent}">影</span></span><small>${esc(p.name)}</small></div>`);
    b.onclick = () => { t.pack = key; for (const s of Object.values(cfg.sections)) delete s.pack; changed(true); };
    g1.querySelector('.packs')!.append(b);
  }
  const g2 = h(`<div class="group"><h3>版式 <span class="hint">相邻两句不重复</span></h3></div>`);
  g2.append(chips(LAYOUTS, t.layouts, (v) => { t.layouts = v; changed(true); }));
  const g3 = h(`<div class="group"><h3>入场 / 离场</h3></div>`);
  g3.append(row('入场', chips(ENTERS, t.enters, (v) => { t.enters = v; changed(true); })), row('离场', chips(EXITS, t.exits, (v) => { t.exits = v; changed(true); })));
  const g4 = h(`<div class="group"><h3>质感</h3></div>`);
  g4.append(row('动效强度', range(t.intensity, 0, 2, 0.1, (v) => { t.intensity = v; changed(); })), row('歌词底纹', range(t.bgTexture, 0, 1, 0.05, (v) => { t.bgTexture = v; changed(); })));
  P.append(g1, g2, g3, g4);
}

function paneInfo() {
  const P = $('#pane-info');
  P.innerHTML = '<h2>标题信息</h2>';
  const tt = (cfg.title ??= { main: '' });
  const g = h(`<div class="group"><h3>开场标题卡 <span class="hint">第一句开唱前显示</span></h3></div>`);
  const inp = (v: string | undefined, ph: string, on: (v: string) => void) => { const i = h(`<input value="${esc(v ?? '')}" placeholder="${ph}" style="flex:1"/>`) as HTMLInputElement; i.onchange = () => on(i.value); return i; };
  g.append(
    row('主标题', inp(tt.main, 'SOLO', (v) => { tt.main = v; changed(); })),
    row('上方中文', inp(tt.sub, '千里走单骑', (v) => { tt.sub = v || undefined; changed(); })),
    row('下方小字', inp(tt.small, 'GUAN YUNCHANG', (v) => { tt.small = v || undefined; changed(); })),
    row('显示到', range(tt.until ?? 6.2, 2, 20, 0.1, (v) => { tt.until = v; changed(); }, 's')),
  );
  const g2 = h(`<div class="group"><h3>歌曲</h3><div class="hint">${esc(app.meta.title ?? '')}<br/><br/>${esc(app.meta.tags ?? '')}</div></div>`);
  P.append(g, g2);
}

// ------------------------------------------------------------------ images: upload / generate
function buildPrompt(s: Sec, k: number, n: number) {
  const own = secCfg(s.id);
  if (own.prompt) return n > 1 ? `${own.prompt} (shot ${k + 1} of ${n}, different camera angle)` : own.prompt;
  const per = Math.ceil(s.lines.length / n);
  const lines = s.lines.slice(k * per, (k + 1) * per).map((l) => l.text).join(' / ');
  return [
    STYLES[cfg.ai.style]?.prompt ?? '',
    `A shot for a music video, the "${s.label}" section of the song "${app.meta.title ?? ''}".`,
    app.meta.tags ? `Music mood: ${app.meta.tags.slice(0, 220)}.` : '',
    lines ? `Visualize these Chinese lyrics (imagery, not text): ${lines}.` : 'Instrumental passage: atmospheric establishing shot.',
    cfg.ai.protagonist ? `Main character: ${cfg.ai.protagonist}.` : '',
    cfg.ai.extra,
    '1920x1080, wide 16:9 cinematic composition, keep the lower third calm for subtitles. No text, no letters, no captions, no watermark.',
  ].filter(Boolean).join(' ');
}

async function upload(s: Sec, files: File[]) {
  const own = secCfg(s.id);
  for (const f of files) {
    const name = `in-${Date.now() % 1e7}.${(f.name.split('.').pop() ?? 'png').toLowerCase()}`;
    status(`上传 ${f.name}…`);
    const r = await fetch(`/__api/upload?song=${SONG}&name=${encodeURIComponent(name)}`, { method: 'POST', body: f });
    const j = await r.json();
    if (!r.ok) { status('⚠ 上传失败：' + j.error, 'bad'); return; }
    own.images = [...(own.images ?? []), j.path];
  }
  own.scene = 'cover';
  await normalizeNames(); // uploaded files are renamed to the rule
  changed(true);
}

async function generate(s: Sec) {
  const own = secCfg(s.id), n = cfg.ai.perSection;
  const box = document.getElementById(`sec-${s.id}`);
  box?.classList.add('busy');
  try {
    for (let k = 0; k < n; k++) {
      status(`AI 生成 ${s.label} 第 ${k + 1}/${n} 张…（约 20–60 秒）`);
      const r = await fetch(`/__api/generate?song=${SONG}`, { method: 'POST', body: JSON.stringify({ prompt: buildPrompt(s, k, n), name: `in-${Date.now() % 1e7}.png` }) });
      const j = await r.json();
      if (!r.ok) { status('⚠ ' + j.error, 'bad'); return; }
      own.images = [...(own.images ?? []), j.path];
    }
    own.scene = 'cover';
    await normalizeNames(); // generated files get rule names too
    changed(true);
  } finally { box?.classList.remove('busy'); }
}

// ------------------------------------------------------------------ timeline: picture lane + lyric lane + waveform
const tlc = $<HTMLCanvasElement>('#tlc');
const thumbs = new Map<string, HTMLImageElement>();
function thumb(src: string) {
  let i = thumbs.get(src);
  if (!i) { i = new Image(); i.src = src; i.onload = () => drawTimeline(); thumbs.set(src, i); }
  return i;
}
function drawTimeline() {
  const r = devicePixelRatio, W = (tlc.width = tlc.clientWidth * r), H = (tlc.height = tlc.clientHeight * r);
  const c = tlc.getContext('2d')!, D = app.engine.duration, L = 56 * r, X = (t: number) => L + (t / D) * (W - L);
  c.fillStyle = '#0a0d0b'; c.fillRect(0, 0, W, H);
  const laneY = { ruler: 4 * r, pic: 22 * r, pich: 72 * r, ly: 100 * r, lyh: 18 * r, wave: 146 * r };
  c.font = `${11 * r}px "Microsoft YaHei"`; c.fillStyle = '#8b978d';
  c.fillText('段落', 8 * r, laneY.ruler + 11 * r); c.fillText('画面', 8 * r, laneY.pic + 40 * r); c.fillText('歌词', 8 * r, laneY.ly + 13 * r); c.fillText('波形', 8 * r, laneY.wave + 4 * r);
  for (const s of secs) {
    const e = entry(s.id); if (!e) continue;
    const x0 = X(s.start), x1 = X(s.end);
    // ruler: section label
    c.fillStyle = s.id === sel ? '#dfb055' : '#1f2a22'; c.fillRect(x0, laneY.ruler, x1 - x0 - r, 14 * r);
    c.fillStyle = s.id === sel ? '#0a0d0b' : '#c9d2c9'; c.font = `bold ${10 * r}px sans-serif`;
    c.save(); c.beginPath(); c.rect(x0, laneY.ruler, x1 - x0 - 2 * r, 14 * r); c.clip(); c.fillText(s.label, x0 + 4 * r, laneY.ruler + 11 * r); c.restore();
    // picture lane: one tile per shot
    if (e.params?.karaoke) {
      const imgs: string[] = e.params.images ?? [], cuts: number[] = e.params.cuts ?? [s.start];
      imgs.forEach((p, i) => {
        const a = X(cuts[i] ?? s.start), b = X(cuts[i + 1] ?? s.end), w = b - a - 2 * r;
        c.fillStyle = '#16211b'; c.fillRect(a, laneY.pic, w, laneY.pich);
        const im = thumb(`${app.base}${encodeURI(p)}?v=${e.params!.rev ?? 0}`);
        if (im.complete && im.naturalWidth) { c.save(); c.beginPath(); c.rect(a, laneY.pic, w, laneY.pich); c.clip(); const sc = Math.max(w / im.width, laneY.pich / im.height); c.drawImage(im, a + (w - im.width * sc) / 2, laneY.pic + (laneY.pich - im.height * sc) / 2, im.width * sc, im.height * sc); c.restore(); }
      });
    } else {
      const pk = PACKS[e.params?.pack as string] ?? PACKS.jade!;
      c.fillStyle = pk.bg; c.fillRect(x0, laneY.pic, x1 - x0 - 2 * r, laneY.pich);
      c.fillStyle = pk.accent; c.font = `bold ${14 * r}px "Microsoft YaHei"`; c.fillText('文字 PV', x0 + 6 * r, laneY.pic + 40 * r);
    }
    if (s.id === sel) { c.strokeStyle = '#dfb055'; c.lineWidth = 2 * r; c.strokeRect(x0 + r, laneY.pic + r, x1 - x0 - 4 * r, laneY.pich - 2 * r); }
    // lyric lane
    for (const l of s.lines) { c.fillStyle = '#2fbf8a55'; c.fillRect(X(l.start), laneY.ly, Math.max(2 * r, X(l.end) - X(l.start) - r), laneY.lyh); }
  }
  c.fillStyle = '#2fbf8a88';
  for (let x = L; x < W; x += 2 * r) { const v = app.engine.audio.env('rms', ((x - L) / (W - L)) * D) * 14 * r; c.fillRect(x, laneY.wave - v, 1.2 * r, v * 2); }
  c.fillStyle = '#dfb055'; c.fillRect(X(audio.currentTime), 0, 2 * r, H);
}
tlc.onclick = (e) => {
  const L = 56, w = tlc.clientWidth - L;
  if (e.offsetX < L) return;
  const t = ((e.offsetX - L) / w) * app.engine.duration;
  seek(t);
  const s = secs.find((x) => t >= x.start && t < x.end);
  if (s) { sel = s.id; tab('story'); paneStory(); document.getElementById(`sec-${s.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
};

// ------------------------------------------------------------------ player
function seek(t: number) { audio.currentTime = Math.max(0, Math.min(app.engine.duration - 0.01, t)); }
function tab(name: string) {
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.tab === name));
  document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('on', p.id === `pane-${name}`));
}
document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => tab((b as HTMLElement).dataset.tab!)));

let lastAudioT = 0, lastPerf = 0, tlFrame = 0;
function tick() {
  const now = performance.now();
  if (audio.currentTime !== lastAudioT) { lastAudioT = audio.currentTime; lastPerf = now; }
  let t = lastAudioT + (audio.paused ? 0 : ((now - lastPerf) / 1000) * audio.playbackRate);
  if ($<HTMLInputElement>('#loop').checked && !audio.paused) {
    const s = secs.find((x) => x.id === sel) ?? secs.find((x) => lastAudioT >= x.start && lastAudioT < x.end);
    if (s && t >= s.end) { seek(s.start); t = s.start; }
  }
  app.engine.render(t, 1 / 60);
  $<HTMLInputElement>('#scrub').value = String(t);
  $('#time').textContent = `${fmt(t)} / ${fmt(app.engine.duration)}`;
  if (++tlFrame % 6 === 0) drawTimeline();
  requestAnimationFrame(tick);
}

// ------------------------------------------------------------------ export
async function exportVideo() {
  const r = await fetch(`/__api/render?song=${SONG}`, { method: 'POST', body: JSON.stringify({ fps: 30, crf: 20, cfg: CFG }) });
  const j = await r.json();
  if (!r.ok) { $('#exportBox').textContent = '⚠ ' + j.error; return; }
  $<HTMLButtonElement>('#exportBtn').disabled = true;
  const poll = async () => {
    const s = await (await fetch('/__api/render')).json();
    const box = $('#exportBox');
    if (s.running) { box.textContent = s.frames ? `导出中 ${Math.round((100 * s.frames[0]) / s.frames[1])}%` : '导出启动中…'; setTimeout(poll, 2000); return; }
    $<HTMLButtonElement>('#exportBtn').disabled = false;
    box.textContent = s.code === 0 ? `✓ 已导出：${base(s.out.replace(/\\/g, '/'))}` : `⚠ 导出失败（${s.code}）`;
    box.title = s.code === 0 ? s.out : s.tail;
  };
  poll();
}

// ------------------------------------------------------------------ boot
async function boot() {
  app = await bootApp(canvas, SONG, null, CFG);
  cfg = structuredClone(app.cfg);
  document.title = `${app.meta.title ?? SONG} · 词影`;
  $('#title').textContent = `${app.meta.title ?? SONG}  ·  ${app.meta.artist ?? ''}`;
  const S = app.engine.audio.sections;
  const labels = sectionLabels(S.map((s) => s.name));
  secs = S.map((s, i) => ({
    id: sectionId(i, s.name), name: s.name, label: labels[i]!, start: s.start, end: s.end,
    lines: (app.engine.lyrics.lines as LineX[]).filter((l) => l.start >= s.start - 0.3 && l.start < s.end),
  }));
  audio.src = `${app.base}${app.meta.audio}`;
  audio.preload = 'auto';
  const scrub = $<HTMLInputElement>('#scrub');
  scrub.max = String(app.engine.duration);
  scrub.oninput = () => seek(+scrub.value);
  const play = $<HTMLButtonElement>('#play');
  const toggleP = () => { if (audio.paused) audio.play(); else audio.pause(); };
  play.onclick = toggleP;
  canvas.onclick = toggleP;
  audio.onplay = () => (play.textContent = '⏸ 暂停');
  audio.onpause = () => (play.textContent = '▶ 播放');
  $<HTMLSelectElement>('#rate').onchange = (e) => (audio.playbackRate = +(e.target as HTMLSelectElement).value);
  window.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).matches('input, textarea, select') || $<HTMLDialogElement>('#dlg').open) return;
    if (e.code === 'Space') { e.preventDefault(); toggleP(); }
    if (e.key === 'ArrowRight') seek(audio.currentTime + (e.shiftKey ? 5 : 1));
    if (e.key === 'ArrowLeft') seek(audio.currentTime - (e.shiftKey ? 5 : 1));
  });
  $('#exportBtn').onclick = exportVideo;
  $('#dlgClose').onclick = () => $<HTMLDialogElement>('#dlg').close();
  $('#dlgCopy').onclick = async () => { await navigator.clipboard.writeText($<HTMLTextAreaElement>('#dlgText').value); status('✓ 已复制', 'ok'); };
  const songs: { id: string; title: string }[] = await (await fetch('/__api/songs')).json();
  const sSel = $<HTMLSelectElement>('#song');
  for (const s of songs) sSel.append(new Option(s.title ?? s.id, s.id, false, s.id === SONG));
  sSel.onchange = () => (location.search = `?song=${sSel.value}${CFG !== 'mv.json' ? `&cfg=${CFG}` : ''}`);
  aiInfo = await (await fetch('/__api/ai')).json();
  if (params.get('t')) seek(+params.get('t')!);
  renderPanes();
  drawTimeline();
  status('就绪');
  requestAnimationFrame(tick);
}
boot().catch((e) => { console.error(e); status('⚠ 启动失败：' + (e?.message ?? e), 'bad'); });
