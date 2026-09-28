"""模型对齐（Whisper）：已知歌词 + 人声音频 → 逐字时间戳（stable-ts 的 align，Whisper large-v3）。

产出与 align_mms.py 相同:
    aligned_<id>_whisper.json      数据包（suno_karaoke.py --aligned 可直接用）
    review_<id>_whisper.json       每行起点作为模型锚点（带 score）

用法:
    python align_whisper.py --bundle aligned_<id>.json --audio vocals.wav [--model large-v3]
模型文件放在 ~/.cache/whisper/<model>.pt（没有会自动下载）。
"""
import argparse
import json
import re
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
import torchaudio

from align_local import parse_lyrics

UNIT_RE = re.compile(r"[㐀-鿿豈-﫿]|[a-z0-9']", re.I)  # 对齐比较用的字符：汉字、字母数字


def units(text):
    return [c.lower() for c in UNIT_RE.findall(text)]


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description="Whisper 强制对齐（已知歌词 + 人声）")
    ap.add_argument("--bundle", required=True, help="篡改猴导出的 JSON（取 id、clip 和歌词）")
    ap.add_argument("--audio", required=True, help="人声音频")
    ap.add_argument("--model", default="large-v3")
    ap.add_argument("--out", help="输出数据包路径，默认 bundle 同目录 aligned_<id>_whisper.json")
    args = ap.parse_args()

    import stable_whisper

    bundle = json.loads(Path(args.bundle).read_text(encoding="utf-8"))
    song_id, clip = bundle["id"], bundle["clip"]
    lines = parse_lyrics((clip.get("metadata") or {}).get("prompt", ""))
    line_texts = ["".join(t[0] for t in ln["tokens"]) for ln in lines]

    wav, sr = sf.read(args.audio, dtype="float32", always_2d=True)
    audio = torchaudio.functional.resample(torch.from_numpy(wav.mean(1)), sr, 16000).numpy()
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    model = stable_whisper.load_model(args.model, device=dev)
    result = model.align(audio, "\n".join(line_texts), language="zh", original_split=True)

    # Whisper 的词（可能是 1 个字或多个字）→ 逐字时间（多字词按字数均分）
    chars = []
    for seg in result.segments:
        for w in seg.words:
            us = units(w.word)
            d = (w.end - w.start) / max(len(us), 1)
            chars += [(c, w.start + i * d, w.start + (i + 1) * d, w.probability) for i, c in enumerate(us)]
    want = [c for t in line_texts for c in units(t)]
    if [c for c, *_ in chars] != want:
        sys.exit(f"Whisper 返回的文字与歌词对不上（{len(chars)} vs {len(want)} 字），需要检查")

    aligned_words, anchors, k = [], [], 0
    for li, ln in enumerate(lines):
        toks, probs = ln["tokens"], []
        for ti, (text, _, _) in enumerate(toks):
            n = len(units(text))
            seg = chars[k:k + n]
            k += n
            p = sum(c[3] for c in seg) / n
            probs.append(p)
            aligned_words.append({"word": text + ("\n" if ti == len(toks) - 1 else ""),
                                  "start_s": round(seg[0][1], 3), "end_s": round(seg[-1][2], 3),
                                  "success": True, "p_align": round(p, 3)})
        start = aligned_words[-len(toks)]["start_s"]
        anchors.append({"line": li, "t": start, "text": line_texts[li], "score": round(sum(probs) / len(probs), 3)})
    for a, b in zip(aligned_words, aligned_words[1:]):
        a["end_s"] = max(a["start_s"] + 0.05, min(a["end_s"], b["start_s"]))

    out = Path(args.out) if args.out else Path(args.bundle).with_name(f"aligned_{song_id}_whisper.json")
    out.write_text(json.dumps({"id": song_id, "clip": clip,
                               "aligned": {"aligned_words": aligned_words, "source": f"local-whisper-{args.model}"}},
                              ensure_ascii=False, indent=2), encoding="utf-8")
    anc = out.with_name(f"review_{song_id}_whisper.json")
    anc.write_text(json.dumps({"id": song_id, "source": "local-whisper", "anchors": anchors, "issues": []},
                              ensure_ascii=False, indent=2), encoding="utf-8")
    for a in anchors:
        print(f"{a['line'] + 1:3d}  {a['t']:8.2f}  {a['score']:.2f}  {a['text']}")
    print(f"\n数据包: {out}\n锚点:   {anc}")


if __name__ == "__main__":
    main()
