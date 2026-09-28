"""用人工标注的行首时间给对齐结果打分。

用法:
    python tools/eval_lines.py Projects/<歌名>/groundtruth_<id>_lines.json a.json b.json ... [--rows]
"""
import json
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from suno_karaoke import build_lines  # noqa: E402


def line_starts(path):
    """每行首字时间。用渲染器同款切行（兼容 Suno 原始数据里的 [Male] 等标签）。"""
    b = json.loads(Path(path).read_text(encoding="utf-8"))
    words = b["aligned"].get("aligned_words") or b["aligned"].get("aligned_lyrics")
    return [ln[0][1] for ln in build_lines(words, (b["clip"].get("metadata") or {}).get("prompt", ""))]


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    gt = {a["line"]: a["t"] for a in json.loads(Path(args[0]).read_text(encoding="utf-8"))["anchors"]}
    runs = {Path(p).stem.split("_")[-1]: line_starts(p) for p in args[1:]}
    print(f"{'方法':<22}{'中位误差':>8}{'≤0.3s':>9}{'≤1s':>9}{'>2s':>6}")
    for name, st in runs.items():
        e = [abs(st[l] - t) for l, t in gt.items()]
        print(f"{name:<22}{statistics.median(e):8.2f}{sum(x <= 0.3 for x in e):6}/{len(e)}"
              f"{sum(x <= 1 for x in e):6}/{len(e)}{sum(x > 2 for x in e):6}")
    if "--rows" in sys.argv:
        print("\n行号  人工     " + "  ".join(f"{n[:10]:>10}" for n in runs))
        for l, t in sorted(gt.items()):
            cells = [st[l] - t for st in runs.values()]
            if any(abs(c) > 0.3 for c in cells):
                print(f"{l + 1:3d} {t:8.2f}  " + "  ".join(f"{c:+10.2f}" for c in cells))


if __name__ == "__main__":
    main()
