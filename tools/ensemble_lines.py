"""MMS + Whisper 组合：逐行挑选更可信的模型结果，输出同格式数据包。

规则（2026-09-28 在《千里走单骑》上定，之后冻结，不针对新歌调参）:
    1. 两模型行首差 ≤ 0.35s → 用 MMS（对的时候更准）
    2. 有分歧 → 选使"与上一行、下一行的间隔"最接近典型行长的那个（典型行长 = 一致行相邻间隔的中位数）；
       段首不算与上一行的间隔、段尾不算与下一行的间隔（段落间常有间奏）
    3. 算不出（平局）→ 选 Whisper（失败少、失败幅度小）
整行的逐字时间都取自被选中的模型。

用法:
    python tools/ensemble_lines.py --bundle bundle.json --mms aligned_mms.json --whisper aligned_whisper.json --out x.json
"""
import argparse
import json
import math
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from align_local import parse_lyrics  # noqa: E402

AGREE_S = 0.35


def words_by_line(path):
    lines, cur = [], []
    for w in json.loads(Path(path).read_text(encoding="utf-8"))["aligned"]["aligned_words"]:
        cur.append(w)
        if w["word"].endswith("\n"):
            lines.append(cur)
            cur = []
    return lines


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--bundle", required=True)
    ap.add_argument("--mms", required=True)
    ap.add_argument("--whisper", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    bundle = json.loads(Path(args.bundle).read_text(encoding="utf-8"))
    para = [ln["para_start"] for ln in parse_lyrics(bundle["clip"]["metadata"]["prompt"])]
    M, W = words_by_line(args.mms), words_by_line(args.whisper)
    ms, ws = [ln[0]["start_s"] for ln in M], [ln[0]["start_s"] for ln in W]
    n = len(ms)
    agree = [abs(a - b) <= AGREE_S for a, b in zip(ms, ws)]
    gaps = [ms[i + 1] - ms[i] for i in range(n - 1) if agree[i] and agree[i + 1] and not para[i + 1]]
    med = statistics.median(gaps) if gaps else 2.0

    chosen, starts = [], []
    for i in range(n):
        if agree[i]:
            pick = "mms"
        else:
            prev = starts[i - 1] if i and not para[i] else None
            nxt = ms[i + 1] if i + 1 < n and not para[i + 1] and agree[i + 1] else None

            def cost(c):
                s = abs(math.log(max(c - prev, 0.05) / med)) if prev is not None else 0.0
                return s + (abs(math.log(max(nxt - c, 0.05) / med)) if nxt is not None else 0.0)
            pick = "mms" if cost(ms[i]) < cost(ws[i]) else "whisper"
        chosen.append(pick)
        starts.append(ms[i] if pick == "mms" else ws[i])

    words = [w for i, p in enumerate(chosen) for w in (M[i] if p == "mms" else W[i])]
    for a, b in zip(words, words[1:]):
        a["end_s"] = max(a["start_s"] + 0.05, min(a["end_s"], b["start_s"]))
    Path(args.out).write_text(json.dumps({"id": bundle["id"], "clip": bundle["clip"],
                                          "aligned": {"aligned_words": words, "source": "local-ensemble",
                                                      "picked": chosen}},
                                         ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"一致 {sum(agree)}/{n} 行，典型行长 {med:.2f}s；分歧行选 Whisper {chosen.count('whisper')} 行")
    print(f"数据包: {args.out}")


if __name__ == "__main__":
    main()
