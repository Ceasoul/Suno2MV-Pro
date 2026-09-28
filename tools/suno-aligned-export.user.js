// ==UserScript==
// @name         Suno 逐词歌词导出（SunoLyricSync）
// @namespace    https://github.com/SunoLyricSync
// @version      0.3.0
// @description  在 suno.com 歌曲页导出逐词时间戳 JSON（右上角按钮 / Tampermonkey 菜单 / Alt+Shift+L），供 suno_karaoke.py --aligned 使用
// @match        https://suno.com/*
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

// 只用你当前页面的登录会话请求 Suno 自己的 studio-api，不经过任何第三方。

(function () {
  'use strict';

  const TAG = '[SunoLyricSync]';
  const API = 'https://studio-api.prod.suno.com/api';
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
  const LABEL = '⬇ 导出逐词歌词';
  const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  const songId = () => (location.pathname.startsWith('/song/') && location.pathname.match(UUID)?.[0]) || null;

  async function getToken() {
    try {
      const t = await pageWin.Clerk?.session?.getToken();
      if (t) return t;
    } catch (e) {
      console.warn(TAG, 'Clerk.getToken 失败，改读 __session cookie', e);
    }
    return document.cookie.match(/(?:^|;\s*)__session=([^;]+)/)?.[1] || null;
  }

  async function exportAligned(setLabel) {
    const id = songId();
    if (!id) throw new Error('请在 suno.com/song/<id> 歌曲页使用');
    const token = await getToken();
    if (!token) throw new Error('没拿到登录 token，请确认已登录 suno.com');
    const get = async (p) => {
      const r = await fetch(API + p, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(`${p} → HTTP ${r.status}`);
      return r.json();
    };
    setLabel('导出中…');
    const clip = await get(`/clip/${id}`);
    // 首次请求时 Suno 可能在后台现算，数组先为空：退避重试约 40 秒
    const delays = [0, 2, 3, 4, 5, 6, 8, 10];
    let aligned, n = 0;
    for (let i = 0; i < delays.length; i++) {
      if (delays[i]) {
        setLabel(`等待 Suno 计算对齐… ${i}/${delays.length - 1}`);
        await new Promise((r) => setTimeout(r, delays[i] * 1000));
      }
      aligned = await get(`/gen/${id}/aligned_lyrics/v2/`);
      n = wordsOf(aligned).length;
      if (n) break;
    }
    if (!n) {
      // 仍为空：把原始返回存下来用于排查，而不是只报错
      download({ id, clip, aligned }, `aligned_${id}_raw.json`);
      console.warn(TAG, 'aligned_lyrics 原始返回：', aligned);
      throw new Error(`Suno 返回了空的逐词数据，原始返回已下载为 aligned_${id}_raw.json\n字段摘要：${summarize(aligned)}`);
    }
    download({ id, clip, aligned }, `aligned_${id}.json`);
    console.info(TAG, `已导出 aligned_${id}.json，${n} 个词`);
    return n;
  }

  const wordsOf = (a) => a?.aligned_words || a?.aligned_lyrics || [];

  function summarize(o) {
    if (!o || typeof o !== 'object') return String(o);
    return Object.entries(o)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? `数组(${v.length})` : typeof v === 'object' && v ? '对象' : JSON.stringify(v)}`)
      .join('；')
      .slice(0, 400);
  }

  function download(obj, name) {
    const blob = new Blob([JSON.stringify(obj, null, 1)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  // ---- 界面：挂在 <html> 下的 Shadow DOM 里，页面重渲染 <body> 时不会被清掉 ----
  const host = document.createElement('div');
  host.id = 'sunolyricsync-host';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    button { position: fixed; top: 16px; right: 24px; z-index: 2147483647; display: none;
      padding: 10px 14px; border: none; border-radius: 10px; cursor: pointer;
      background: #ec4899; color: #fff; font: 600 14px/1 system-ui, sans-serif;
      box-shadow: 0 4px 14px rgba(0,0,0,.35); }
    button:disabled { opacity: .8; cursor: progress; }
  </style><button type="button"></button>`;
  const btn = root.querySelector('button');
  btn.textContent = LABEL;

  let busy = false;
  async function run() {
    if (busy) return;
    busy = true;
    btn.disabled = true;
    const setLabel = (s) => (btn.textContent = s);
    try {
      setLabel(`✅ 已导出 ${await exportAligned(setLabel)} 词`);
    } catch (e) {
      setLabel('❌ 导出失败');
      console.error(TAG, e);
      alert('导出失败：' + e.message);
    } finally {
      setTimeout(() => { setLabel(LABEL); btn.disabled = false; busy = false; }, 2500);
    }
  }

  btn.addEventListener('click', run);
  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.shiftKey && e.code === 'KeyL') { e.preventDefault(); run(); }
  });
  if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand(LABEL, run);

  // 看门狗：被移除就挂回去；suno.com 是单页应用，按当前路径决定按钮显隐
  function tick() {
    if (!host.isConnected) document.documentElement.appendChild(host);
    btn.style.display = songId() ? 'block' : 'none';
  }
  tick();
  setInterval(tick, 800);
  console.info(TAG, '已加载', songId() ? `当前歌曲 ${songId()}` : '（非歌曲页，按钮隐藏）');
})();
