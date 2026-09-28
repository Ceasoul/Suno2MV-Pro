"""本地歌词对齐：已知歌词 + 人声起音点序列 → 与 Suno 同格式的逐词数据包。不调用任何模型。

起音点来源（对齐算法与来源无关）:
    --midi   Suno 导出的人声 MIDI（Vocals.mid，或包含它的目录）

用法:
    python align_local.py --bundle aligned_<id>.json --midi "Projects/SOLO/MIDI"
    python suno_karaoke.py --aligned aligned_<id>_midi.json --audio song.wav

原理: 歌词拆成音节（汉字 1 个 = 1 音节，英文词按元音组计），与起音点序列做一次全局动态规划:
1 字对 1 音为主，允许拖腔（1 字多音）、合并（多字 1 音，说唱常见）、多余音符（和声/即兴）和漏唱。
换行信号用"字尾时长"（该字最后一个音到下一个起音的间隔，含长音和停顿）：Suno 的歌和声常年垫底、
行与行连唱，几乎没有静音，但行尾字通常是长音。行尾字尾长给奖励，行内字尾过长给惩罚。
整首一次求解，重复的副歌不会串位。
"""
import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

TAG_RE = re.compile(r"\[[^\]\n]*\]")
HAN_RE = re.compile(r"[㐀-鿿豈-﫿]")
WORD_RE = re.compile(r"[A-Za-z]+(?:'[A-Za-z]+)?|\d+")

# ---------- 代价参数（单位：无量纲，越小越好） ----------
MERGE_ONSET_MS = 40    # 间隔小于此值的起音视为同一个（和弦、对唱）
# 字尾时长 tail = 该字最后一个音的起点到下一个起音的间隔（秒）；按字后的边界类型计分
W_PARA_END = 2.0       # 段尾：每秒奖励，封顶 4 秒（段落间常有长间奏）
W_LINE_END = 2.0       # 行尾：每秒奖励，封顶 1.2 秒
W_PAUSE_END = 1.0      # 行内空格/标点处：每秒奖励，封顶 0.8 秒
TAIL_OK = 0.6          # 行内普通字允许的字尾时长
W_LONG_TAIL = 2.0      # 行内普通字超出 TAIL_OK 的部分每秒罚分
W_SIL_IN_UNIT = 4.0    # 一个音节跨越静音（拖腔跨气口）每秒罚分
C_MELISMA = 0.6        # 1 字多音：每多一个音
C_MERGE = 0.9          # 多字 1 音：每多一个字
C_SKIP_ONSET = 0.8     # 丢弃一个音符（和声、即兴、转录噪声）
C_SKIP_SHORT = 0.3     # 丢弃一个极短音符（< 80ms）
C_SKIP_SYL = 2.5       # 漏掉一个音节（歌词没唱或 MIDI 没转出）
MAX_MELISMA = 4
MAX_MERGE = 3
# 人工锚点（review.py 导出）：人按键通常比真实起唱晚 0.1–0.25 秒，窗口向前放宽
ANCHOR_EARLY, ANCHOR_LATE = 0.45, 0.25
C_ANCHOR_MISS = 1000.0  # 违反人工锚点 ≈ 硬约束
W_MODEL_ANCHOR = 12.0   # 模型锚点（带 score）是软约束：违反代价 = 此值 × 置信度
W_ANCHOR_DIST = 2.0     # 窗口内离锚点越远越贵（秒）


# ---------- 歌词 → 音节 ----------

def syllables(word):
    """英文词的音节数：元音组计数，去掉词尾不发音的 e。"""
    if word.isdigit():
        return len(word)
    w = word.lower()
    n = len(re.findall(r"[aeiouy]+", w))
    if w.endswith("e") and not w.endswith(("le", "ee")) and n > 1:
        n -= 1
    return max(n, 1)


def parse_lyrics(prompt):
    """返回行列表，每行 {tokens:[[显示文本, 音节数, 前面是否有停顿]], para_start}。

    显示文本带上后随的标点和空格；空行或 [段落] 标签之后的第一行记为段首。
    """
    lines, para = [], True
    for raw in (prompt or "").splitlines():
        if TAG_RE.fullmatch(raw.strip()):
            para = True
            continue
        text = TAG_RE.sub("", raw).strip()
        if not text:
            para = True
            continue
        tokens, pos, pending, pause = [], 0, "", False
        for m in re.finditer(f"{HAN_RE.pattern}|{WORD_RE.pattern}", text):
            gap = text[pos:m.start()]
            if tokens:
                tokens[-1][0] += gap
            else:
                pending = gap.strip()  # 行首标点（罕见）并到第一个字
            pause = bool(tokens) and bool(gap.strip() or gap.isspace())
            tok = m.group(0)
            n = 1 if HAN_RE.fullmatch(tok) else syllables(tok)
            tokens.append([pending + tok, n, pause])
            pending, pos = "", m.end()
        if tokens:
            tokens[-1][0] += text[pos:]
            lines.append({"tokens": tokens, "para_start": para})
            para = False
    return lines


