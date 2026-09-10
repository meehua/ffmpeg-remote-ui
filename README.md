# FFmpeg Remote UI

**English** | [简体中文](README.zh-CN.md)

A web FFmpeg console for Linux servers and NAS boxes.

"remote" is meant literally: the browser is only the remote control. Media files,
`ffprobe`, `ffmpeg`, the GPU and the job queue all live on the machine running the
program. The browser never transcodes, and it never asks you to upload media that
is already on the server.

## Design notes

The full rationale lives in [PHILOSOPHY.md](PHILOSOPHY.md) (in Chinese). In code it
comes down to these:

- **FFmpeg is the single source of truth for capabilities.** Encoders, decoders,
  filters, muxers and demuxers, bitstream filters, protocols, devices, pixel and
  sample formats, channel layouts, colors, dispositions, hardware acceleration
  methods — and every component's tunable options with their values, defaults and
  ranges — all come from runtime queries (`ffmpeg -encoders`,
  `ffmpeg -h encoder=…`, …). There is no built-in capability table anywhere, so
  upgrading FFmpeg on the server automatically changes the UI.
- **Zero third-party Go dependencies.** Routing uses the standard library
  `net/http` (Go 1.22+ method and wildcard patterns), live updates use
  `text/event-stream` (SSE), and the queue and cancellation use `context`. No web
  framework, no ORM, no WebSocket library.
- **Single binary.** The frontend build output is embedded with `go:embed`, so at
  runtime you need nothing but the program itself plus FFmpeg/FFprobe on the
  server.
- **No configuration by default.** It listens on `127.0.0.1:0` (a system-assigned
  port) and discovers FFmpeg/FFprobe from `PATH`; environment variables only matter
  when you want to override something.

## Layout

```
cmd/ffmpeg-remote-ui  entry point: env vars, graceful shutdown, embedded frontend
internal/ffmpeg     FFmpeg/FFprobe queries and parsing (capability snapshot, -h, ffprobe)
internal/queue      concurrency-limited job queue (state machine, progress, logs, events)
internal/server     HTTP layer (routing, SSE event stream, file browsing, static assets)
internal/hardware   Linux DRM render node discovery (read-only sysfs, no capability inference)
frontend            React frontend (no UI component library, no CSS framework)
```

### Backend

- The dozen or so capability queries run concurrently, so startup time is bounded by
  the slowest one rather than by their sum.
- The job queue enforces a concurrency limit (`FFMPEG_REMOTE_UI_MAX_CONCURRENT_JOBS`,
  default 1), tracks queue position, and supports cancel / retry / delete / clear,
  plus a rolling 400-line log per job.
- Progress comes from `ffmpeg -progress pipe:1`: `out_time_us`, `frame`, `fps`,
  `speed`, `bitrate`, `total_size`. When ffmpeg cannot report a duration (with `-re`,
  for instance) the UI shows "in progress" instead of pretending to sit at 0%.
- `/api/events` is a single SSE stream: it sends a full job snapshot on connect and
  then incremental `job` and `log` events. The browser reconnects automatically, and
  state converges again after a reconnect.
- Path validation cleans paths and resolves symlinks (including the nearest existing
  ancestor of a path that does not exist yet), so links cannot escape the media
  roots.

### Frontend

- React 19 + TypeScript + Vite, with **no UI component library and no CSS
  framework** — styles are hand-written CSS Modules.
- Colors use `oklch` with `light-dark()` pairs, so the browser picks light or dark
  from `color-scheme` — no theme class names and no duplicate stylesheets.
- All layout intent is expressed with **logical properties**: `inline-size` /
  `block-size`, `padding-inline`, `border-inline-end`, `overflow-block`,
  `inset-block-start`, and so on.
- **There are exactly two scroll layers, and only one of them ever scrolls.**
  `html` / `body` are locked to the viewport and the page itself never scrolls; in
  portrait the content area (the pane container) is the only scroller, while in
  landscape each pane scrolls on its own. The wheel never changes owner depending on
  where the pointer happens to be, and you never scroll to the bottom only to find
  blank space with the top pushed out of view.
