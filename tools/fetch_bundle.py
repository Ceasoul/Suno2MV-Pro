"""从 Suno 链接取歌曲数据包（标题、歌词、风格、封面），不需要登录。

不公开（unlisted）的歌只要有链接也能取到。逐词时间戳接口需要登录，这里不取（aligned 为空），
之后用 align_local.py / align_mms.py / align_whisper.py 本地对齐。

用法:
    python tools/fetch_bundle.py https://suno.com/song/<id> [--out 目录]
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from suno_karaoke import STUDIO, resolve_id, session  # noqa: E402


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description="Suno 链接 → 数据包（不需要登录）")
    ap.add_argument("url")
    ap.add_argument("--out", default=".", help="输出目录")
    args = ap.parse_args()

    song_id = resolve_id(args.url)
    r = session.get(f"{STUDIO}/api/clip/{song_id}", timeout=20)
    r.raise_for_status()
    clip = r.json()
    meta = clip.get("metadata") or {}
    out = Path(args.out) / f"bundle_{song_id}.json"
    out.write_text(json.dumps({"id": song_id, "clip": clip, "aligned": {}}, ensure_ascii=False, indent=2),
                   encoding="utf-8")
    print(f"{clip.get('title')}  时长 {meta.get('duration')}s  歌词 {len(meta.get('prompt') or '')} 字")
    print(f"数据包: {out}")


if __name__ == "__main__":
    main()