# ---------- 起音点来源：MIDI ----------

def find_vocal_midi(path):
    p = Path(path)
    if p.is_file():
        return p
    cands = [f for f in p.glob("*.mid") if "vocal" in f.name.lower() and "backing" not in f.name.lower()]
    if not cands:
        sys.exit(f"目录里没找到人声 MIDI（文件名含 Vocals）：{p}")
    return cands[0]


def read_midi_onsets(path):
    """读人声 MIDI，合并所有轨道，返回按时间排序的 [(start, end)]（秒）。"""
    import mido
    from mido.midifiles import meta

    # Suno 导出的 MIDI 带非法调号（如 13 个升号），mido 默认直接报错；调号与对齐无关，兜底忽略
    spec = meta.MetaSpec_key_signature
    if not getattr(spec, "_lenient", False):
        orig = spec.decode

        def decode(self, msg, data):
            try:
                orig(self, msg, data)
            except Exception:
                msg.key = "C"
        spec.decode, spec._lenient = decode, True

    notes, active, t = [], defaultdict(list), 0.0
    for msg in mido.MidiFile(path):  # 迭代时 mido 已按 tempo 表把 delta 换成秒
        t += msg.time
        if msg.type == "note_on" and msg.velocity > 0:
            active[(msg.channel, msg.note)].append(t)
        elif msg.type in ("note_off", "note_on") and active[(msg.channel, msg.note)]:
            notes.append((active[(msg.channel, msg.note)].pop(0), t))
    notes.sort()
    onsets = []
    for s, e in notes:
        if onsets and s - onsets[-1][0] < MERGE_ONSET_MS / 1000:
            onsets[-1][1] = max(onsets[-1][1], e)
        else:
            onsets.append([s, e])
    return [(s, max(e, s + 0.02)) for s, e in onsets]


# ---------- 动态规划对齐 ----------

