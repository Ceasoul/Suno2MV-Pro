"""模型对齐：已知歌词 + 人声音频 → 逐字时间戳（torchaudio MMS_FA 强制对齐，需 GPU 更快）。

两种产出:
    aligned_<id>_mms.json          纯模型对齐的数据包（suno_karaoke.py --aligned 可直接用）
    review_<id>_mms.json           每行起点作为"AI 锚点"，给 align_local.py --anchors 做 MIDI + 模型校准，
                                   也可给 review.py --anchors 预载核对

用法:
    python align_mms.py --bundle aligned_<id>.json --audio vocals.wav

中文每字转成无声调拼音（MMS 的字母表是 a–z 加撇号，与 uroman 罗马化一致）；行与行之间插入星号 token，
吸收间奏、垫词（"耶耶"）和和声。整首一次求解。
"""
import argparse
import json
import re
import sys
from pathlib import Path

import torch
import torchaudio
from pypinyin import Style, lazy_pinyin

from align_local import HAN_RE, parse_lyrics

MIN_ANCHOR_SCORE = 0.3  # 行内平均置信度低于此值的行不作为锚点


def romanize(token):
    if HAN_RE.fullmatch(token):
        s = lazy_pinyin(token, style=Style.NORMAL)[0].replace("ü", "u").replace("v", "u")
    else:
        s = token.lower()
    return re.sub(r"[^a-z']", "", s) or "a"


def load_vocals(path, sr, semitones=0):
    wav, src_sr = torchaudio.load(str(path))
    wav = torchaudio.functional.resample(wav.mean(0, keepdim=True), src_sr, sr)
    if semitones:  # 高音女声超出语音模型训练分布，降调后更容易识别；时长不变
        wav = torchaudio.functional.pitch_shift(wav, sr, semitones)
    return wav


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description="MMS_FA 模型对齐（已知歌词 + 人声）")
    ap.add_argument("--bundle", required=True, help="篡改猴导出的 JSON（取 id、clip 和歌词）")
    ap.add_argument("--audio", required=True, help="人声音频（Suno 人声分轨或 demucs 分离结果）")
    ap.add_argument("--pitch", type=int, default=0, help="识别前变调（半音，负数=降调），如 -12")
    ap.add_argument("--out", help="输出数据包路径，默认 bundle 同目录 aligned_<id>_mms.json")
    args = ap.parse_args()

    bundle = json.loads(Path(args.bundle).read_text(encoding="utf-8"))
    song_id, clip = bundle["id"], bundle["clip"]
    lines = parse_lyrics((clip.get("metadata") or {}).get("prompt", ""))

    # 转写：* 行1字1 行1字2 … * 行2字1 … *
    words, owner = ["*"], [None]
    for li, ln in enumerate(lines):
        for ti, (text, _, _) in enumerate(ln["tokens"]):
            words.append(romanize(re.sub(r"[^\w']", "", text)))
            owner.append((li, ti))
        words.append("*")
        owner.append(None)

    fa = torchaudio.pipelines.MMS_FA
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    model = fa.get_model(with_star=True).to(dev).eval()
    wav = load_vocals(args.audio, fa.sample_rate, args.pitch)
    with torch.inference_mode():
        emission, _ = model(wav.to(dev))
    spans = fa.get_aligner()(emission[0].cpu(), fa.get_tokenizer()(words))
    sec = wav.size(1) / emission.size(1) / fa.sample_rate
    print(f"设备 {dev}；帧长 {sec * 1000:.1f}ms；{len(lines)} 行，{len(words)} 个对齐单元")

    # 映射回字
    times = {}
    for sp, own in zip(spans, owner):
        if own:
            times[own] = (sp[0].start * sec, sp[-1].end * sec, sum(s.score for s in sp) / len(sp))
    aligned_words, anchors = [], []
    for li, ln in enumerate(lines):
        toks = ln["tokens"]
        scores = []
        for ti, (text, _, _) in enumerate(toks):
            s, e, sc = times[(li, ti)]
            scores.append(sc)
            aligned_words.append({"word": text + ("\n" if ti == len(toks) - 1 else ""),
                                  "start_s": round(s, 3), "end_s": round(e, 3),
                                  "success": True, "p_align": round(sc, 3)})
        conf = sum(scores) / len(scores)
        if conf >= MIN_ANCHOR_SCORE:
            anchors.append({"line": li, "t": round(times[(li, 0)][0], 3),
                            "text": "".join(t[0] for t in toks), "score": round(conf, 3)})
    for a, b in zip(aligned_words, aligned_words[1:]):
        a["end_s"] = min(a["end_s"], b["start_s"])

    out = Path(args.out) if args.out else Path(args.bundle).with_name(f"aligned_{song_id}_mms.json")
    out.write_text(json.dumps({"id": song_id, "clip": clip,
                               "aligned": {"aligned_words": aligned_words, "source": "local-mms"}},
                              ensure_ascii=False, indent=2), encoding="utf-8")
    anc = out.with_name(f"review_{song_id}_mms.json")
    anc.write_text(json.dumps({"id": song_id, "source": "local-mms", "anchors": anchors, "issues": []},
                              ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n行号  开始      置信度  歌词")
    for li, ln in enumerate(lines):
        sc = [times[(li, ti)][2] for ti in range(len(ln["tokens"]))]
        conf = sum(sc) / len(sc)
        mark = " " if conf >= MIN_ANCHOR_SCORE else "×"
        print(f"{mark}{li + 1:3d}  {times[(li, 0)][0]:8.2f}  {conf:5.2f}   {''.join(t[0] for t in ln['tokens'])}")
    print(f"\n数据包: {out}\n锚点:   {anc}（{len(anchors)}/{len(lines)} 行置信度 ≥ {MIN_ANCHOR_SCORE}）")


if __name__ == "__main__":
    main()
