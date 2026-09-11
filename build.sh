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

# 版本信息在链接期注入；不在 git 仓库里（或还没有 tag）时退回 dev。
if git rev-parse --git-dir >/dev/null 2>&1; then
  build_version=$(git describe --tags --dirty 2>/dev/null || echo dev)
  build_commit=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)

  # HEAD 之后还有没提交的改动时把哈希标成 -dirty：不然这个哈希会让人以为
  # 二进制里的代码就是那个提交里的代码，而实际构建还夹带了工作区的改动。
  if [ "$build_commit" != unknown ] && [ -n "$(git status --porcelain)" ]; then
    build_commit="${build_commit}-dirty"
  fi
else
  build_version=dev
  build_commit=unknown
fi
build_date=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

go build -trimpath \
  -ldflags="-s -w -X main.version=$build_version -X main.commit=$build_commit -X main.buildDate=$build_date" \
  -o ffmpeg-remote-ui ./cmd/ffmpeg-remote-ui

printf '\n构建完成：./ffmpeg-remote-ui（直接运行即可，终端会打印监听地址）\n'
printf '版本：%s\n' "$(./ffmpeg-remote-ui --version)"
