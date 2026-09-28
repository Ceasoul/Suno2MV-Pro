"""为 MV 引擎（mv/）准备一首歌的数据：lyrics.json、audio.json、song.json。不调用任何模型。

歌词: 对齐数据包（align_*.py 输出，逐字）+ 可选人工行首锚点（review.py 保存的 JSON，整行平移到锚点）
拍点: MIDI 速度表（Suno 导出的 MIDI 自带逐拍 tempo）
鼓点: 军鼓/踩镲取 Drums MIDI；底鼓 MIDI 漏得多，改用伴奏低频能量突变检测
包络: WAV 频谱分析（rms/low/mid/high），人声分轨 → vocal，伴奏分轨 → drums/bass/other

用法:
    python tools/make_mv_data.py --bundle raw.json --aligned aligned_mms.json [--anchors groundtruth.json] \
        --audio song.wav --vocals vocals.wav --accomp no_vocals.wav --midi MIDI目录 --cover cover.png --out mv/songs/solo
"""
import argparse
import json
import re
import shutil
import sys
from pathlib import Path

import mido
import numpy as np
import soundfile as sf
from pypinyin import Style, lazy_pinyin

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from align_local import HAN_RE, TAG_RE, parse_lyrics, read_midi_onsets  # noqa: E402

FPS = 100
SINGER_RE = re.compile(r"\[(Male|Female|Duet)\]", re.I)


# ---------- 歌词 ----------

def words_by_line(aligned_path):
    lines, cur = [], []
    for w in json.loads(Path(aligned_path).read_text(encoding="utf-8"))["aligned"]["aligned_words"]:
        cur.append(w)
        if w["word"].endswith("\n"):
            lines.append(cur)
            cur = []
    return lines


def line_meta(prompt):
    """每个歌词行的段落名与演唱者（按 parse_lyrics 同样的行序）。"""
    out, section, para = [], None, True
    for raw in prompt.splitlines():
        s = raw.strip()
        if TAG_RE.fullmatch(s):
            name = s[1:-1].split(":")[0].strip()
            if name.lower() not in ("male", "female", "duet", "end"):
                section = name
            continue
        if TAG_RE.sub("", s).strip():
            m = SINGER_RE.search(s)
            out.append({"section": section, "singer": m.group(1).lower() if m else None})
    return out


RHYME_GROUPS = [("ang", "iang", "uang"), ("an", "ian", "uan", "van"), ("ong", "iong"), ("eng", "ing", "ueng"),
                ("ou", "iu"), ("ao", "iao"), ("ai", "uai"), ("ei", "ui", "uei"), ("en", "in", "un", "vn", "uen"),
                ("a", "ia", "ua"), ("o", "uo", "e"), ("ie", "ve", "ue"), ("i",), ("u",), ("v",)]


def rhyme_key(text):
    hans = HAN_RE.findall(text)
    if not hans:
        return None
    f = lazy_pinyin(hans[-1], style=Style.FINALS, strict=False)[0].replace("ü", "v")
    return next((g[0] for g in RHYME_GROUPS if f in g), f)


def build_lyrics(prompt, aligned_path, anchors):
    parsed = parse_lyrics(prompt)
    meta = line_meta(prompt)
    wl = words_by_line(aligned_path)
    assert len(wl) == len(parsed) == len(meta), (len(wl), len(parsed), len(meta))
    lines = []
    for i, ws in enumerate(wl):
        shift = anchors[i] - float(ws[0]["start_s"]) if i in anchors else 0.0
        # sp: 该字后面有空格（中文歌词里空格是分句，排版要留空）
        words = [{"w": w["word"].strip(), "sp": w["word"].rstrip("\n") != w["word"].rstrip("\n").rstrip(),
                  "start": round(float(w["start_s"]) + shift, 3), "end": round(float(w["end_s"]) + shift, 3),
                  "conf": float(w.get("p_align", 1))} for w in ws]
        words = [w for w in words if w["w"]]
        words[-1]["sp"] = False
        # 人工锚点给出这一行的时间窗 [本行行首, 下一行行首)：模型只提供行内相对节奏，超出窗口就按比例压进去
        # （模型整行对错的地方，行内逐字也不可信，不压缩会伸进下一行）
        if i in anchors and i + 1 in anchors:
            t0, room = anchors[i], anchors[i + 1] - anchors[i] - 0.05
            span = words[-1]["end"] - t0
            if room > 0 and span > room:
                k = room / span
                for w in words:
                    w["start"] = round(t0 + (w["start"] - t0) * k, 3)
                    w["end"] = round(t0 + (w["end"] - t0) * k, 3)
        text = "".join(w["w"] + (" " if w["sp"] else "") for w in words)
        lines.append({"text": text, "start": words[0]["start"], "end": words[-1]["end"],
                      "words": words, **meta[i], "para": parsed[i]["para_start"], "anchored": i in anchors})
    # 逐字时间整理：单调、不重叠；字尾延到下一字开头（间隔 < 0.35s 时），行尾字至少 0.25s
    flat = [w for ln in lines for w in ln["words"]]
    for a, b in zip(flat, flat[1:]):
        b["start"] = max(b["start"], a["start"] + 0.01)
        a["end"] = b["start"] if 0 <= b["start"] - a["end"] < 0.35 else min(max(a["end"], a["start"] + 0.05), b["start"])
    for ln in lines:
        ln["words"][-1]["end"] = max(ln["words"][-1]["end"], ln["words"][-1]["start"] + 0.25)
        ln["start"], ln["end"] = ln["words"][0]["start"], ln["words"][-1]["end"]
    # 押韵尾字：同段内与前后两行任一行尾同韵
    keys = [rhyme_key(ln["text"]) for ln in lines]
    for i, ln in enumerate(lines):
        near = [keys[j] for j in range(max(0, i - 2), min(len(lines), i + 3))
                if j != i and lines[j]["section"] == ln["section"]]
        ln["rhyme"] = bool(keys[i] and keys[i] in near)
    return {"lines": lines}


