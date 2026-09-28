"""Suno 链接 → 官方逐词时间戳 → ASS 卡拉OK逐字字幕（可选合成视频）。

用法:
    python suno_karaoke.py <suno 链接或歌曲ID> [--audio song.mp3] [--res 720] [--offset 毫秒]

鉴权: 在同目录 .env 写入 SUNO_COOKIE=<auth.suno.com 的 __client cookie 值>
音频: Suno 公开 m4a 是加密的；优先用登录态拿到的 audio_url，拿不到就用 --audio 指定手动下载的 mp3
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent
STUDIO = "https://studio-api.prod.suno.com"
CLERK_HOSTS = ("https://auth.suno.com", "https://clerk.suno.com")  # 不确定当前用哪个，依次尝试
CLERK_VER = "5.56.0"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/140.0 Safari/537.36")
UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
TAG_RE = re.compile(r"\[[^\]\n]*\]")

session = requests.Session()
session.headers["User-Agent"] = UA


# ---------- 输入与鉴权 ----------

def load_env():
    env_file = ROOT / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def resolve_id(arg):
    m = UUID_RE.search(arg)
    if m:
        return m.group(0).lower()
    # 短链 suno.com/s/xxxx：跟随跳转拿到真实地址
    r = session.get(arg if arg.startswith("http") else "https://" + arg, timeout=20)
    m = UUID_RE.search(r.url) or UUID_RE.search(r.text)
    if not m:
        sys.exit(f"无法从链接中解析歌曲 ID: {arg}")
    return m.group(0).lower()


def get_jwt():
    if os.environ.get("SUNO_TOKEN"):
        return os.environ["SUNO_TOKEN"]
    raw = os.environ.get("SUNO_COOKIE", "").strip()
    if not raw:
        sys.exit("缺少鉴权：请在 .env 中写入 SUNO_COOKIE=<__client cookie 值>（见 README.md）")
    cookie = raw if "__client=" in raw else f"__client={raw}"
    headers = {"Cookie": cookie, "Origin": "https://suno.com", "Referer": "https://suno.com/"}
    params = {"_clerk_js_version": CLERK_VER}
    for host in CLERK_HOSTS:
        r = session.get(f"{host}/v1/client", headers=headers, params=params, timeout=20)
        resp = (r.json().get("response") or {}) if r.ok else {}
        sid = resp.get("last_active_session_id") or next(
            (s["id"] for s in resp.get("sessions", [])), None)
        if sid:
            break
    else:
        sys.exit("cookie 无效或已过期：Clerk 没有返回登录会话，请重新复制 __client")
    r = session.post(f"{host}/v1/client/sessions/{sid}/tokens",
                     headers=headers, params=params, timeout=20)
    r.raise_for_status()
    return r.json()["jwt"]


# ---------- 拉取数据 ----------

def fetch_clip(song_id, jwt):
    r = session.get(f"{STUDIO}/api/clip/{song_id}",
                    headers={"Authorization": f"Bearer {jwt}"}, timeout=20)
    r.raise_for_status()
    return r.json()


def fetch_aligned(song_id, jwt):
    headers = {"Authorization": f"Bearer {jwt}"}
    for attempt in range(6):
        r = session.get(f"{STUDIO}/api/gen/{song_id}/aligned_lyrics/v2/",
                        headers=headers, timeout=60)
        if r.status_code == 401:
            sys.exit("对齐接口 401：token 无效，请检查 SUNO_COOKIE")
        r.raise_for_status()
        data = r.json()
        if data.get("aligned_words") or data.get("aligned_lyrics"):
            return data
        time.sleep(3 + attempt * 2)  # 首次请求时 Suno 可能在后台现算
    sys.exit(f"对齐接口未返回逐词数据: {json.dumps(data, ensure_ascii=False)[:300]}")


def is_audio(path):
    """按文件头判断是否为可解码音频（公开 m4a 是加密字节流，会被判为否）。"""
    head = path.read_bytes()[:12]
    return (head[4:8] == b"ftyp" or head[:3] == b"ID3" or head[:4] in (b"OggS", b"RIFF", b"fLaC")
            or (len(head) > 1 and head[0] == 0xFF and head[1] & 0xE0 == 0xE0))


def get_audio(clip, out_dir):
    urls = [clip.get("audio_url")] + [m.get("url") for m in clip.get("media_urls") or []]
    for url in filter(None, urls):
        if "forbidden" in url:
            continue
        dest = out_dir / ("audio" + (Path(url.split("?")[0]).suffix or ".mp3"))
        try:
            download(url, dest)
        except requests.HTTPError:
            continue
        if is_audio(dest):
            return dest
        dest.unlink()
    return None


def download(url, dest):
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    with session.get(url, stream=True, timeout=60) as r:
        r.raise_for_status()
        with open(dest, "wb") as f:
            for chunk in r.iter_content(1 << 16):
                f.write(chunk)
    return dest


# ---------- 分行 ----------

def build_lines(words, lyrics):
    """把逐词数据切成歌词行，每行是 [(文本, start, end), ...]。

    先按字符流处理：记录每个字符属于哪个 word，删掉 [段落/演唱者] 标签，
    再按换行切行。若对齐数据里没有换行，则按原歌词每行的字数回填。
    """
    stream = [(c, i) for i, w in enumerate(words) for c in w.get("word", "")]
    text = "".join(c for c, _ in stream)
    keep = [True] * len(stream)
    for m in TAG_RE.finditer(text):
        for k in range(m.start(), m.end()):
            keep[k] = False
    stream = [s for s, k in zip(stream, keep) if k]

    if any(c == "\n" for c, _ in stream):
        raw_lines, cur = [], []
        for c, i in stream:
            if c == "\n":
                raw_lines.append(cur)
                cur = []
            else:
                cur.append((c, i))
        raw_lines.append(cur)
    else:
        raw_lines = split_by_lyrics(stream, lyrics)

    lines = []
    for chars in raw_lines:
        sylls = []
        for c, i in chars:
            if sylls and sylls[-1][0] == i:
                sylls[-1][1] += c
            else:
                sylls.append([i, c])
        out = []
        for i, t in sylls:
            if not t.strip():
                if out:
                    out[-1][0] += t
                continue
            w = words[i]
            out.append([t, float(w["start_s"]), float(w["end_s"])])
        if out:
            out[0][0] = out[0][0].lstrip()
            out[-1][0] = out[-1][0].rstrip()
            lines.append([tuple(s) for s in out])
    return lines


def split_by_lyrics(stream, lyrics):
    targets = []
    for ln in TAG_RE.sub("", lyrics or "").splitlines():
        n = sum(1 for c in ln if not c.isspace())
        if n:
            targets.append(n)
    lines, cur, count, t = [], [], 0, 0
    for c, i in stream:
        cur.append((c, i))
        if not c.isspace():
            count += 1
        if t < len(targets) - 1 and count >= targets[t]:
            lines.append(cur)
            cur, count, t = [], 0, t + 1
    lines.append(cur)
    return lines


# ---------- ASS 生成 ----------

def ass_time(t):
    t = max(t, 0)
    cs = int(round(t * 100))
    return f"{cs // 360000}:{cs // 6000 % 60:02d}:{cs // 100 % 60:02d}.{cs % 100:02d}"


def ass_escape(s):
    return s.replace("\\", "＼").replace("{", "（").replace("}", "）")


def needs_space(a, b):
    return (a and b and not a[-1].isspace() and not b[0].isspace()
            and a[-1].isascii() and a[-1].isalnum() and b[0].isascii() and b[0].isalnum())


def line_text(line):
    out = ""
    for t, _, _ in line:
        out += (" " if needs_space(out, t) else "") + t
    return out


HEADER = """[Script Info]
Title: {title}
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Karaoke,{font},76,&H0000D7FF,&H00FFFFFF,&H00202020,&H80000000,-1,0,0,0,100,100,1,0,1,4,2,2,80,80,150,1
Style: Next,{font},52,&H00C8C8C8,&H00C8C8C8,&H00202020,&H80000000,0,0,0,0,100,100,1,0,1,3,1,2,80,80,70,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

