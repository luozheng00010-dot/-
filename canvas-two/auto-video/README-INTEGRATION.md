# auto-video 自动剪辑模块

本模块基于开源项目 [MoneyPrinterTurbo](https://github.com/harry0703/MoneyPrinterTurbo) 整体引入，是本项目的**自动剪辑引擎子模块**（2026-09 起替代原先内嵌在 `server/src/video` 的 TypeScript 粗剪模块）。

## 架构

```
┌──────────────┐     /api/auto-video/*      ┌──────────────────────┐
│ 主界面(React)  │ ─────────────────────────→ │ 主服务(Node :3001)    │
│ /auto-video  │    serverApi + Cookie 鉴权   │ server/src/auto-video│
└──────────────┘                             └─────────┬────────────┘
                                                       │ HTTP 代理（undici）
                                                       ↓
                                             ┌──────────────────────┐
                                             │ 引擎(FastAPI :8080)   │
                                             │ auto-video/app       │
                                             │ + ffmpeg / uv venv   │
                                             └──────────────────────┘
```

- **前端**：`web/src/modules/auto-video/` 原生 React 工作台——建任务表单（主题/文案/AI 文案、比例、素材源、音色、语速、BGM、字幕、字体）、任务列表轮询（进度/失败原因）、成片预览与下载。服务未启动时顶部横幅提示。本地视频统一在自动剪辑的「本地素材库」子模块管理，剪辑通过单货号＋多分类选择候选池。
- **主服务**：`server/src/auto-video/routes.ts` 统一检查登录态，调用主站渠道生成文案和关键词，补齐任务文本后转发任务 CRUD、BGM 清单与上传。本地素材走独立的语义方案、预览确认与显式时间轴渲染，后台 worker 负责分析和匹配。音色清单读引擎的 `azure_voices.json`，字体清单读 `resource/fonts`；媒体预览支持 Range。引擎地址由 `AUTO_VIDEO_API_URL` 配置（默认 `http://127.0.0.1:8080`）。
- **引擎**：MoneyPrinterTurbo FastAPI 服务，负责配音、字幕、素材准备和合成。主站的文字模型在「自动剪辑 → 管理设置」选择主站已有渠道；视频素材供应商、配音及配乐服务仍在 `auto-video/config.toml` 配置。原版 WebUI/CLI 的文字模型仍读取引擎配置文件。

## 启动方式

### 0. 随主项目一键启动（推荐）

在 `canvas-two/` 根目录：

```bash
npm run install:all      # 仅首次
npm run dev              # 准备数据库后启动 web、server、worker、引擎
npm run dev:auto-video   # 只（重）启引擎
```

登录主界面 → 侧边栏「专业工具 → 自动剪辑」。

### 1. 单独运行引擎

```bash
cd auto-video
uv sync                  # 首次
uv run main.py           # http://127.0.0.1:8080/docs
```

> 前置依赖：本机需安装 ffmpeg 并加入 PATH。

### 2. 上游 Streamlit 完整控制台（可选）

React 工作台覆盖常用出片流程、BGM 上传和本地视频素材库；其他上游高级功能可在原版控制台使用（其素材列表不作为主站素材库）：

```bash
cd auto-video && uv run streamlit run webui/Main.py --server.port=8501
# Docker: docker compose up -d auto-video-webui
```

## 模型管理与主站工作流程（待验收）

- 管理入口 `/auto-video/admin`；`GET/PUT /api/auto-video/admin/settings` 仅管理员可用。选择主站启用的 OpenAI 兼容文字渠道和模型，保存到 `auto_video_settings`。API Key 沿用主站加密渠道配置，由主服务解密使用，不返回浏览器、不传入引擎任务。
- 主站 AI 文案和 AI 关键词直接使用该配置，不需要先启动 Python 引擎；实际出片需要引擎运行。首次需要管理员保存模型配置；已关闭或删除的渠道/模型会明确报错，不自动切换其他模型。
- 在线素材任务仍按需生成文案与关键词，并使用既有素材搜索及合成流程。
- 本地短素材流程改为：上传并分析／人工确认标签 → 输入原文 → 系统配音及真实时间对齐 → 同货号分类内语义检索 → 逐句预览、解决缺口与确认 → 按固定时间轴合成。没有匹配证据或时长不足时不会随机补片。
- 模型管理增加视觉分析、向量模型、文案／匹配三组配置；即使手填原文，本地语义匹配也需要文字和向量模型。供应商、TTS 与 BGM 仍使用引擎配置。
- 新增 `20260917020000_semantic_local_video` 迁移。完整部署步骤、接口、任务恢复、测试及人工验收见 [本地语义剪辑集成说明](SEMANTIC-LOCAL-VIDEO.md)。本次未运行迁移、构建或测试。

## 引擎运行约定

- 引擎是**独立进程**，崩溃/未启动不影响主应用；界面有健康状态徽标与横幅提示。
- 旧模块已全部移除：`server/src/video` 路由、前端 `web/src/modules/video-edit`、Prisma 8 张 `video_*` 表（迁移 `20260916020000_drop_autoedit_video_tables`，含建表→删表全序，新库可完整重放）。
- `config.toml`、`storage/`、`.venv/`、`__pycache__/` 均被 gitignore，不入库。
- 上游源码快照来自 `D:\自动剪辑\自动剪辑MoneyPrinterTurbo`（227 文件逐字节一致）；二次开发直接改本目录，勿再从 D 盘单向同步。
- `resource/fonts`（~140MB 字幕字体）与 `resource/songs`（~56MB BGM）为运行必需资源。

## 本地视频素材库（待验收）

- 本地素材库属于自动剪辑子模块，通过「自动剪辑 → 本地素材库」进入 `/auto-video/materials` 页面，接口为 `/api/local-materials`。共享货号和分类支持新增、改名、删除；货号全局唯一，分类全库共用，忽略首尾空格和 ASCII 大小写判重。
- 所有登录且已修改初始密码的成员可维护素材。上传必须选择一个货号和一个分类，支持批量逐文件上传和失败重试；只支持 MP4、MOV、AVI、FLV、MKV、WebM 视频，单文件 200 MB，不支持图片。
- PostgreSQL 保存货号、分类、文件名、文件键、大小、上传者、时间和删除状态；视频保持在引擎 `storage/local_videos` 中，以不可变 UUID 文件名存储。数据库和该目录都需持久保存。归类和改名不移动视频。
- `POST /api/local-materials/upload` 接受 `skuId`、`categoryId` 和 `file`；列表接受 `skuId`、逗号分隔的 `categoryIds`、货号 `search`、`page`、`pageSize`。`GET /available-categories?skuId=...` 返回该货号有素材的分类；`GET /:id/preview` 支持 Range 播放。`/skus`、`/categories` 支持 GET/POST，`/:id` 支持 PATCH/DELETE；素材 `PATCH /:id` 修改归类，`DELETE /:id` 逻辑删除。
- 本地任务通过 `/api/auto-video/plans` 创建，使用 `skuId` 与非空 `categoryIds`；旧 `/tasks` 的 local 请求返回 409，不能绕过预览。确认后服务端固定每个镜头的文件键、标注版本及源区间。原 `/api/auto-video/materials` 及其上传入口已移除。
- 引擎新增 `/api/v1/library-videos` 视频上传与 `/:file_key` Range 预览；其 DELETE 仅用于主服务入库失败的文件补偿清理。沿用引擎 API 的认证与本地网络部署约定，不把引擎直接暴露为主站公共接口。
- 正常删除仅退出素材池并解除货号分类关联，文件保留以保障已提交任务，本期不做磁盘回收。没有有效素材引用的货号或分类可以删除。原有未归类文件不自动导入、不删除。
- 开发启动沿用 `server` 的 `dev:prepare`，生成 Prisma Client 并同步结构；迁移部署需执行 `npm run prisma:migrate` 和 `npm run prisma:generate`，然后重启主服务与引擎。本次仅提供迁移和测试用例，未执行数据库迁移、构建或测试。
- 人工验收清单见 `docs/content/docs/progress/pending-test.mdx`；Node 用例为 `server/src/local-materials/routes.test.ts`，Python 用例为 `auto-video/test/services/test_library_videos.py`。