- **The columns are adaptive**: in portrait (or when the window is too narrow) each
  area is a card stacked vertically; in landscape and wide enough they become
  side-by-side columns with sticky headers. Both forms are the same DOM, switched
  purely by orientation media queries.
- Two modes for building the command line: a form generated from the server's real
  capabilities, and hand-written argv. `shellQuote` / `SplitArgs` follow the same
  rules on both frontend and backend, so the command you preview is the one that
  runs.
- **Hardware devices can be chosen explicitly**: the device type comes from
  `ffmpeg -init_hw_device list` and the device node from `/dev/dri`. On machines
  with more than one GPU (integrated plus discrete, say) FFmpeg picks one on its
  own, and picking wrong shows up as "failed to open encoder". Selecting one emits
  `-init_hw_device <type>=hw:<node>`, placed *before* `-i` — device initialization
  is a global option and loses its meaning after the input.

## Build

Requires Go 1.26.x and Node.js:

```bash
./build.sh
```

The script builds the frontend, copies `frontend/dist` into
`cmd/ffmpeg-remote-ui/web`, runs `go vet` and `go test`, and finally produces
`./ffmpeg-remote-ui`.

Frontend dependencies (all current stable):

| Package | Version |
| --- | --- |
| react / react-dom | 19.3.0 |
| vite | 8.3.0 |
| @vitejs/plugin-react | 6.1.1 |
| typescript | 7.0.2 |
| @types/node | 26.5.1 |

## Run

```bash
./ffmpeg-remote-ui
```

The terminal prints the actual listening address and the effective media roots.
Every environment variable has a sensible default, and they all share the
`FFMPEG_REMOTE_UI_` prefix to avoid colliding with other services on the same host
(especially generic names such as `HTTP_ADDR`):

| Variable | Default | Description |
| --- | --- | --- |
| `FFMPEG_REMOTE_UI_HTTP_ADDR` | `127.0.0.1:0` | Listen address; `:0` lets the system pick a port |
| `FFMPEG_REMOTE_UI_MEDIA_ROOTS` | empty | Directories that may be accessed, `:`-separated; empty means unrestricted |
| `FFMPEG_REMOTE_UI_FFMPEG_PATH` | `ffmpeg` | Resolved from `PATH` |
| `FFMPEG_REMOTE_UI_FFPROBE_PATH` | `ffprobe` | Resolved from `PATH` |
| `FFMPEG_REMOTE_UI_MAX_CONCURRENT_JOBS` | `1` | Number of concurrent ffmpeg processes |

For example:

```bash
FFMPEG_REMOTE_UI_HTTP_ADDR=:8090 \
FFMPEG_REMOTE_UI_MEDIA_ROOTS=/data/media:/mnt/media \
FFMPEG_REMOTE_UI_MAX_CONCURRENT_JOBS=2 \
  ./ffmpeg-remote-ui
```

## Hardware acceleration

Hardware encoding **starts with device permissions**, and this is where people get
stuck most often: `/dev/dri/renderD*` is owned by `root:render` with mode
`rw-rw----`, so when the account running the program is not in the `render` group,
FFmpeg cannot even open the device — yet all it prints is the vague
`Device creation failed: -542398533` (`AVERROR_EXTERNAL`), which is easily misread
as a missing driver or a missing QSV runtime.

Start by looking at the devices and at your own groups:

```bash
ls -l /dev/dri/            # owner and mode of renderD128/renderD129
ls -l /dev/dri/by-path/    # PCI address → node, to map nodes to cards
id                         # whether the account is in render / video
```

The `by-path` step is especially handy: integrated GPUs usually sit at
`0000:00:02.0` and discrete ones on a slot address, so you can tell at a glance
which node is which GPU — this is exactly the mapping the "hardware device"
selector in the UI shows.

The program also displays **model names** (for instance
`DG1 [Iris Xe MAX Graphics]`), resolved from the system PCI ID database
(`/usr/share/{misc,hwdata}/pci.ids` and similar locations). Names are only used to
tell devices apart and never take part in capability decisions; when the database
is missing the UI falls back to the `vendor:device` ID, such as `8086:4905`.
Install `pciutils` if names are missing.