def default_font():
    return {"win32": "Microsoft YaHei", "darwin": "PingFang SC"}.get(sys.platform, "Noto Sans CJK SC")


LEAD_IN = 1.0   # 行提前出现的秒数
TAIL = 0.6      # 唱完后停留的秒数


def build_ass(lines, title, offset=0.0, preview=True, font=None):
    lines = [[(t, s + offset, e + offset) for t, s, e in ln] for ln in lines]
    # 每行显示区间：提前 LEAD_IN 出现，但不早于上一行最后一个字唱完
    shows = []
    for k, ln in enumerate(lines):
        prev_end = lines[k - 1][-1][2] if k else 0.0
        shows.append(max(ln[0][1] - LEAD_IN, prev_end, 0.0))
    events = []
    for k, ln in enumerate(lines):
        show = shows[k]
        hide = ln[-1][2] + TAIL
        if k + 1 < len(lines):
            hide = min(hide, shows[k + 1])
        hide = max(hide, ln[-1][2])
        parts, cursor, text = [], show, ""
        for t, s, e in ln:
            s, e = max(s, cursor), max(e, s, cursor)
            gap = int(round(s * 100)) - int(round(cursor * 100))
            if gap > 0:
                parts.append(f"{{\\k{gap}}}")
            dur = max(int(round(e * 100)) - int(round(s * 100)), 1)
            piece = (" " if needs_space(text, t) else "") + t
            text += piece
            parts.append(f"{{\\kf{dur}}}{ass_escape(piece)}")
            cursor = e
        events.append(f"Dialogue: 1,{ass_time(show)},{ass_time(hide)},Karaoke,,0,0,0,,{''.join(parts)}")
        if preview and k + 1 < len(lines):
            events.append(f"Dialogue: 0,{ass_time(show)},{ass_time(hide)},Next,,0,0,0,,"
                          f"{ass_escape(line_text(lines[k + 1]))}")
    return HEADER.format(title=title, font=font or default_font()) + "\n".join(events) + "\n"


