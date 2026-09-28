// 在 suno.com 的歌曲页（已登录）打开 F12 → Console，粘贴本段回车。
// 用你当前的登录会话取逐词时间戳，下载为 aligned_<id>.json。不读取、不发送 cookie 到任何第三方。
// 若 Chrome 提示禁止粘贴，先在控制台输入 allow pasting 回车。
(async () => {
  const id = (location.pathname.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/) || [])[0];
  if (!id) return alert('请在 suno.com/song/<id> 歌曲页运行');
  let token = null;
  try { token = await window.Clerk?.session?.getToken(); } catch (e) {}
  if (!token) token = (document.cookie.match(/(?:^|;\s*)__session=([^;]+)/) || [])[1];
  if (!token) return alert('没拿到登录 token：确认已登录 suno.com');
  const api = 'https://studio-api.prod.suno.com/api';
  const get = async (p) => {
    const r = await fetch(api + p, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`${p} → HTTP ${r.status}`);
    return r.json();
  };
  const [aligned, clip] = await Promise.all([get(`/gen/${id}/aligned_lyrics/v2/`), get(`/clip/${id}`)]);
  const blob = new Blob([JSON.stringify({ id, clip, aligned }, null, 1)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `aligned_${id}.json` });
  a.click();
  const n = (aligned.aligned_words || aligned.aligned_lyrics || []).length;
  console.log(`✅ 已下载 aligned_${id}.json（${n} 个词）`);
})().catch((e) => alert('失败：' + e.message));
