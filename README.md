# FFmpeg Remote UI

一个面向 Linux 服务器 / NAS 的 Web FFmpeg 控制台。

名字里的 remote 是字面意思：浏览器只是一块远程界面，媒体文件、`ffprobe`、`ffmpeg`、
GPU 与任务队列全部位于运行程序的服务器上；浏览器既不转码，也不要求上传服务器
已有的媒体。

## 设计要点

完整原则见 [PHILOSOPHY.md](PHILOSOPHY.md)，落到代码里是这几条：

- **FFmpeg 是能力的唯一事实来源。** 编码器、解码器、滤镜、封装/解封装格式、
  码流滤镜、协议、设备、像素与采样格式、声道布局、颜色、流处置、硬件加速方法，
  以及每个组件的可调参数、取值、默认值与取值范围，全部来自运行时查询
  （`ffmpeg -encoders`、`ffmpeg -h encoder=…` …）。代码里没有任何内置能力表，
  所以服务器上的 FFmpeg 升级后，界面自动跟着变。
- **零第三方 Go 依赖。** 路由用标准库 `net/http`（Go 1.22+ 的方法与通配模式），
  实时推送用 `text/event-stream`（SSE），队列与取消用 `context`。没有 Web 框架、
  没有 ORM、没有 WebSocket 库。
- **单一二进制。** 前端构建产物通过 `go:embed` 嵌进可执行文件，运行时只需要
  程序本身加上服务器上的 FFmpeg/FFprobe。
- **默认不需要配置。** 默认监听 `127.0.0.1:0`（系统分配端口），FFmpeg/FFprobe
  从 `PATH` 自动发现；只有要覆盖时才用环境变量。

## 架构

```
cmd/ffmpeg-remote-ui  入口：环境变量、优雅关闭、嵌入式前端
internal/ffmpeg     FFmpeg/FFprobe 查询与解析（能力快照、-h 结构、ffprobe）
internal/queue      并发受限的任务队列（状态机、进度、日志、事件广播）
internal/server     HTTP 层（路由、SSE 事件流、文件浏览、静态资源）
internal/hardware   Linux DRM render node 发现（只读 sysfs，不推断能力）
frontend            React 前端（无 UI 组件库、无 CSS 框架）
```

### 后端

- 能力快照的十几种查询并发执行，启动耗时取决于最慢的一条，而不是它们的总和。
- 任务队列有并发上限（`FFMPEG_REMOTE_UI_MAX_CONCURRENT_JOBS`，默认 1）、排队位置、
  取消 / 重试 / 删除 / 清理，以及每个任务 400 行的滚动日志。
- 进度来自 `ffmpeg -progress pipe:1`：`out_time_us`、`frame`、`fps`、`speed`、
  `bitrate`、`total_size`。ffmpeg 自己报不出时长时（例如 `-re` 限速）界面显示
  「进行中」，不会假装停在 0%。
- `/api/events` 是一条 SSE 流：连接时先补一份全量任务快照，之后推送增量的
  `job` 与 `log` 事件；断线由浏览器自动重连，重连后状态仍然收敛。
- 路径校验会清理路径并解析符号链接（包括对尚不存在路径的最近存在祖先），
  避免通过链接跳出媒体根目录。

### 前端

- React 19 + TypeScript + Vite，**不使用任何 UI 组件库或 CSS 框架**，样式由
  CSS Modules 手写。
- 颜色用 `oklch` 并以 `light-dark()` 给出深浅两套值，浏览器按 `color-scheme`
  自动选择——不需要主题类名，也不需要两份样式表。
- 布局意图一律用**逻辑属性**表达：`inline-size` / `block-size`、
  `padding-inline`、`border-inline-end`、`overflow-block`、`inset-block-start` 等。
- **分栏是自适应的**：竖屏（或窗口过窄）时各区域是卡片，纵向堆叠成一条整体
  滚动的文档流；横屏且够宽时变成并列分栏，每栏各自纵向滚动、标题吸顶。两种
  形态是同一份 DOM，只由方向媒体查询切换。
- 参数构建器与手写 argv 双模式：前者从服务器真实能力生成表单，后者直接写
  命令行；`shellQuote` 与 `SplitArgs` 在前端和后端是同一套规则，因此预览到的
  命令与实际执行的一致。

## 构建

需要 Go 1.26.x 与 Node.js：

```bash
./build.sh
```

脚本会构建前端、把 `frontend/dist` 复制到 `cmd/ffmpeg-remote-ui/web`、跑 `go vet`
与 `go test`，最后产出 `./ffmpeg-remote-ui`。

前端依赖（均为当前稳定版）：

