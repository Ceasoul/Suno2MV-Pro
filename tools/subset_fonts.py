"""按一首歌实际用到的字，把中文字体切成小文件（整套中文字体每个字重 10–25MB，页面加载太慢）。

变体字体先实例化成固定字重（Canvas2D 取不到变体轴），再子集化到"歌词字符 + ASCII + 常用标点"。
字体均为 SIL OFL，可商用、可随作品分发（附 OFL.txt）。

用法:
    python tools/subset_fonts.py mv/songs/solo
"""
import json
import shutil
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

SRC = Path(__file__).resolve().parent.parent / "mv" / "fonts-src"
# 输出文件名 → (源文件, 字重；None 表示静态字体)
FACES = {
    "sans-500.ttf": ("NotoSansSC[wght].ttf", 500),
    "sans-900.ttf": ("NotoSansSC[wght].ttf", 900),
    "serif-600.ttf": ("NotoSerifSC[wght].ttf", 600),
    "serif-900.ttf": ("NotoSerifSC[wght].ttf", 900),
    "brush.ttf": ("MaShanZheng-Regular.ttf", None),
}
EXTRA = "".join(chr(c) for c in range(0x20, 0x7F)) + "，。！？、：；“”‘’（）《》——…·「」『』"


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    song = Path(sys.argv[1])
    chars = json.loads((song / "song.json").read_text(encoding="utf-8"))["chars"] + EXTRA
    out = song / "fonts"
    out.mkdir(exist_ok=True)
    for name, (src, wght) in FACES.items():
        f = TTFont(SRC / src)
        if wght is not None:
            f = instancer.instantiateVariableFont(f, {"wght": wght})
        opts = subset.Options()
        opts.layout_features = ["*"]
        opts.name_IDs = ["*"]
        opts.notdef_outline = True
        s = subset.Subsetter(opts)
        s.populate(text=chars)
        s.subset(f)
        f.save(out / name)
        missing = [c for c in set(chars) if c.strip() and ord(c) not in f.getBestCmap()]
        print(f"{name:14s} {(out / name).stat().st_size // 1024:5d} KB  缺字 {''.join(sorted(missing)) or '无'}")
    shutil.copyfile(SRC / "OFL.txt", out / "OFL.txt")


if __name__ == "__main__":
    main()
