#!/usr/bin/env bash
set -euo pipefail

# 运行本项目只需要：这个二进制 + 服务器上的 FFmpeg/FFprobe。
# 构建额外需要 Node.js，用来生成前端产物（随后被 go:embed 进二进制）。
#
# 前端固定用 npm：Node.js 自带，既不必额外安装 pnpm，也不用在两者之间做探测。

if ! command -v go >/dev/null 2>&1; then
  echo '未找到 Go' >&2
  exit 1
fi

case "$(go version)" in
  *'go1.26.'*) ;;
  *)
    echo "需要 Go 1.26.x，当前：$(go version)" >&2
    exit 1
    ;;
esac

if ! command -v npm >/dev/null 2>&1; then
  echo '未找到 npm：构建前端需要 Node.js' >&2
  exit 1
fi

# 前端：安装依赖，然后类型检查 + 打包（build 脚本里已经包含 tsc --noEmit）。
cd frontend
npm install --no-fund --no-audit
npm run build
cd ..

# 产物放进 embed 目录后再编译，这样二进制是自包含的。
rm -rf cmd/ffmpeg-remote-ui/web
mkdir -p cmd/ffmpeg-remote-ui/web
cp -R frontend/dist/. cmd/ffmpeg-remote-ui/web/

go vet ./...
go test ./...
go build -trimpath -ldflags='-s -w' -o ffmpeg-remote-ui ./cmd/ffmpeg-remote-ui

printf '\n构建完成：./ffmpeg-remote-ui（直接运行即可，终端会打印监听地址）\n'
