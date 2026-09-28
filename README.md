# Suno2MV Pro · 词影

把 Suno 歌曲做成**逐字同步的歌词 MV**：歌词对齐 → 人工核对 → 动态歌词 / 段落画面 → 1080p MP4。全部在本机运行。

Turn Suno songs into word-synced lyric videos, locally: align lyrics, review them by ear, then render kinetic-typography or image-based MVs.

- **零模型路线**：Suno 导出的人声 MIDI + 人工行首锚点，不调用任何模型
- **模型路线**：MMS_FA 强制对齐（GPU 约 10 秒/首），实测两首歌 116 行中 99 行行首误差 ≤0.3 秒
- **核对页**：音轨波形 + 歌词时间轴，边听边标行首、标漏唱，自动保存
- **词影 MV 工作台**：卡拉OK字幕、文字 PV（动态排版）、逐段画面（上传或 AI 生成，统一命名规则）、实时预览、一键导出

## 目录

| 路径 | 作用 |
|---|---|
| `tools/fetch_bundle.py` | 从 Suno 链接取标题、歌词、风格、封面（公开接口，无需登录） |
| `align_local.py` | 纯 MIDI 对齐（零模型），支持人工锚点 |
| `align_mms.py` / `align_whisper.py` | 模型对齐（torchaudio MMS_FA / Whisper） |
| `review.py` | 对齐核对页（本地网页） |
| `tools/eval_lines.py` | 用人工标注给对齐结果打分 |
| `tools/make_mv_data.py`、`tools/subset_fonts.py` | 为 MV 引擎准备一首歌的数据与中文字体子集 |
| `tools/make_sdf.py` | 黑白剪影 → 距离场纹理（L4 渲染用） |
| `suno_karaoke.py` | 最早的 v1：Suno 逐词数据 → ASS 字幕 → ffmpeg 出片 |
| `tools/*.user.js`、`tools/get_aligned.js` | 在 suno.com 页面里导出 Suno 自带的逐词数据（需登录自己的账号） |
| `mv/` | MV 引擎与「词影」工作台（three.js + Vite），见 [`mv/README.md`](mv/README.md) |
| `RoadMap.md` | 路线图与评估结论 |

## 安装

- Python 3.10–3.12，`pip install -r requirements.txt`
- 模型对齐另需：PyTorch（CUDA 版）+ torchaudio、`pypinyin`、`demucs`（分离人声），Whisper 路线需 `stable-ts`
- ffmpeg（带 libass）：Windows `winget install Gyan.FFmpeg`，macOS `brew install ffmpeg`
- MV 引擎：[bun](https://bun.sh) 与 Node 20+，`cd mv && bun install`

## 流程

```bash
# 1. 取歌曲数据（歌词、封面）
python tools/fetch_bundle.py https://suno.com/song/<id> --out Projects/<歌名>
# 2. 音频：在 Suno 官方下载 WAV/MP3（和 MIDI）放进 Projects/<歌名>/；分离人声
python -m demucs -n htdemucs_ft --two-stems vocals -o Projects/<歌名>/stems <song.wav>
# 3. 对齐（二选一，或都跑）
python align_local.py --bundle <bundle.json> --midi Projects/<歌名>/MIDI
python align_mms.py   --bundle <bundle.json> --audio <vocals.wav>
# 4. 核对：边听边标行首，自动保存 review_<id>.json；可用 --anchors 回灌给 align_local.py
python review.py --aligned <aligned.json> --audio <song.wav> --wave <vocals.wav>
# 5. MV：准备数据 → 打开工作台 → 导出（见 mv/README.md）
python tools/make_mv_data.py ... --out mv/songs/<id> && python tools/subset_fonts.py mv/songs/<id>
```

## 图片命名规则

段落画面统一命名为 `序号-段落-镜头.png`，例如 `4-Pre-Chorus 1-1.png`：序号为全曲第几张（按时间顺序），段落名重复出现时加第几次（`Chorus 2`），镜头为该段第几张。按规则命名的图片可在工作台里一次性导入并自动分配到段落。

## 致谢与第三方许可

- MV 引擎基于 [mexicat/pdoom-video](https://github.com/mexicat/pdoom-video)（MIT，见 `mv/LICENSE-pdoom-video`）
- 字体：Archivo、Cormorant（`mv/public/fonts/`）、Noto Sans SC / Noto Serif SC / 马善政（按歌曲子集化），均为 SIL OFL
- 对齐模型：torchaudio MMS_FA、OpenAI Whisper（经 stable-ts）

## 声明

- 本项目与 Suno 无关。`fetch_bundle.py` 与页面脚本使用 Suno 网页的**非公开接口**，可能随时失效，也可能不符合 Suno 服务条款；请只处理**你自己的作品**，风险自负。
- **不解密 Suno 的音频**：请用 Suno 官方下载功能获取音频文件。
- 请勿把本项目改造成使用他人账号或账号池的在线服务。
- 仓库不包含任何歌曲、歌词、封面或生成图片。

## License

MIT