# ---------- 视频 ----------

def find_ffmpeg():
    # winget 安装后需重开终端才进 PATH，这里兜底直接找安装目录
    pkgs = Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft/WinGet/Packages"
    return shutil.which("ffmpeg") or next(
        (str(p) for p in pkgs.glob("Gyan.FFmpeg*/*/bin/ffmpeg.exe")), None)


def audio_duration(ffmpeg, audio):
    # -loop 1 配 -shortest 会多出约 1 秒，改用 ffprobe 读出音频时长精确截断
    ffprobe = str(Path(ffmpeg).with_name(Path(ffmpeg).name.replace("ffmpeg", "ffprobe")))
    out = subprocess.run([ffprobe, "-v", "error", "-show_entries", "format=duration",
                          "-of", "csv=p=0", str(audio)], capture_output=True, text=True, check=True)
    return out.stdout.strip()


def render_video(out_dir, audio, cover, ass_name, mp4_name, height=720):
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        print("未找到 ffmpeg，跳过视频合成（安装见 README）")
        return
    w, h = height * 16 // 9 // 2 * 2, height
    fg, top = int(h * 0.62) // 2 * 2, int(h * 0.06)
    # 背景只算一次：模糊压暗的封面铺满 16:9，中间叠原封面，下方留给字幕
    bg = (f"[0:v]split[a][b];[a]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},"
          f"boxblur=20:3,eq=brightness=-0.25[bg];[b]scale=-2:{fg}[fg];[bg][fg]overlay=(W-w)/2:{top}")
    q = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y"]
    subprocess.run(q + ["-i", cover.name, "-filter_complex", bg, "-frames:v", "1", "frame.png"],
                   cwd=out_dir, check=True)
    cmd = q + ["-stats", "-loop", "1", "-framerate", "25", "-i", "frame.png", "-i", audio.name,
               "-vf", f"ass={ass_name}", "-c:v", "libx264", "-tune", "stillimage", "-preset", "veryfast",
               "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
               "-t", audio_duration(ffmpeg, audio), "-movflags", "+faststart", mp4_name]
    subprocess.run(cmd, cwd=out_dir, check=True)  # cwd 规避 Windows 路径在 ass 滤镜里的转义问题
    print(f"视频: {out_dir / mp4_name}")