def align(lines, onsets, anchors=None):
    """音节序列 ↔ 起音点序列 全局对齐。返回每个音节的 (op, 第一个音符, 音符数, 合并组内序号, 组大小)。

    anchors: {行号: (秒, 违反代价)}，该行首字应落在锚点附近的音符上。
    """
    anchors = anchors or {}
    anchor_at = {}  # 音节序号 → 锚点时间
    syl = []  # (行首?, 字后边界类型 para/line/pause/none)
    for li, ln in enumerate(lines):
        toks = ln["tokens"]
        for ti, (_, n, _) in enumerate(toks):
            for si in range(n):
                if si < n - 1:
                    after = "none"
                elif ti == len(toks) - 1:
                    after = "para" if li == len(lines) - 1 or lines[li + 1]["para_start"] else "line"
                else:
                    after = "pause" if toks[ti + 1][2] else "none"
                if ti == 0 and si == 0 and li in anchors:
                    anchor_at[len(syl)] = anchors[li]
                syl.append((ti == 0 and si == 0, after))
    n, m = len(syl), len(onsets)
    sil = [onsets[0][0]] + [max(0.0, onsets[j][0] - onsets[j - 1][1]) for j in range(1, m)]
    tail = [onsets[j + 1][0] - onsets[j][0] for j in range(m - 1)] + [4.0]
    short = [e - s < 0.08 for s, e in onsets]

    def tail_cost(k, j):
        t, after = tail[j], syl[k][1]
        if after == "para":
            return -W_PARA_END * min(t, 4.0)
        if after == "line":
            return -W_LINE_END * min(t, 1.2)
        if after == "pause":
            return -W_PAUSE_END * min(t, 0.8)
        return W_LONG_TAIL * max(0.0, t - TAIL_OK)

    def anchor_cost(k, j):
        if k not in anchor_at:
            return 0.0
        t, miss = anchor_at[k]
        d = onsets[j][0] - t
        if -ANCHOR_EARLY <= d <= ANCHOR_LATE:
            return W_ANCHOR_DIST * abs(d)
        return miss

    INF = float("inf")
    cost = [[INF] * (m + 1) for _ in range(n + 1)]
    back = [[None] * (m + 1) for _ in range(n + 1)]
    cost[0][0] = 0.0
    for k in range(n + 1):
        row = cost[k]
        for j in range(m + 1):
            c = row[j]
            if c == INF:
                continue
            if j < m:  # 丢弃音符 j
                nc = c + (C_SKIP_SHORT if short[j] else C_SKIP_ONSET)
                if nc < row[j + 1]:
                    row[j + 1], back[k][j + 1] = nc, ("skip_onset", k, j)
            if k == n:
                continue
            nc = c + C_SKIP_SYL + (anchor_at[k][1] if k in anchor_at else 0.0)  # 漏掉音节 k
            if nc < cost[k + 1][j]:
                cost[k + 1][j], back[k + 1][j] = nc, ("skip_syl", k, j)
            if j == m:
                continue
            c += anchor_cost(k, j)
            span = 0.0
            for L in range(1, min(MAX_MELISMA, m - j) + 1):  # 音节 k 占 L 个音符
                if L > 1:
                    span += W_SIL_IN_UNIT * max(0.0, sil[j + L - 1] - 0.1)
                nc = c + C_MELISMA * (L - 1) + span + tail_cost(k, j + L - 1)
                if nc < cost[k + 1][j + L]:
                    cost[k + 1][j + L], back[k + 1][j + L] = nc, ("sing", k, j, L)
            for K in range(2, min(MAX_MERGE, n - k) + 1):  # K 个音节共用音符 j（不跨行）
                if syl[k + K - 1][0]:
                    break
                nc = c + C_MERGE * (K - 1) + tail_cost(k + K - 1, j)
                if nc < cost[k + K][j + 1]:
                    cost[k + K][j + 1], back[k + K][j + 1] = nc, ("merge", k, j, K)

    ops, k, j = [None] * n, n, m
    while (k, j) != (0, 0):
        b = back[k][j]
        if b[0] == "sing":
            ops[b[1]] = ("sing", b[2], b[3], 0, 1)
        elif b[0] == "merge":
            for q in range(b[3]):
                ops[b[1] + q] = ("merge", b[2], 1, q, b[3])
        elif b[0] == "skip_syl":
            ops[b[1]] = ("skip", b[2], 0, 0, 1)
        k, j = b[1], b[2]
    return ops, cost[n][m]


# ---------- 输出 ----------

def syllable_times(ops, onsets):
    times = []
    for op, j, L, q, K in ops:
        if op == "skip":
            times.append(None)
            continue
        s, e = onsets[j][0], onsets[j + L - 1][1]
        if op == "merge":
            d = (e - s) / K
            s, e = s + q * d, s + (q + 1) * d
        times.append([s, e])
    # 漏唱的音节：夹在前后音节之间，给零长度
    for i, t in enumerate(times):
        if t is None:
            prev = next((times[p][1] for p in range(i - 1, -1, -1) if times[p]), 0.0)
            times[i] = [prev, prev]
    return times


def build_words(lines, ops, times):
    words, k = [], 0
    for ln in lines:
        for ti, (text, n, _) in enumerate(ln["tokens"]):
            seg, sop = times[k:k + n], [o[0] for o in ops[k:k + n]]
            k += n
            p = 0.0 if "skip" in sop else (1.0 if all(o == "sing" for o in sop) else 0.7)
            words.append({"word": text + ("\n" if ti == len(ln["tokens"]) - 1 else ""),
                          "start_s": round(seg[0][0], 3), "end_s": round(seg[-1][1], 3),
                          "success": "skip" not in sop, "p_align": p})
    # 结束时间不越过下一个字的开始；避免零长度
    for a, b in zip(words, words[1:]):
        a["end_s"] = min(a["end_s"], b["start_s"])
    for w in words:
        w["end_s"] = max(w["end_s"], w["start_s"] + 0.05)
    return words


def fmt(t):
    return f"{int(t // 60)}:{t % 60:05.2f}"


