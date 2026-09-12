# FFmpeg Remote UI

**简体中文** | [English](README.md)

一个面向 Linux / Windows 服务器与 NAS 的 Web FFmpeg 控制台。

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
- **不需要预先配置。** 默认监听 `127.0.0.1:0`（系统分配端口），FFmpeg/FFprobe
  从 `PATH` 自动发现，因此第一次运行什么都不用准备。这些设置在用户配置目录的
  JSON 文件里，首次运行由程序替你写出来；想临时覆盖某一次运行，环境变量仍然优先。
  详见[运行](#运行)。
- **用户状态就是普通 JSON。** `config.json` 与 `presets/` 下的预设都是能直接读、
  能手工改的文件，且一律原子写入——写到一半被打断不会留下半截文件。
- **界面就是 ffmpeg 的命令行本身。** `ffmpeg -h` 早就把选项按位置分好了组
  （`Global options`、`Per-file options (input-only)`、`Per-file options
  (output-only)`、`Per-stream options`、`Video/Audio/Subtitle/Data options`）。
  面板就照这组分节渲染：分节名、选项名、占位符全部照抄，于是 `-ss`、`-t`、
  `-metadata`、视频/音频/字幕/数据四类流、以及 `-filter:a` 这类每流选项都是控件，
  而不是要手敲的参数；服务器上的 FFmpeg 升级后，界面自动跟着变。只有一处例外：
  ffmpeg 的分组和它实际的位置约束并不总一致（它把 `-hwaccel` 归在
  `Advanced Video options`，却拒绝把它放在输出侧），这种情况下选项自带一个可改的
  位置，而不是由程序替 ffmpeg 打补丁。
- **一个选项只出现一次。** 模型是「选项名 → 取值」的映射，所以 ffmpeg 要求重复
  出现的选项——最常见的就是 `-map 0:v:0? -map 0:a:0?`——暂时还不能做成控件；
  这类写法请放进「附加参数」，那个字段是原样透传的。

## 架构

```
cmd/ffmpeg-remote-ui  入口：运行时设置、优雅关闭、嵌入式前端
internal/ffmpeg     FFmpeg/FFprobe 查询与解析（能力快照、-h 结构、ffprobe）
internal/queue      并发受限的任务队列（状态机、进度、日志、事件广播）
internal/server     HTTP 层（路由、SSE 事件流、文件浏览、目录扫描、静态资源）
internal/hardware   平台相关的设备发现（Linux 读 sysfs，Windows 读注册表；不推断能力）
internal/config     运行时设置：环境变量 + config.json + 默认值三级合并
internal/preset     预设存储：用户配置目录下的 JSON 文件
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
- 目录扫描与“创建输出目录”走同一套路径校验：扫描只收普通文件、跳过隐藏项与
  符号链接，并且可以带一份由用户给出的扩展名白名单——程序里没有内置的媒体格式表。

### 前端

- React 19 + TypeScript + Vite，**不使用任何 UI 组件库或 CSS 框架**，样式由
  CSS Modules 手写。
- 颜色用 `oklch` 并以 `light-dark()` 给出深浅两套值，浏览器按 `color-scheme`
  自动选择——不需要主题类名，也不需要两份样式表。
- 布局意图一律用**逻辑属性**表达：`inline-size` / `block-size`、
  `padding-inline`、`border-inline-end`、`overflow-block`、`inset-block-start` 等。
- **滚动只有两层，且任何时刻只有一层真的在滚**：`html` / `body` 锁在视口内，
  页面本身永不滚动；竖屏时内容区（分栏容器）是唯一的滚动容器，横屏时改为每一栏
  各自滚动。滚轮不会因为鼠标停在哪个子区域而改变归属，也不会出现滚到底露出空白、
  顶部被顶出视口的错位。
- **分栏是自适应的**：竖屏（或窗口过窄）时各区域是卡片，纵向堆叠；横屏且够宽时
  变成并列分栏、标题吸顶。两种形态是同一份 DOM，只由方向媒体查询切换。
- 参数构建器与手写 argv 双模式：参数构建器的结构与选项全部来自 ffmpeg 自己的
  `-h` 输出（见设计要点里的「界面就是 ffmpeg 的命令行本身」），手写模式则直接写
  命令行；`shellQuote` 与 `SplitArgs` 在前端和后端是同一套规则，而且两边都按服务器
  平台分 POSIX 与 cmd 两份实现，因此预览到的命令与实际执行的一致，粘到服务器的
  终端里也是同一个意思。
- **表单填过的东西不会白填**：工作区与批处理的每个字段都经同一个 hook 存进
  浏览器本地存档，切换功能域或刷新页面都不再清空；读回时会先归一化，旧存档或
  坏存档退回默认值，而不是把界面弄崩。
- **预设存的是整套设置**：一份命名配方可以在两个视图里保存、载入与删除，落在
  用户配置目录的 JSON 文件里，因此换浏览器、换设备看到的都是同一批。存下来的
  是整个转码设置——每路流的编码器与参数、命令行选项、附加参数——所以调好的一套
  可以整套复用，不必在面板里重新翻一遍。配方自带版本号并被宽容解析（旧版本会
  自动迁移），后端从不解析它的内容。
- **「保留原流」靠的是 copy，不是留空**：每路流的编码器下拉里第一项是
  「不设置」，它意味着**不生成** `-c:<流>`，此时 ffmpeg 会用输出格式的默认编码器
  重新编码；要真正保留原来那一路，选 `copy`（ffmpeg 原文：'copy' to copy stream
  without reencoding）。
- **扩展名候选来自 ffmpeg**：批处理扫描的扩展名过滤与输出扩展名，候选都取自
  ffmpeg 在 `demuxer` / `muxer` 帮助里写的 Common extensions——输入侧与输出侧
  各取各的那一份，程序里没有「常见格式」这种表。「全部」只会勾选当前筛选出来的
  那些。
- **批处理可以还原目录结构**：批处理能递归扫描一个目录（扩展名白名单来自上面
  那份列表）并填入列表；打开「还原原目录结构」后，每个输出按相对扫描根的路径落位，
  输出目录会在提交前建好——FFmpeg 自己不会创建目录。扩展名始终归命名设置管，
  与结构还原无关。
- **硬件设备可显式指定**：设备类型取自 `ffmpeg -init_hw_device list`，选中后生成
  `-init_hw_device <type>=hw:<node>`，并放在 `-i` 之前——设备初始化是全局选项，放在
  输入之后就失去语义了。`<node>` 那一段是什么意思由 FFmpeg 按类型解释，而且同一个值
  在不同类型里指的不是一回事：`1` 在 `cuda` 里是第 1 块 NVIDIA 卡，在 `d3d11va` 里是
  第 1 个 DXGI 适配器，在 `qsv` 里却是 MFX 的实现选择符（本机实测 `qsv=hw:1` 报
  `Error creating a MFX session: -9`，与哪块卡无关——qsv 挑适配器要用它自己的
  `child_device` 选项）。所以节点既不预填也不推断：下拉按服务器发现的设备一行一台列
  出来——名字与「硬件」页同一套，型号在前、厂商:设备ID 在后——而且只列服务器自己给出
  了名字的那些，因为那个名字就是能填进 `-init_hw_device` 的值（Linux 上的
  `/dev/dri/renderD128` 就是）。服务器给不出名字的设备就不列：Windows 上的显示适配器
  只有注册表子键序号，与 FFmpeg 认的适配器序号不是同一套编号（实测注册表第 3 个子键是
  虚拟显示适配器，FFmpeg 的 2 号却是核显），宁可不写，也不替用户猜一个数字。

  实测回答的是另一半——这个值能不能起来。点「实测可用组合」：服务器会把「自动选择」与
  几个小序数逐个真的初始化一次，结论写回带着那个值的那一行。它不试图认出某个数字落在
  了哪块卡上：FFmpeg 报这件事的方式按类型各不相同（`d3d11va` 会打印 `Using device
  10de:2560 (NVIDIA GeForce RTX 3060 Laptop GPU)`，`cuda` 在任何日志级别下都不提，
  `qsv` 报的又是它自己挑中的子设备），从日志里抠只会抠出一层脆壳。哪个值能用，答案只
  来自 FFmpeg，不来自程序里的推断表。
- **类型不是能力承诺**：一个设备都没发现时，面板会直接说明这一点，并提醒 `qsv`
  这类需要专用硬件的类型可能用不了；发现了设备时，它也会提醒类型要与硬件对得上——
  类型选错，FFmpeg 会在初始化设备那一步就失败。`-init_hw_device list` 回答的是
  「这套 FFmpeg 支持哪些类型」，不是「本机这块卡能用哪个」。

## 构建

需要 Go 1.26.x 与 Node.js。

Linux / macOS（Windows 上的 Git Bash 同样可以）：

```bash
./build.sh
```

Windows PowerShell：

```powershell
.\build.ps1
```

两份脚本流程一致：构建前端、把 `frontend/dist` 复制到 `cmd/ffmpeg-remote-ui/web`、
跑 `go vet` 与 `go test`，最后产出可执行文件（Windows 上是 `ffmpeg-remote-ui.exe`）。

前端依赖（均为当前稳定版）：

| 包 | 版本 |
| --- | --- |
| react / react-dom | 19.3.0 |
| vite | 8.3.0 |
| @vitejs/plugin-react | 6.1.1 |
| typescript | 7.0.2 |
| @types/node | 26.5.1 |

## 运行

Linux / macOS：

```bash
./ffmpeg-remote-ui
```

Windows：

```powershell
.\ffmpeg-remote-ui.exe
```

终端会打印实际监听地址、生效的媒体目录，以及每个设置来自哪一层。

设置按 **环境变量 > `config.json` > 内置默认值** 三级解析：环境变量描述「这一次
运行」，配置文件描述「这台机器」。它们统一带 `FFMPEG_REMOTE_UI_` 前缀，避免和同机
其它服务（尤其是 `HTTP_ADDR` 这类泛名）撞车：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `FFMPEG_REMOTE_UI_HTTP_ADDR` | `127.0.0.1:0` | 监听地址；`:0` 表示由系统分配端口 |
| `FFMPEG_REMOTE_UI_MEDIA_ROOTS` | 空 | 允许访问的媒体根目录，按系统的路径列表分隔符分隔（Linux 上 `:`，Windows 上 `;`）；留空表示不限制 |
| `FFMPEG_REMOTE_UI_FFMPEG_PATH` | `ffmpeg` | 从 `PATH` 查找 |
| `FFMPEG_REMOTE_UI_FFPROBE_PATH` | `ffprobe` | 从 `PATH` 查找 |
| `FFMPEG_REMOTE_UI_MAX_CONCURRENT_JOBS` | `1` | 同时运行的 ffmpeg 进程数 |
| `FFMPEG_REMOTE_UI_CONFIG_DIR` | Linux：`$XDG_CONFIG_HOME/ffmpeg-remote-ui`；Windows：`%AppData%\ffmpeg-remote-ui` | `config.json` 与 `presets/` 所在目录 |

例如，用环境变量临时覆盖这一次运行：

```bash
FFMPEG_REMOTE_UI_HTTP_ADDR=:8090 \
FFMPEG_REMOTE_UI_MEDIA_ROOTS=/data/media:/mnt/media \
FFMPEG_REMOTE_UI_MAX_CONCURRENT_JOBS=2 \
  ./ffmpeg-remote-ui
```

Windows 上同一件事（注意路径之间用分号分隔，因为 `;` 才是系统认的列表分隔符）：

```powershell
$env:FFMPEG_REMOTE_UI_HTTP_ADDR = ':8090'
$env:FFMPEG_REMOTE_UI_MEDIA_ROOTS = 'D:\media;E:\media'
$env:FFMPEG_REMOTE_UI_MAX_CONCURRENT_JOBS = '2'
.\ffmpeg-remote-ui.exe
```

### 配置文件

首次运行时还没有 `config.json`，程序会把本次真正生效的设置写成一份，并在终端与
界面里都说明这件事。之后直接改这个文件即可，不必每次开机都导环境变量：

```json
{
  "httpAddr": "127.0.0.1:0",
  "mediaRoots": [],
  "ffmpegPath": "ffmpeg",
  "ffprobePath": "ffprobe",
  "maxConcurrentJobs": 1
}
```

文件是原子写入的，并且**此后绝不会被程序覆盖**——即使它已经写坏，因为那通常意味着
你正在编辑它。文件写坏只会产生一条警告，环境变量与默认值照常生效。界面上方的
「运行时设置」会把生效值与每个值的来源一并列出，「到底哪个生效了」不需要猜。

### 预设

表单里攒出来的配方（编码器及其参数、硬件设备、附加参数，加上批处理的命名选项）
可以存成一份命名预设。预设就是 `config.json` 旁边的普通 JSON 文件，原子写入，
也可以手工编辑：

```
~/.config/ffmpeg-remote-ui/          # Windows 上是 %AppData%\ffmpeg-remote-ui\
├── config.json
└── presets/
    └── x265 慢速.json
```

预设自带 `version`，前端按宽容规则解析：缺字段用默认值补齐、多出来的字段直接忽略，
因此表单以后加了字段，老预设照样能用。后端把配方当作不透明 JSON，所以改界面从来
不需要动后端。

## 硬件加速

这一节讲的是 Linux。Windows 上 FFmpeg 走 D3D11 / QSV / NVENC，没有 `/dev/dri`
那套设备权限问题（显卡驱动装好就行），下面的内容在那边可以整段跳过。

硬件编码**先要解决设备权限**，这是最容易卡住的一步：`/dev/dri/renderD*` 的
属主是 `root:render`、权限 `rw-rw----`，运行程序的账户不在 `render` 组里时，
FFmpeg 根本打不开设备，但报出来的是含糊的
`Device creation failed: -542398533`（`AVERROR_EXTERNAL`），很容易被误判成
驱动或 QSV 运行时缺库。

先看清设备与自己的组：

```bash
ls -l /dev/dri/            # renderD128/renderD129 的属主与权限
ls -l /dev/dri/by-path/    # PCI 地址 → 节点，用来对应到具体哪块卡
id                         # 当前账户是否在 render / video 组里
```

`by-path` 那步尤其有用：核显通常在 `0000:00:02.0`，独显在插槽地址上，一眼就能
看出哪个节点是哪块 GPU——程序里「硬件设备」选择器展示的就是这个对应关系。

程序还会显示**型号名**（例如 `DG1 [Iris Xe MAX Graphics]`），来源是系统的 PCI ID
数据库（`/usr/share/{misc,hwdata}/pci.ids` 等常见位置）。型号只用于辨认设备，
不参与任何能力判断；数据库不存在时自动退回显示 `vendor:device` ID，例如
`8086:4905`。缺型号的话装 `pciutils` 即可。

修复方式（改完要**重新登录**，或重启以后台方式运行的服务）：

```bash
sudo usermod -aG render,video <运行程序的账户>
```

临时验证也可以用 `sudo chmod 666 /dev/dri/renderD*`，但重启后就失效了。

接着确认驱动侧就绪——`vainfo` 能列出 profile，说明硬件与驱动都没问题：

```bash
sudo vainfo --display drm --device /dev/dri/renderD128
```

在容器里运行时，除了账户要在组里，设备本身也要传进去：

```bash
docker run --device /dev/dri:/dev/dri --group-add render --group-add video …
```

权限通了之后，在「编码参数」面板选硬件设备类型（`qsv`、`vaapi`…）与节点，即可
生成 `-init_hw_device <type>=hw:<node>`。不过 `<node>` 的含义按类型而定：`vaapi` 收的
就是 DRM 节点路径，`qsv` 收的却是 MFX 实现选择符，它的适配器要用 `child_device`
选项指定。拿不准时先实测一次，再把结论那一项上悬浮出来的 FFmpeg 原文照抄成最小命令
确认编码器真的可用，然后才去跑长任务：

```bash
ffmpeg -hide_banner -init_hw_device qsv=hw,child_device=/dev/dri/renderD129 \
  -f lavfi -i nullsrc -frames:v 1 -c:v hevc_qsv -f null -
```

多 GPU 时记得挑对卡：核显与独显支持的档次常常不同（例如 UHD 630 的 HEVC 编码
只到 8-bit，DG1 支持 10-bit）。

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
| GET | `/api/ffmpeg/cli?level=` | ffmpeg 自己的命令行拓扑：分节 → 选项，作用范围与媒体类型从分节标题读出 |
| GET | `/api/ffmpeg/extensions?target=` | ffmpeg 声明的文件扩展名：`demuxer`（输入侧）或 `muxer`（输出侧） |
| GET | `/api/probe?path=` | 服务器端 ffprobe |
| GET | `/api/files?path=` | 目录浏览（含大小、修改时间、扩展名）；不带 `path` 时给出入口列表（媒体根目录；未配置时是文件系统根） |
| GET | `/api/files/scan?path=&ext=&limit=` | 递归扫描；`ext` 是可选的逗号分隔扩展名白名单 |
| POST | `/api/dirs` | 创建输出目录（含父目录） |
| GET | `/api/hardware` | 显示设备 |
| POST | `/api/command` | argv 或手写文本 → 最终命令预览 |
| GET | `/api/config` | 生效的运行时设置与每个值的来源 |
| GET | `/api/presets` | 预设目录与预设列表 |
| GET / PUT / DELETE | `/api/presets/{name}` | 读取 / 保存（覆盖）/ 删除一份预设 |
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
- 目录扫描与创建目录同样受它约束：扫描只能扫允许范围内的目录，创建目录只能建在
  允许范围内。
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