| 包 | 版本 |
| --- | --- |
| react / react-dom | 19.3.0 |
| vite | 8.3.0 |
| @vitejs/plugin-react | 6.1.1 |
| typescript | 7.0.2 |
| @types/node | 26.5.1 |

## 运行

```bash
./ffmpeg-remote-ui
```

终端会打印实际监听地址与生效的媒体目录。环境变量都有合理默认值，并统一带
`FFMPEG_REMOTE_UI_` 前缀，避免和同机其它服务（尤其是 `HTTP_ADDR` 这类泛名）撞车：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `FFMPEG_REMOTE_UI_HTTP_ADDR` | `127.0.0.1:0` | 监听地址；`:0` 表示由系统分配端口 |
| `FFMPEG_REMOTE_UI_MEDIA_ROOTS` | 空 | 允许访问的媒体根目录，用 `:` 分隔；留空表示不限制 |
| `FFMPEG_REMOTE_UI_FFMPEG_PATH` | `ffmpeg` | 从 `PATH` 查找 |
| `FFMPEG_REMOTE_UI_FFPROBE_PATH` | `ffprobe` | 从 `PATH` 查找 |
| `FFMPEG_REMOTE_UI_MAX_CONCURRENT_JOBS` | `1` | 同时运行的 ffmpeg 进程数 |

例如：

```bash
FFMPEG_REMOTE_UI_HTTP_ADDR=:8090 \
FFMPEG_REMOTE_UI_MEDIA_ROOTS=/data/media:/mnt/media \
FFMPEG_REMOTE_UI_MAX_CONCURRENT_JOBS=2 \
  ./ffmpeg-remote-ui
```

## 开发

```bash
cd frontend
npm install
npm run typecheck
API_TARGET=http://127.0.0.1:8090 npm run dev   # 后端另行启动在 8090
```

`API_TARGET` 属于前端工具链（只被 `vite.config.ts` 的 dev 代理读取），
所以没有加 `FFMPEG_REMOTE_UI_` 前缀。

## 接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 运行状态、Go 版本、并发上限、生效的媒体目录 |
| GET | `/api/ffmpeg` | FFmpeg 能力快照 |
| POST | `/api/ffmpeg/refresh` | 重新查询能力（换过 FFmpeg 版本后） |
| GET | `/api/ffmpeg/help?target=&name=` | `ffmpeg -h` 的结构化结果 + 原始输出 |
| GET | `/api/probe?path=` | 服务器端 ffprobe |
| GET | `/api/files?path=` | 目录浏览（含大小、修改时间、扩展名） |
| GET | `/api/hardware` | DRM 设备 |
| POST | `/api/command` | argv 或手写文本 → 最终命令预览 |
| GET / POST | `/api/jobs` | 任务列表 / 入队 |
| GET | `/api/jobs/{id}`、`/api/jobs/{id}/log` | 单个任务与其日志 |
| POST | `/api/jobs/{id}/cancel`、`/api/jobs/{id}/retry` | 取消 / 重试 |
| DELETE | `/api/jobs/{id}` | 删除 |
| POST | `/api/jobs/clear` | 清理已结束的任务 |
| GET | `/api/events` | SSE：任务与日志的增量事件 |

## 安全边界

这是面向**可信内网**的工具：**没有账号体系**，接口能执行 ffmpeg、浏览目录、
读写文件。默认只监听 `127.0.0.1`，请勿直接暴露到公网；要跨机使用，建议放在
带认证的反向代理之后。

`FFMPEG_REMOTE_UI_MEDIA_ROOTS` 是**防误操作的下限，不是安全边界**：

- 它约束 `input`/`output` 字段，并对 `args` 里出现的绝对路径与显式相对路径
  （`./x`、`../x`）做同样的校验，所以 `-i /etc/shadow`、`-vf subtitles=../x`
  这类写法会被拒绝。
- 但它挡不住 **concat 列表文件**里写的路径，也挡不住不带任何前缀的相对路径
  （那取决于进程的工作目录）；接口本身也不区分调用者身份。

真正的隔离请交给运行账户的文件权限：用一个只能读媒体目录的账户运行本程序，
需要写入的目录单独授权。

## 许可证

Copyright (C) 2026 Myrrhwhis <i@l0u0l.com>

以 **GNU Affero General Public License v3.0 或更高版本**发布，完整条款见
[LICENSE](LICENSE)。

AGPL 与其他开源许可证的分歧只在网络服务这一档：把修改后的版本架在服务器上对外
提供，并不构成"分发二进制"，传统 GPL 管不到；AGPL 第 13 条补上了这个缺口——
**只要用户通过网络与它交互，就必须向这些用户提供对应的源码**。因此改过的版本
不能闭源地做成对外服务。自己内部部署、不对外提供服务时不受这一条约束。
