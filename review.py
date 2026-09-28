"""对齐核对页：音轨波形 + 歌词时间轴，在浏览器里边听边核对、打锚点，不渲染视频。

用法:
    python review.py --aligned aligned_<id>_midi.json --audio song.wav [--wave vocals.wav] [--ref review_<id>_mms.json]

会在本机起一个小服务器并打开浏览器（Ctrl+C 结束）。页面里:
    空格 播放/暂停    ←/→ 后退/前进一个步长（Shift 为 1/4 步长）    ↑/↓ 上一行/下一行
    [ / ]  减速/加速（0.10×–2.00×）
    A    把"目标行"的开头设为当前时刻，目标自动移到下一行（目标行显示在歌词上方）
    X    目标行"未唱"（歌词里有、实际没唱），目标自动移到下一行；再按一次取消
    M    在当前时刻标记一个问题    U 撤销上一个操作
    Del  播放头在第 N 行与第 N+1 行锚点之间时，删除第 N+1 行锚点并把目标切回该行（标错后回退重标）
锚点和问题**自动保存**到 bundle 同目录的 review_<id>.json，关掉页面即可；交给 align_local.py --anchors 重新对齐。
"""
import argparse
import functools
import http.server
import json
import os
import re
import sys
import threading
import webbrowser
from pathlib import Path

import numpy as np
import soundfile as sf

from suno_karaoke import TAG_RE, build_lines, safe_name

ROOT = Path(__file__).resolve().parent
PEAKS_PER_SEC = 50
SAVE_RE = re.compile(r"^[\w\-/ ·.]*review_[0-9a-f\-]{36}\.json$")


def section_labels(lyrics, n_lines):
    """按原歌词给每行找所属段落名（[Verse 1: …] 取冒号前）；行数对不上就不标。"""
    labels, pending = [], None
    for raw in (lyrics or "").splitlines():
        s = raw.strip()
        if TAG_RE.fullmatch(s):
            name = s[1:-1].split(":")[0].strip()
            if name.lower() not in ("male", "female", "duet", "end"):
                pending = name
            continue
        if TAG_RE.sub("", s).strip():
            labels.append(pending)
            pending = None
    return labels if len(labels) == n_lines else [None] * n_lines


def peaks(path):
    data, sr = sf.read(str(path), always_2d=True)
    mono = np.abs(data).max(axis=1)
    hop = sr // PEAKS_PER_SEC
    n = len(mono) // hop
    p = mono[:n * hop].reshape(n, hop).max(axis=1)
    p = np.sqrt(p / (p.max() or 1))  # 开方让弱音也看得见
    return [int(v * 100) for v in p], len(data) / sr


class RangeHandler(http.server.SimpleHTTPRequestHandler):
    """静态文件 + HTTP Range（<audio> 靠它跳转进度，标准库不支持）+ 保存核对结果的 POST。"""

    def log_message(self, *a):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")  # 核对页和保存文件都会变，别缓存
        super().end_headers()

    def do_POST(self):
        """POST /__save__  body={"path": 项目内相对路径, "data": {...}}；只允许写 review_<uuid>.json。"""
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            rel = body["path"]
            dest = (ROOT / rel).resolve()
            if self.path != "/__save__" or not SAVE_RE.match(rel) or ".." in rel or ROOT not in dest.parents:
                raise ValueError("非法保存路径")
            dest.write_text(json.dumps(body["data"], ensure_ascii=False, indent=2), encoding="utf-8")
            self.send_response(204)
            self.end_headers()
        except Exception as e:
            self.send_error(400, str(e))

    def send_head(self):
        rng = self.headers.get("Range")
        path = Path(self.translate_path(self.path))
        if not rng or not path.is_file():
            return super().send_head()
        size = path.stat().st_size
        a, _, b = rng.replace("bytes=", "").partition("-")
        start = int(a) if a else max(0, size - int(b))
        end = int(b) if a and b else size - 1
        if start >= size:
            self.send_error(416)
            return None
        f = open(path, "rb")
        f.seek(start)
        self._left = end - start + 1
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(str(path)))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(self._left))
        self.end_headers()
        return f

    def copyfile(self, source, outputfile):
        left = getattr(self, "_left", None)
        if left is None:
            return super().copyfile(source, outputfile)
        while left > 0:
            chunk = source.read(min(1 << 16, left))
            if not chunk:
                break
            outputfile.write(chunk)
            left -= len(chunk)


