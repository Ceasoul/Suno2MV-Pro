# mv/ — L1 动态歌词 MV 引擎

基于 [mexicat/pdoom-video](https://github.com/mexicat/pdoom-video) 的引擎部分（MIT，见 `LICENSE-pdoom-video`），three.js + Vite。
每一帧都只由歌曲时间决定：浏览器里实时预览的画面，与离线导出的视频完全一致。

## 一首歌的数据（`songs/<id>/`）

```bash
# 1. 歌词/节拍/鼓点/包络（零模型）
python tools/make_mv_data.py --bundle <raw.json> --aligned <aligned_mms.json> --anchors <人工行首.json> \
  --audio <song.wav> --vocals <vocals.wav> --accomp <no_vocals.wav> --midi <MIDI目录> --cover <封面> --out mv/songs/<id>
# 2. 中文字体子集（只含这首歌用到的字，每个字重约 150KB）
#    源字体先下载到 mv/fonts-src/（均为 SIL OFL，来自 github.com/google/fonts）：
#    ofl/notosanssc/NotoSansSC[wght].ttf、ofl/notoserifsc/NotoSerifSC[wght].ttf、ofl/mashanzheng/MaShanZheng-Regular.ttf、ofl/notosanssc/OFL.txt
python tools/subset_fonts.py mv/songs/<id>
# 3. （可选）songs/<id>/mv.json：标题卡、字幕样式、各段落用哪个场景和风格包
```

## 预览与导出

```bash
cd mv && bun install
node_modules/.bin/vite --port 5190          # 浏览器打开 http://localhost:5190/?song=<id>
node scripts/render-node.ts video --song <id> --fps 30 --crf 20 --out ../output/mv/<name>.mp4
```

预览快捷键：空格播放，←/→ 跳 1 秒（Shift 跳 5 秒），`[` `]` 跳到上/下一个段落。

## 编辑器（参照 suno.bi）

打开 http://localhost:5190/editor.html?song=<id>：左侧实时预览，右侧 分镜画面 / 字幕样式 / 文字 PV / 编辑信息，底部段落时间轴。
任何改动实时生效并自动保存到 `songs/<id>/mv.json`；上传或 AI 生成的图片存在 `songs/<id>/images/`；「导出视频」输出到 `output/mv/`。

AI 生成段落画面：在项目根目录 `.env` 写 `OPENAI_API_KEY=...`（可选 `OPENAI_BASE_URL`、`IMAGE_MODEL`、`IMAGE_SIZE`，见 `.env.example`），重启开发服务器。Key 只在本机服务端使用，不会发到浏览器。

## 图片命名规则

段落画面统一命名为 `序号-段落-镜头.png`，例如 `4-Pre-Chorus 1-1.png`：
- 序号：全曲第几张（按时间顺序，从 1 开始）
- 段落：段落名；重复出现的段落加第几次（`Pre-Chorus 1`、`Chorus 2`），本身带数字的不变（`Verse 1`）
- 镜头：该段第几张

自己准备或用外部工具生成的图，按这个规则命名后在编辑器里「按规则导入」即可自动分配；程序生成、上传的图片也会被统一重命名到这个规则。编辑器的「导出生图清单」会列出每张图的文件名和提示词。

## 构成

| 文件 | 作用 |
|---|---|
| `src/config.ts` | 字幕样式（suno.bi 同款设置项）与文字 PV 风格包 |
| `src/karaoke.ts` | 全局卡拉OK字幕层：逐字出现，未唱淡、在唱蓝、已唱白，押韵尾字高亮 |
| `src/scenes/cover.ts` | 封面背景：慢推拉、底鼓脉冲、标题卡 |
| `src/scenes/textpv.ts` | 文字 PV：6 种布局（相邻不重复）、进出场动画、滚动歌词底纹、底鼓驱动色差/震屏 |
| `src/timeline.ts` | 按段落生成时间线：副歌用文字 PV，其余用封面加字幕 |
| `src/engine/` | pdoom 引擎（改动：全局叠加层挂点、按歌曲加载数据、中文字体、两个中文 bug） |