# ---------- 主流程 ----------

def safe_name(s):
    return re.sub(r'[\\/:*?"<>|\s]+', "_", s).strip("_")[:60] or "song"


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description="Suno 歌曲 → 逐字卡拉OK字幕 MV（封面 + 歌词）")
    ap.add_argument("url", nargs="?", help="Suno 歌曲链接或 ID（用 --aligned 时可省略）")
    ap.add_argument("--aligned", help="tools/get_aligned.js 在浏览器导出的 JSON；给了就不需要 cookie")
    ap.add_argument("--audio", help="本地音频（从 Suno 下载的 MP3）；登录态拿不到明文音频时必填")
    ap.add_argument("--res", type=int, default=720, choices=[480, 720, 1080], help="视频高度，默认 720")
    ap.add_argument("--font", help="字幕字体，默认按系统选 CJK 字体")
    ap.add_argument("--no-video", action="store_true", help="只生成 ASS 字幕，不合成视频")
    ap.add_argument("--offset", type=int, default=0, help="整体时间偏移（毫秒，正数=延后）")
    ap.add_argument("--no-preview", action="store_true", help="不显示下一行预告")
    ap.add_argument("--out", default=str(ROOT / "output"), help="输出目录")
    args = ap.parse_args()

    load_env()
    if args.aligned:
        bundle = json.loads(Path(args.aligned).read_text(encoding="utf-8"))
        song_id, clip, aligned = bundle["id"], bundle["clip"], bundle["aligned"]
    elif args.url:
        song_id = resolve_id(args.url)
        jwt = get_jwt()
        clip = fetch_clip(song_id, jwt)
        aligned = fetch_aligned(song_id, jwt)
    else:
        ap.error("需要歌曲链接，或 --aligned 导出的 JSON")
    title = clip.get("title") or song_id
    lyrics = (clip.get("metadata") or {}).get("prompt", "")
    print(f"歌曲: {title}  ({clip.get('display_name')}, {song_id})")

    out_dir = Path(args.out) / f"{safe_name(title)}_{song_id[:8]}"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "clip.json").write_text(json.dumps(clip, ensure_ascii=False, indent=2), encoding="utf-8")

    (out_dir / "aligned.json").write_text(json.dumps(aligned, ensure_ascii=False, indent=2), encoding="utf-8")
    words = aligned.get("aligned_words") or aligned.get("aligned_lyrics")  # 两种字段名都见过
    if not words:
        # Suno 自己识别出的字错误率（hoot_cer）过高时会丢弃对齐，只返回波形
        sys.exit(f"Suno 没有这首歌的逐词数据（hoot_cer={aligned.get('hoot_cer')}），需改用本地强制对齐")
    lines = build_lines(words, lyrics)
    ok = sum(1 for w in words if w.get("success", True))
    print(f"对齐: {len(words)} 词（成功 {ok}），{len(lines)} 行")

    ass = build_ass(lines, title, args.offset / 1000, preview=not args.no_preview, font=args.font)
    (out_dir / "karaoke.ass").write_text(ass, encoding="utf-8-sig")
    print(f"字幕: {out_dir / 'karaoke.ass'}")

    cover_url = clip.get("image_large_url") or clip.get("image_url")
    cover = download(cover_url, out_dir / "cover.jpg") if cover_url else None
    if args.audio:
        audio = out_dir / ("audio" + Path(args.audio).suffix)
        shutil.copyfile(args.audio, audio)
    else:
        audio = get_audio(clip, out_dir)
    print(f"音频: {audio or '未取得（公开流是加密的；请在 Suno 下载 MP3 后用 --audio 指定）'}")

    if not args.no_video:
        if not (audio and cover):
            print("缺少音频或封面，跳过视频合成")
        else:
            render_video(out_dir, audio, cover, "karaoke.ass", f"{safe_name(title)}.mp4", args.res)


if __name__ == "__main__":
    main()