def serve(port, url=None):
    handler = functools.partial(RangeHandler, directory=str(ROOT))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    if url:
        print(f"打开: {url}\nCtrl+C 结束")
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


def rel_to_root(p):
    rel = os.path.relpath(Path(p).resolve(), ROOT).replace("\\", "/")
    if rel.startswith(".."):
        sys.exit(f"文件需要放在项目目录内（本地服务器只能访问项目目录）：{p}")
    return rel


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    if "--serve-only" in sys.argv:  # 只起服务器（页面已生成过）
        serve(int(sys.argv[sys.argv.index("--serve-only") + 1]) if len(sys.argv) > 2 else 8765)
        return
    ap = argparse.ArgumentParser(description="对齐核对页（音轨 + 歌词时间轴）")
    ap.add_argument("--aligned", required=True, help="逐词数据包（Suno 导出或 align_local.py 输出）")
    ap.add_argument("--audio", required=True, help="播放用的音频")
    ap.add_argument("--wave", help="波形用的音频，默认同 --audio；给人声分轨更容易看出每句起点")
    ap.add_argument("--ref", help="模型锚点（align_mms.py 的 review_<id>_mms.json），只作参考标记，不算你的锚点")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-serve", action="store_true", help="只生成页面，不起服务器")
    args = ap.parse_args()

    bundle = json.loads(Path(args.aligned).read_text(encoding="utf-8"))
    song_id, clip, aligned = bundle["id"], bundle["clip"], bundle["aligned"]
    words = aligned.get("aligned_words") or aligned.get("aligned_lyrics") or []
    lyrics = (clip.get("metadata") or {}).get("prompt", "")
    lines = build_lines(words, lyrics)
    labels = section_labels(lyrics, len(lines))
    weak = {round(float(w["start_s"]), 3) for w in words if float(w.get("p_align", 1)) < 1}

    out_dir = ROOT / "output" / f"{safe_name(clip.get('title') or song_id)}_{song_id[:8]}" / "review"
    out_dir.mkdir(parents=True, exist_ok=True)
    pk, duration = peaks(Path(args.wave or args.audio))
    save = Path(args.aligned).resolve().with_name(f"review_{song_id}.json")
    ref = json.loads(Path(args.ref).read_text(encoding="utf-8")).get("anchors", []) if args.ref else []

    data = {
        "id": song_id, "title": clip.get("title") or song_id,
        "source": aligned.get("source", "suno"), "audio": "/" + rel_to_root(args.audio),
        "save": rel_to_root(save), "duration": duration, "peaksPerSec": PEAKS_PER_SEC, "peaks": pk,
        "lines": [{"text": "".join(t for t, _, _ in ln), "section": labels[i],
                   "words": [[t, round(s, 3), round(e, 3), int(round(s, 3) in weak)] for t, s, e in ln]}
                  for i, ln in enumerate(lines)],
        "ref": ref,
    }
    html = PAGE.replace("/*DATA*/null", json.dumps(data, ensure_ascii=False))
    page = out_dir / "index.html"
    page.write_text(html, encoding="utf-8")
    url = f"http://127.0.0.1:{args.port}/" + page.relative_to(ROOT).as_posix()
    print(f"核对页: {page}\n保存到: {save}")
    if not args.no_serve:
        serve(args.port, url)