# ---------- 音频 ----------

def midi_beats(midi_dir, duration):
    """逐拍时间：按 MIDI 的 tick 网格（每 ticks_per_beat 一拍）经 tempo 表换算成秒。"""
    path = next(Path(midi_dir).glob("*Vocals).mid"))
    read_midi_onsets(path)  # 装上非法调号兜底
    m = mido.MidiFile(path)
    tempos, tick = [], 0
    for msg in mido.merge_tracks(m.tracks):
        tick += msg.time
        if msg.type == "set_tempo":
            tempos.append((tick, msg.tempo))
    tempos = tempos or [(0, 500000)]
    beats, t, last_tick, tempo, k = [], 0.0, 0, 500000, 0
    for b in range(100000):
        bt = b * m.ticks_per_beat
        while k < len(tempos) and tempos[k][0] <= bt:
            t += mido.tick2second(tempos[k][0] - last_tick, m.ticks_per_beat, tempo)
            last_tick, tempo = tempos[k]
            k += 1
        sec = t + mido.tick2second(bt - last_tick, m.ticks_per_beat, tempo)
        if sec > duration:
            break
        beats.append(round(sec, 4))
    return beats


def midi_notes(path, pitches=None):
    read_midi_onsets(path)
    out, t = [], 0.0
    for msg in mido.MidiFile(path):
        t += msg.time
        if msg.type == "note_on" and msg.velocity and (pitches is None or msg.note in pitches):
            out.append((round(t, 4), msg.velocity / 127))
    return sorted(out)


