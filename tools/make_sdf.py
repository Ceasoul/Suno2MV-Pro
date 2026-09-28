"""黑白剪影 PNG → 有符号距离场（SDF）纹理，给 L4 渲染用（刺绣针脚走向、鎏金浮雕斜面、霓虹发光都靠它）。

编码：8 位灰度，128 = 轮廓，>128 在图形内部，<128 在外部；每级 = SPREAD/127 像素（按原图 2048 计）。
同时检查素材是否符合"纯黑白"规格，并输出图形外框（归一化），方便场景构图。

用法:
    python tools/make_sdf.py 输入.png 输出目录 [--size 1024] [--spread 48]
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("src", nargs="+")
    ap.add_argument("out")
    ap.add_argument("--size", type=int, default=1024, help="输出边长（距离在原图分辨率上计算后再缩小）")
    ap.add_argument("--spread", type=float, default=48, help="编码的最大距离（原图像素）")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    meta = {}
    for src in map(Path, args.src):
        g = np.asarray(Image.open(src).convert("L"), dtype=np.float32)
        gray = ((g > 24) & (g < 232)).mean()  # 非纯黑白像素占比（抗锯齿边缘正常会有一点）
        ink = g < 128
        # 有符号距离：内部为正、外部为负（像素中心到边界）
        d = ndimage.distance_transform_edt(ink) - ndimage.distance_transform_edt(~ink)
        enc = np.clip(128 + d * (127 / args.spread), 0, 255).astype(np.uint8)
        img = Image.fromarray(enc).resize((args.size, args.size), Image.LANCZOS)
        name = src.stem + "_sdf.png"
        img.save(out / name, optimize=True)
        ys, xs = np.nonzero(ink)
        h, w = ink.shape
        box = [round(xs.min() / w, 4), round(ys.min() / h, 4), round((xs.max() + 1) / w, 4), round((ys.max() + 1) / h, 4)]
        meta[src.stem] = {"sdf": name, "spread": args.spread, "src": w, "box": box, "ink": round(float(ink.mean()), 4)}
        flag = "⚠ 灰度像素偏多，可能不是纯黑白" if gray > 0.02 else "OK"
        print(f"{src.name:22s} 图形占比 {ink.mean():.1%}  灰度像素 {gray:.2%}  外框 {box}  {flag}")
    (out / "sdf.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
    print(f"输出: {out}")


if __name__ == "__main__":
    main()