To fix permissions (you must **log in again** afterwards, or restart a service that
runs in the background):

```bash
sudo usermod -aG render,video <the account running the program>
```

For a quick check `sudo chmod 666 /dev/dri/renderD*` also works, but it is lost on
reboot.

Then confirm the driver side is ready — if `vainfo` lists profiles, both hardware
and driver are fine:

```bash
sudo vainfo --display drm --device /dev/dri/renderD128
```

When running in a container, the account must be in the group *and* the device has
to be passed through:

```bash
docker run --device /dev/dri:/dev/dri --group-add render --group-add video …
```

Once permissions work, pick a hardware device type (`qsv`, `vaapi`, …) and a node in
the "encoding parameters" panel, and it will emit
`-init_hw_device <type>=hw:<node>`. It is worth confirming that the encoder really
works with a minimal command before running long jobs:

```bash
ffmpeg -hide_banner -init_hw_device qsv=hw:/dev/dri/renderD129 \
  -f lavfi -i nullsrc -frames:v 1 -c:v hevc_qsv -f null -
```

With multiple GPUs, make sure you pick the right one: their capabilities often
differ (the UHD 630 only encodes HEVC up to 8-bit, while the DG1 handles 10-bit).

## Development

```bash
cd frontend
npm install
npm run typecheck
API_TARGET=http://127.0.0.1:8090 npm run dev   # start the backend separately on 8090
```

`API_TARGET` belongs to the frontend toolchain (it is only read by the dev proxy in
`vite.config.ts`), so it does not carry the `FFMPEG_REMOTE_UI_` prefix.

## API

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/health` | Runtime status, Go version, concurrency limit, effective media roots |
| GET | `/api/ffmpeg` | FFmpeg capability snapshot |
| POST | `/api/ffmpeg/refresh` | Re-query capabilities (after changing FFmpeg versions) |
| GET | `/api/ffmpeg/help?target=&name=` | Structured `ffmpeg -h` result plus raw output |
| GET | `/api/probe?path=` | Server-side ffprobe |
| GET | `/api/files?path=` | Directory listing (size, mtime, extension) |
| GET | `/api/hardware` | DRM devices |
| POST | `/api/command` | argv or free-form text → final command preview |
| GET / POST | `/api/jobs` | List jobs / enqueue one |
| GET | `/api/jobs/{id}`, `/api/jobs/{id}/log` | A single job and its log |
| POST | `/api/jobs/{id}/cancel`, `/api/jobs/{id}/retry` | Cancel / retry |
| DELETE | `/api/jobs/{id}` | Delete |
| POST | `/api/jobs/clear` | Remove finished jobs |
| GET | `/api/events` | SSE: incremental job and log events |

## Security boundary

This is a tool for a **trusted internal network**: there is **no authentication**,
and the API can execute ffmpeg, browse directories, and read and write files. It
listens on `127.0.0.1` by default — do not expose it to the internet. To use it
across machines, put it behind an authenticating reverse proxy.

`FFMPEG_REMOTE_UI_MEDIA_ROOTS` is a **guard against mistakes, not a security
boundary**:

- It constrains the `input`/`output` fields and applies the same check to absolute
  paths and explicit relative paths (`./x`, `../x`) found in `args`, so constructs
  like `-i /etc/shadow` or `-vf subtitles=../x` are rejected.
- It cannot stop paths written inside a **concat list file**, nor relative paths
  with no prefix at all (those depend on the process working directory); the API
  also does not distinguish between callers.

Real isolation is up to the file permissions of the account running the program:
run it as an account that can only read the media directories, and grant write
access separately.

## License

Copyright (C) 2026 Myrrhwhis <i@l0u0l.com>

Released under the **GNU Affero General Public License v3.0 or later**; see
[LICENSE](LICENSE) for the full terms.

Where AGPL differs from other open-source licenses is the network-service clause:
serving a modified version from a server does not count as "distributing a binary",
which classic GPL would not reach. AGPL section 13 closes that gap — **if users
interact with it over a network, you must offer them the corresponding source**. So
a modified version cannot be run as a closed-source service. Internal deployments
that are not offered to others are unaffected.