def report(lines, ops, times, onsets, total_cost, anchors=None):
    used = {j + x for op, j, L, _, _ in ops if op != "skip" for x in range(L)}
    cnt = Counter(o[0] for o in ops)
    melisma = sum(1 for o in ops if o[0] == "sing" and o[2] > 1)
    out = [f"音节 {len(ops)}，起音点 {len(onsets)}，用到 {len(used)}，丢弃 {len(onsets) - len(used)}",
           f"1对1 {cnt['sing'] - melisma}，拖腔 {melisma}，合并 {cnt['merge']}，漏唱 {cnt['skip']}，总代价 {total_cost:.1f}",
           "", "行号  开始      结束      标记            歌词"]
    k, rows = 0, []
    for i, ln in enumerate(lines):
        n = sum(t[1] for t in ln["tokens"])
        o, t = ops[k:k + n], times[k:k + n]
        k += n
        flags = []
        for name, test in (("拖", lambda x: x[0] == "sing" and x[2] > 1), ("并", lambda x: x[0] == "merge"),
                           ("漏", lambda x: x[0] == "skip")):
            c = sum(1 for x in o if test(x))
            if c:
                flags.append(f"{name}{c}")
        if anchors and i in anchors:
            flags.append(f"⚓{t[0][0] - anchors[i][0]:+.2f}")
        text = "".join(tok[0] for tok in ln["tokens"])
        rows.append((text, t))
        mark = "¶" if ln["para_start"] else " "
        out.append(f"{mark}{i + 1:3d}  {fmt(t[0][0]):>8}  {fmt(t[-1][1]):>8}  {' '.join(flags):<14}  {text}")
    # 自检：同一句歌词重复出现时，行内节奏（各音节相对行首的时间）应基本一致
    groups = defaultdict(list)
    for text, t in rows:
        groups[text].append([s - t[0][0] for s, _ in t])
    worst = []
    for text, pats in groups.items():
        if len(pats) > 1:
            dev = max(abs(a - b) for p in pats[1:] for a, b in zip(pats[0], p))
            worst.append((dev, len(pats), text))
    worst.sort(reverse=True)
    out += ["", "重复句节奏一致性（最大偏差秒，越小越好；> 0.3 值得人工检查）:"]
    out += [f"  {d:5.2f}  ×{c}  {t}" for d, c, t in worst]
    return "\n".join(out)


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description="已知歌词 + 人声 MIDI → 逐词时间戳（不调用任何模型）")
    ap.add_argument("--bundle", required=True, help="篡改猴导出的 JSON（取 id、clip 和歌词）")
    ap.add_argument("--midi", required=True, help="人声 MIDI 文件，或包含 *Vocals*.mid 的目录")
    ap.add_argument("--anchors", help="review.py 导出的 review_<id>.json：人工标的行首时刻")
    ap.add_argument("--out", help="输出数据包路径，默认与 bundle 同目录的 aligned_<id>_midi.json")
    args = ap.parse_args()

    bundle = json.loads(Path(args.bundle).read_text(encoding="utf-8"))
    song_id, clip = bundle["id"], bundle["clip"]
    lines = parse_lyrics((clip.get("metadata") or {}).get("prompt", ""))
    midi = find_vocal_midi(args.midi)
    onsets = read_midi_onsets(midi)
    print(f"歌词 {len(lines)} 行；MIDI {midi.name}：{len(onsets)} 个起音点")

    anchors = {}
    if args.anchors:
        for a in json.loads(Path(args.anchors).read_text(encoding="utf-8")).get("anchors", []):
            li = a["line"]
            text = "".join(t[0] for t in lines[li]["tokens"]) if 0 <= li < len(lines) else None
            if text is None or (a.get("text") and a["text"].strip() != text.strip()):
                print(f"忽略锚点：第 {li + 1} 行文本对不上（{a.get('text')}）")
                continue
            miss = W_MODEL_ANCHOR * float(a["score"]) if "score" in a else C_ANCHOR_MISS
            anchors[li] = (float(a["t"]), miss)
        print(f"锚点 {len(anchors)} 个")

    ops, total = align(lines, onsets, anchors)
    times = syllable_times(ops, onsets)
    words = build_words(lines, ops, times)

    out = Path(args.out) if args.out else Path(args.bundle).with_name(f"aligned_{song_id}_midi.json")
    aligned = {"aligned_words": words, "source": "local-midi" + ("+anchors" if anchors else ""), "midi": midi.name}
    out.write_text(json.dumps({"id": song_id, "clip": clip, "aligned": aligned},
                              ensure_ascii=False, indent=2), encoding="utf-8")
    rep = report(lines, ops, times, onsets, total, anchors)
    out.with_suffix(".report.txt").write_text(rep + "\n", encoding="utf-8")
    print(rep)
    print(f"\n数据包: {out}\n报告:   {out.with_suffix('.report.txt')}")


if __name__ == "__main__":
    main()