PAGE = r"""<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>对齐核对</title>
<style>
:root{--bg:#0f1117;--panel:#171a23;--line:#262b38;--fg:#e6e8ee;--dim:#7d8496;--hi:#ffd23f;--acc:#ff4f9a;--anc:#3fd0ff;--warn:#f0a04b}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 "Microsoft YaHei","PingFang SC",sans-serif;height:100vh;display:flex;flex-direction:column}
header{display:flex;gap:12px;align-items:center;padding:8px 16px;border-bottom:1px solid var(--line);flex-wrap:wrap}
header h1{font-size:16px;margin:0;margin-right:auto}.tag{color:var(--dim);font-size:12px}
button,input{background:var(--panel);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:4px 10px;font:inherit;cursor:pointer}
button:hover{border-color:var(--acc)}input[type=number]{width:64px;cursor:text}input[type=range]{width:150px;padding:0}
#rateV{font:13px monospace;color:var(--hi);width:48px;display:inline-block}
#saved{font-size:12px}#saved.ok{color:#6fdc8c}#saved.bad{color:var(--warn)}
main{flex:1;display:grid;grid-template-columns:1fr 440px;min-height:0}
#left{display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--line)}
#stage{flex:1;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:12px;padding:20px;text-align:center}
#hint{display:flex;gap:12px;align-items:center;padding:6px 16px;border-top:1px solid var(--line);flex-wrap:wrap}
#target{font-size:17px;font-weight:600;color:var(--anc);border:1px dashed var(--anc);border-radius:8px;padding:4px 14px}
#target.none{color:var(--dim);border-color:var(--line);font-weight:400}
#miss{margin-left:auto;font-size:16px;font-weight:700;color:#fff;background:#b3263a;border-radius:8px;padding:4px 12px;display:none}
#miss span{cursor:pointer;text-decoration:underline;margin:0 3px}
#prev,#next{color:var(--dim);font-size:22px;min-height:33px}
#cur{font-size:40px;font-weight:700;min-height:60px}
#cur span{color:#fff}#cur span.done{color:var(--hi)}
#sec{color:var(--acc);font-size:13px;letter-spacing:1px;min-height:20px}
#time{font:13px monospace;color:var(--dim)}
#toast{position:fixed;left:50%;top:70px;transform:translateX(-50%);background:#3a2410;color:var(--warn);border:1px solid var(--warn);padding:8px 16px;border-radius:8px;display:none;z-index:9}
#tl{width:100%;height:210px;display:block;cursor:pointer;border-top:1px solid var(--line)}
#bar{display:flex;gap:10px;align-items:center;padding:8px 16px;border-top:1px solid var(--line);color:var(--dim);font-size:12px;flex-wrap:wrap}
#list{overflow:auto;padding:6px 0}
.row{display:grid;grid-template-columns:24px 62px 1fr auto;gap:8px;padding:6px 12px;border-left:3px solid transparent;cursor:pointer;align-items:baseline}
.row:hover{background:#1b1f2a}.row.cur{background:#231a26;border-left-color:var(--acc)}.row.sel{outline:1px dashed var(--anc);outline-offset:-1px}
.row .n{font:bold 12px monospace;color:#8fb8ff;text-align:right}.row .t{font:12px monospace;color:var(--dim)}.row .x{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row .b{font:11px monospace;white-space:nowrap}.ai{color:#6fdc8c}.anc{color:var(--anc)}.iss{color:var(--acc)}.weak,.warn{color:var(--warn)}
.sechead{padding:10px 12px 2px;color:var(--acc);font-size:11px;letter-spacing:1px;text-transform:uppercase}
kbd{background:var(--panel);border:1px solid var(--line);border-radius:4px;padding:0 5px;font-size:11px;color:var(--fg)}
</style></head><body>
<header><h1 id="title"></h1><span class="tag" id="src"></span>
<label class="tag">速度 <input id="rate" type="range" min="0.1" max="2" step="0.05" value="1"> <span id="rateV">1.00×</span></label>
<label class="tag">←→ 步长 <input id="step" type="number" min="0.05" max="30" step="0.05" value="2"> s</label>
<label class="tag">整体偏移 <input id="off" type="number" step="50" value="0"> ms</label>
<span id="saved"></span>
<button id="exp">另存 JSON</button><button id="clr">清空</button></header>
<main><section id="left">
<div id="stage"><div id="sec"></div><div id="prev"></div><div id="cur"></div><div id="next"></div><div id="time"></div></div>
<div id="hint"><div id="target" class="none"></div><div id="miss"></div></div>
<canvas id="tl"></canvas>
<div id="bar"><kbd>空格</kbd>播放 <kbd>←</kbd><kbd>→</kbd>步进(Shift ¼) <kbd>[</kbd><kbd>]</kbd>减速/加速 <kbd>↑</kbd><kbd>↓</kbd>换行
<kbd>A</kbd>目标行开头=此刻 <kbd>X</kbd>本行未唱 <kbd>M</kbd>标记问题 <kbd>Del</kbd>删播放头后的下一个锚点 <kbd>U</kbd>撤销 <kbd>+</kbd><kbd>-</kbd>缩放
<span class="ai">AI</span>=模型已校准 <span style="margin-left:auto" id="stat"></span></div>
</section><aside id="list"></aside></main>
<div id="toast"></div>
<audio id="au" preload="auto"></audio>
<script>
const D=/*DATA*/null;
const $=s=>document.querySelector(s),au=$('#au'),cv=$('#tl'),cx=cv.getContext('2d');
const KEY='review_'+D.id,WARN_S=3;
let st={anchors:[],issues:[],skipped:[]},hist=[],sel=null,span=14,offset=0,lastCur=-1,saveTimer=null;
D.lines.forEach(l=>{l.start=l.words[0][1];l.end=l.words[l.words.length-1][2]});
au.src=encodeURI(D.audio);au.preservesPitch=true;
$('#title').textContent=D.title;$('#src').textContent='来源 '+D.source+' · '+D.lines.length+' 行';
const fmt=t=>{t=Math.max(0,t);const m=Math.floor(t/60);return m+':'+(t-m*60).toFixed(2).padStart(5,'0')};
const anchorOf=i=>st.anchors.find(a=>a.line===i);
const now=()=>au.currentTime-offset;
const step=()=>Math.max(0.05,+$('#step').value||2);
function curLine(t){let k=-1;for(let i=0;i<D.lines.length;i++){if(D.lines[i].start-0.3<=t)k=i;else break}return k}
function toast(msg){const e=$('#toast');e.textContent=msg;e.style.display='block';clearTimeout(e._t);e._t=setTimeout(()=>e.style.display='none',3500)}

// 保存：服务器文件为准（bundle 同目录 review_<id>.json），浏览器 localStorage 作备份
function save(){localStorage.setItem(KEY,JSON.stringify(st));renderList();
  clearTimeout(saveTimer);saveTimer=setTimeout(async()=>{
    try{const r=await fetch('/__save__',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({path:D.save,data:{id:D.id,source:D.source,...st}})});
      if(!r.ok)throw new Error(r.status);
      $('#saved').className='ok';$('#saved').textContent='✓ 已自动保存 '+new Date().toLocaleTimeString()}
    catch(e){$('#saved').className='bad';$('#saved').textContent='⚠ 服务器保存失败，仅存在浏览器里（可点"另存 JSON"）'}},300)}
async function load(){
  try{const r=await fetch('/'+encodeURI(D.save));if(r.ok){st=await r.json();norm();$('#saved').className='ok';$('#saved').textContent='已载入 '+D.save.split('/').pop();return}}catch(e){}
  const ls=JSON.parse(localStorage.getItem(KEY)||'null');if(ls){st=ls;norm();save()}}
function norm(){st.anchors=st.anchors||[];st.issues=st.issues||[];st.skipped=st.skipped||[]}
// 撤销历史同时记住目标行：撤销 A 后目标要回到被撤销的那一行
function push(){hist.push(JSON.stringify({st,sel}));if(hist.length>200)hist.shift()}

function renderList(){
  const L=$('#list');L.innerHTML='';
  D.lines.forEach((l,i)=>{
    if(l.section){const h=document.createElement('div');h.className='sechead';h.textContent=l.section;L.appendChild(h)}
    const r=document.createElement('div');r.className='row';r.id='r'+i;
    const a=anchorOf(i),iss=st.issues.filter(x=>x.line===i).length,wk=l.words.filter(w=>w[3]).length;
    const rf=(D.ref||[]).find(x=>x.line===i);let b=rf?`<span class="ai" title="模型置信度 ${rf.score}">AI</span> `:'';
    if(a){const d=a.t-l.start,bad=Math.abs(d)>WARN_S;
      b+=`<span class="${bad?'warn':'anc'}" title="${bad?'和当前对齐差得多，可能标错行':''}">${bad?'⚠':'⚓'}${d>=0?'+':''}${d.toFixed(2)}s</span> `}
    if(st.skipped.includes(i))b+=`<span class="warn">✕未唱</span> `;
    if(iss)b+=`<span class="iss">⚑${iss}</span> `;if(wk)b+=`<span class="weak" title="合并/拖腔的字">~${wk}</span>`;
    r.innerHTML=`<span class="n">${i+1}</span><span class="t">${fmt(l.start)}</span><span class="x">${l.text}</span><span class="b">${b}</span>`;
    r.onclick=()=>selectLine(i,true);
    L.appendChild(r)});
  mark();$('#stat').textContent=`锚点 ${st.anchors.length} · 未唱 ${st.skipped.length} · 问题 ${st.issues.length}`;
}
// 选中目标行，并从它（已有锚点优先）前 2 秒开始播
function selectLine(i,play){sel=i;const a=anchorOf(i);seek((a?a.t:D.lines[i].start)-2*Math.max(1,au.playbackRate));if(play)au.play();mark()}
// 漏标：已处理（锚点或未唱）的最大行号之前，既没锚点也没标未唱的行
function missing(){const done=new Set([...st.anchors.map(a=>a.line),...st.skipped]);if(!done.size)return[];
  const top=Math.max(...done);const m=[];for(let i=0;i<top;i++)if(!done.has(i))m.push(i);return m}
function renderMiss(){const m=missing(),e=$('#miss');if(!m.length){e.style.display='none';return}
  e.style.display='block';e.innerHTML='⚠ 漏标：第'+m.map(i=>`<span data-i="${i}">${i+1}</span>`).join('、')+'行';
  e.querySelectorAll('span').forEach(x=>x.onclick=()=>selectLine(+x.dataset.i,true))}
function mark(){renderMiss();document.querySelectorAll('.row').forEach(r=>r.classList.remove('sel','cur'));
  const s=$('#r'+sel);if(s)s.classList.add('sel');const c=$('#r'+lastCur);if(c)c.classList.add('cur');
  const tg=$('#target');
  if(sel===null){tg.className='none';tg.textContent='先在右侧点选要标记的行（点击会从该行前 2 秒开始播放）'}
  else{tg.className='';const a=anchorOf(sel);tg.textContent=`按 A 标记 → 第 ${sel+1} 行「${D.lines[sel].text}」开头`+(a?`（已有锚点 ${fmt(a.t)}）`:'')}}
function seek(t){au.currentTime=Math.max(0,Math.min(D.duration,t+offset))}

function renderStage(t){
  const k=curLine(t);
  if(k!==lastCur){lastCur=k;mark();const r=$('#r'+k);if(r)r.scrollIntoView({block:'center',behavior:'smooth'})}
  const l=D.lines[k];$('#prev').textContent=k>0?D.lines[k-1].text:'';$('#next').textContent=D.lines[k+1]?D.lines[k+1].text:'';
  let sec='';for(let i=k;i>=0;i--)if(D.lines[i].section){sec=D.lines[i].section;break}$('#sec').textContent=sec;
  const c=$('#cur');
  if(!l){c.textContent='';}else{
    if(c.dataset.k!=k){c.dataset.k=k;c.innerHTML=l.words.map(w=>`<span>${w[0]}</span>`).join('')}
    [...c.children].forEach((sp,i)=>{const[,s,e]=l.words[i];
      if(t>=e){sp.className='done';sp.style.background='';sp.style.color=''}
      else if(t>s){const p=((t-s)/(e-s)*100).toFixed(0);sp.className='';
        sp.style.background=`linear-gradient(90deg,var(--hi) ${p}%,#fff ${p}%)`;sp.style.webkitBackgroundClip='text';sp.style.color='transparent'}
      else{sp.className='';sp.style.background='';sp.style.color=''}})}
  $('#time').textContent=fmt(t)+' / '+fmt(D.duration)+'  '+au.playbackRate.toFixed(2)+'×'+(au.paused?'  ⏸':'');
}

function renderTL(t){
  const r=devicePixelRatio,W=cv.width=cv.clientWidth*r,H=cv.height=cv.clientHeight*r;
  const t0=t-span*0.3,px=W/span,X=x=>(x-t0)*px;
  cx.fillStyle='#12151d';cx.fillRect(0,0,W,H);
  cx.fillStyle='#7d8496';cx.font=`${10*r}px monospace`;
  for(let s=Math.ceil(t0);s<t0+span;s++){cx.fillRect(X(s),H-12*r,1,4*r);if(s%2===0)cx.fillText(fmt(s).slice(0,-3),X(s)+2*r,H-2*r)}
  const pps=D.peaksPerSec,mid=H*0.68,amp=H*0.26;cx.fillStyle='#5c3b6e';
  for(let x=0;x<W;x+=2*r){const i=Math.floor((t0+x/px)*pps);const v=(D.peaks[i]||0)/100*amp;cx.fillRect(x,mid-v,1.5*r,v*2)}
  D.lines.forEach((l,i)=>{if(l.end<t0||l.start>t0+span)return;
    const x0=X(l.start),x1=X(l.end),w=Math.max(2,x1-x0-2*r);
    cx.fillStyle=i===sel?'#3fd0ff44':i===lastCur?'#ff4f9a55':(i%2?'#3a3f5a':'#2d3348');cx.fillRect(x0,4*r,w,22*r);
    cx.save();cx.beginPath();cx.rect(x0,4*r,w,22*r);cx.clip();cx.fillStyle='#e6e8ee';cx.font=`${12*r}px "Microsoft YaHei"`;cx.fillText((i+1)+' '+l.text,x0+4*r,20*r);cx.restore();
    l.words.forEach(wd=>{const x=X(wd[1]);cx.fillStyle=wd[3]?'#f0a04b':'#9aa3b8';cx.fillRect(x,56*r,1*r,10*r);
      cx.font=`${11*r}px "Microsoft YaHei"`;cx.fillText(wd[0].trim().slice(0,4),x+2*r,66*r)})});
  // 人工轨：按你打的锚点摆放行（到下一个锚点或该行自动时长为止）
  const ha=[...st.anchors].sort((a,b)=>a.t-b.t);
  ha.forEach((a,k)=>{const l=D.lines[a.line];let e=a.t+(l.end-l.start);if(ha[k+1])e=Math.min(e,ha[k+1].t);
    if(e<t0||a.t>t0+span)return;const x0=X(a.t),w=Math.max(2,X(e)-x0-2*r);
    cx.fillStyle=a.line===sel?'#3fd0ff66':'#1d5566';cx.fillRect(x0,30*r,w,22*r);
    cx.save();cx.beginPath();cx.rect(x0,30*r,w,22*r);cx.clip();cx.fillStyle='#dff6ff';cx.font=`bold ${12*r}px "Microsoft YaHei"`;
    cx.fillText((a.line+1)+' '+l.text,x0+4*r,46*r);cx.restore()});
  cx.font=`${10*r}px "Microsoft YaHei"`;cx.fillStyle='#7d8496';cx.fillText('自动',2*r,20*r);cx.fillStyle='#3fd0ff';cx.fillText('人工',2*r,46*r);
  (D.ref||[]).forEach(a=>{const x=X(a.t);cx.fillStyle='#6fdc8c';for(let y=0;y<H;y+=8*r)cx.fillRect(x,y,1*r,4*r)});
  cx.font=`${11*r}px monospace`;
  st.anchors.forEach(a=>{const x=X(a.t);cx.fillStyle='#3fd0ff';cx.fillRect(x,28*r,2*r,H-28*r)});
  st.issues.forEach(q=>{const x=X(q.t);cx.fillStyle='#ff4f9a';cx.fillRect(x,0,2*r,H);cx.fillText('⚑',x+3*r,80*r)});
  cx.fillStyle='#ffd23f';cx.fillRect(X(t),0,2*r,H);
}
cv.onclick=e=>seek(now()-span*0.3+e.offsetX/cv.clientWidth*span);

function setRate(v){v=Math.min(2,Math.max(0.1,Math.round(v*20)/20));au.playbackRate=v;$('#rate').value=v;$('#rateV').textContent=v.toFixed(2)+'×'}
function loop(){const t=now();renderStage(t);renderTL(t);requestAnimationFrame(loop)}
document.onkeydown=e=>{
  if(e.target.tagName==='INPUT'&&e.target.type!=='range')return;const t=now(),k=e.key;
  if(e.code==='Space'){e.preventDefault();au.paused?au.play():au.pause()}
  else if(k==='ArrowLeft'||k==='ArrowRight'){e.preventDefault();const d=step()*(e.shiftKey?0.25:1);seek(t+(k==='ArrowLeft'?-d:d))}
  else if(k==='ArrowUp'||k==='ArrowDown'){e.preventDefault();const base=sel===null?curLine(t):sel;
    selectLine(Math.max(0,Math.min(D.lines.length-1,base+(k==='ArrowUp'?-1:1))),false)}
  else if(k==='['){setRate(au.playbackRate-0.05)}else if(k===']'){setRate(au.playbackRate+0.05)}
  else if(k==='a'||k==='A'){
    if(sel===null){toast('先在右侧点选要标记的行');return}
    push();const d=t-D.lines[sel].start;st.skipped=st.skipped.filter(x=>x!==sel);
    st.anchors=st.anchors.filter(a=>a.line!==sel);st.anchors.push({line:sel,t:+t.toFixed(3),text:D.lines[sel].text});
    st.anchors.sort((a,b)=>a.line-b.line);
    const pa=st.anchors.filter(a=>a.line<sel).sort((a,b)=>b.line-a.line)[0],na=st.anchors.filter(a=>a.line>sel).sort((a,b)=>a.line-b.line)[0];
    const miss=missing().filter(i=>i<sel);
    if(pa&&t<=pa.t)toast(`⚠ 时间早于第 ${pa.line+1} 行的锚点，确认没标错行？（U 撤销）`);
    else if(na&&t>=na.t)toast(`⚠ 时间晚于第 ${na.line+1} 行的锚点，确认没标错行？（U 撤销）`);
    else if(miss.length)toast(`⚠ 前面第 ${miss.map(i=>i+1).join('、')} 行还没标`);
    else if(Math.abs(d)>WARN_S)toast(`第 ${sel+1} 行锚点与自动对齐差 ${d.toFixed(1)} 秒（自动对齐可能错行，正常）`);
    sel=Math.min(sel+1,D.lines.length-1);save()}
  else if(k==='x'||k==='X'){
    if(sel===null){toast('先在右侧点选要标记的行');return}
    push();const was=st.skipped.includes(sel);
    st.skipped=was?st.skipped.filter(x=>x!==sel):[...st.skipped,sel].sort((a,b)=>a-b);
    if(!was){st.anchors=st.anchors.filter(a=>a.line!==sel);toast(`第 ${sel+1} 行标为未唱（再按 X 取消）`);sel=Math.min(sel+1,D.lines.length-1)}
    else toast(`已取消第 ${sel+1} 行的未唱标记`);save()}
  else if(k==='m'||k==='M'){push();const c=curLine(t);st.issues.push({t:+t.toFixed(3),line:c,text:c>=0?D.lines[c].text:''});save()}
  else if(k==='Delete'||k==='Backspace'){
    // 播放头之前最近的锚点是第 N 行 → 删第 N+1 行的锚点（通常是刚标错、回退重听的那一行）
    const before=st.anchors.filter(a=>a.t<=t).sort((a,b)=>b.t-a.t)[0],n1=before?before.line+1:0,a=anchorOf(n1);
    if(!a){toast(`第 ${n1+1} 行还没有锚点，未删除`);return}
    push();st.anchors=st.anchors.filter(x=>x.line!==n1);sel=n1;save();toast(`已删除第 ${n1+1} 行锚点，按 A 重标（U 撤销）`)}
  else if(k==='u'||k==='U'||(e.ctrlKey&&k==='z')){if(hist.length){const h=JSON.parse(hist.pop());st=h.st;sel=h.sel;norm();save();toast('已撤销'+(sel!==null?`，目标回到第 ${sel+1} 行`:''))}}
  else if(k==='+'||k==='='){span=Math.max(3,span/1.4)}
  else if(k==='-'){span=Math.min(60,span*1.4)}
};
$('#rate').oninput=e=>setRate(+e.target.value);
$('#off').onchange=e=>offset=(+e.target.value||0)/1000;
$('#exp').onclick=()=>{const b=new Blob([JSON.stringify({id:D.id,source:D.source,...st},null,2)],{type:'application/json'});
  const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='review_'+D.id+'.json';a.click()};
$('#clr').onclick=()=>{if(confirm('清空所有锚点和问题？（可按 U 撤销）')){push();st={anchors:[],issues:[],skipped:[]};save()}};
load().then(()=>{renderList();mark();loop()});
</script></body></html>
"""

if __name__ == "__main__":
    main()