def stft_bands(x, sr):
    hop, n = sr // FPS, 2048
    x = np.pad(x, (n // 2, n // 2))
    frames = np.lib.stride_tricks.sliding_window_view(x, n)[::hop]
    spec = np.abs(np.fft.rfft(frames * np.hanning(n), axis=1))
    f = np.fft.rfftfreq(n, 1 / sr)
    band = lambda lo, hi: spec[:, (f >= lo) & (f < hi)].mean(axis=1)
    return {"low": band(20, 150), "mid": band(150, 2000), "high": band(4000, 16000),
            "rms": np.sqrt((frames ** 2).mean(axis=1))}, spec, f


def norm01(v, smooth=3):
    v = np.convolve(v, np.ones(smooth) / smooth, "same") if smooth > 1 else v
    hi = np.percentile(v, 99) or 1
    return np.clip(v / hi, 0, 1)


def mono(path):
    x, sr = sf.read(str(path), dtype="float32", always_2d=True)
    return x.mean(axis=1), sr


def kick_onsets(accomp, sr, beats):
    """底鼓：伴奏低频（40–120Hz）能量正向突变的峰，限定在拍点 ±60ms 内（four-on-the-floor）。"""
    bands, spec, f = stft_bands(accomp, sr)
    low = spec[:, (f >= 40) & (f < 120)].sum(axis=1)
    flux = np.maximum(0, np.diff(np.log1p(low * 50), prepend=0))
    flux /= np.percentile(flux, 99.5) or 1
    out = []
    for b in beats:
        i0, i1 = int((b - 0.06) * FPS), int((b + 0.06) * FPS)
        if i0 < 0 or i1 >= len(flux):
            continue
        j = i0 + int(np.argmax(flux[i0:i1]))
        if flux[j] > 0.25:
            out.append((round(j / FPS, 3), round(float(min(1, flux[j])), 3)))
    return out


def build_audio(audio, vocals, accomp, midi_dir, sections_from):
    x, sr = mono(audio)
    duration = len(x) / sr
    bands, _, _ = stft_bands(x, sr)
    feats = {k: norm01(v) for k, v in bands.items()}
    if vocals:
        v, vsr = mono(vocals)
        feats["vocal"] = norm01(stft_bands(v, vsr)[0]["rms"], 5)
    if accomp:
        a, asr = mono(accomp)
        ab, _, _ = stft_bands(a, asr)
        feats["bass"], feats["other"], feats["drums"] = norm01(ab["low"]), norm01(ab["mid"]), norm01(ab["high"])
    n = min(len(v) for v in feats.values())
    beats = midi_beats(midi_dir, duration)
    drums = next(Path(midi_dir).glob("*Drums).mid"), None)
    onsets = {
        "kick": kick_onsets(a, asr, beats) if accomp else [],
        "snare": midi_notes(drums, {37, 38, 39, 40}) if drums else [],
        "hat": midi_notes(drums, {42, 44, 46}) if drums else [],
        "vocal": [(round(s, 4), 1.0) for s, _ in read_midi_onsets(next(Path(midi_dir).glob("*Vocals).mid")))],
    }
    bpm = 60 / float(np.median(np.diff(beats)))
    return {"duration": round(duration, 3), "bpm": round(bpm, 2), "fps": FPS, "beats": beats,
            "downbeats": beats[::4], "sections": sections_from(beats[::4], duration),
            "features": {k: [round(float(y), 3) for y in v[:n]] for k, v in feats.items()}, "onsets": onsets}


def sections_from_lyrics(lyrics):
    """段落起点 = 该段第一行起唱前最近的小节线（容 0.3s 的抢拍）；第一段从 0 开始。"""
    starts = []
    for ln in lyrics["lines"]:
        if not starts or ln["section"] != starts[-1][0]:
            starts.append((ln["section"] or "section", ln["start"]))

    def make(downbeats, duration):
        out = []
        for i, (name, t) in enumerate(starts):
            s = 0.0 if i == 0 else max([d for d in downbeats if d <= t + 0.3] or [t])
            out.append({"name": name, "start": round(s, 3)})
        for a, b in zip(out, out[1:] + [{"start": duration}]):
            a["end"] = round(b["start"], 3)
        return out
    return make


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--bundle", required=True)
    ap.add_argument("--aligned", required=True)
    ap.add_argument("--anchors")
    ap.add_argument("--audio", required=True)
    ap.add_argument("--vocals")
    ap.add_argument("--accomp")
    ap.add_argument("--midi", required=True)
    ap.add_argument("--cover")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    clip = json.loads(Path(args.bundle).read_text(encoding="utf-8"))["clip"]
    anchors = {}
    if args.anchors:
        anchors = {a["line"]: float(a["t"]) for a in json.loads(Path(args.anchors).read_text(encoding="utf-8"))["anchors"]}
    lyrics = build_lyrics(clip["metadata"]["prompt"], args.aligned, anchors)
    audio = build_audio(args.audio, args.vocals, args.accomp, args.midi, sections_from_lyrics(lyrics))

    (out / "lyrics.json").write_text(json.dumps(lyrics, ensure_ascii=False, indent=1), encoding="utf-8")
    (out / "audio.json").write_text(json.dumps(audio, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    ext = Path(args.audio).suffix
    shutil.copyfile(args.audio, out / f"audio{ext}")
    if args.cover:
        shutil.copyfile(args.cover, out / f"cover{Path(args.cover).suffix}")
    chars = sorted({c for ln in lyrics["lines"] for c in ln["text"]} | set(clip.get("title") or ""))
    song = {"id": clip["id"], "title": clip.get("title"), "artist": clip.get("display_name"),
            "audio": f"audio{ext}", "cover": f"cover{Path(args.cover).suffix}" if args.cover else None,
            "chars": "".join(chars), "tags": (clip.get("metadata") or {}).get("tags", "")}
    (out / "song.json").write_text(json.dumps(song, ensure_ascii=False, indent=1), encoding="utf-8")

    # 自检：拍点与鼓点的相位（军鼓应落在 2、4 拍）
    b = np.array(audio["beats"])
    ph = [(((t - b[max(0, np.searchsorted(b, t) - 1)]) / np.median(np.diff(b))) % 1) for t, _ in audio["onsets"]["snare"]]
    print(f"歌词 {len(lyrics['lines'])} 行（锚点校正 {len(anchors)} 行，押韵尾字 {sum(l['rhyme'] for l in lyrics['lines'])} 行）")
    print(f"拍点 {len(audio['beats'])}，BPM {audio['bpm']}；底鼓 {len(audio['onsets']['kick'])}，军鼓 {len(audio['onsets']['snare'])}，"
          f"踩镲 {len(audio['onsets']['hat'])}；军鼓相对拍点的相位中位数 {np.median(ph):.2f}（≈0 表示对齐拍点）")
    print("段落:", [(s["name"], s["start"]) for s in audio["sections"]])
    print("字符集:", len(song["chars"]), "个")


if __name__ == "__main__":
    main()
