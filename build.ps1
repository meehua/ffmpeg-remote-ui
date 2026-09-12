# 运行本项目只需要：这个二进制 + 机器上的 FFmpeg/FFprobe。
# 构建额外需要 Node.js，用来生成前端产物（随后被 go:embed 进二进制）。
#
# 这是 build.sh 的 PowerShell 版本，流程与它一致：两份脚本改一个记得改另一个。
#
# 前端固定用 npm：Node.js 自带，既不必额外安装 pnpm，也不用在两者之间做探测。

Set-Location $PSScriptRoot

# Windows PowerShell 5.1 默认按系统 ANSI 代码页（简体中文下是 GBK）编码输出，而脚本
# 里的中文、Go 与 npm 的输出都是 UTF-8；不统一就会半行正常半行乱码。这一句同时把
# 控制台代码页切到 UTF-8，和程序启动时做的事是同一个理由。
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

function Fail([string]$Message) {
  Write-Host "错误：$Message" -ForegroundColor Red
  exit 1
}

if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
  Fail '未找到 Go'
}

$goVersion = (& go version)
if ($goVersion -notmatch 'go1\.26\.') {
  Fail "需要 Go 1.26.x，当前：$goVersion"
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Fail '未找到 npm：构建前端需要 Node.js'
}

# 前端：安装依赖，然后类型检查 + 打包（build 脚本里已经包含 tsc --noEmit）。
# 这里用 npm ci 而不是 npm install：有 package-lock.json 时它装得可复现、也更快。
Push-Location frontend
try {
  & npm ci --no-fund --no-audit
  if ($LASTEXITCODE -ne 0) { Fail 'npm ci 失败' }

  & npm run build
  if ($LASTEXITCODE -ne 0) { Fail 'npm run build 失败' }
} finally {
  Pop-Location
}

# 产物放进 embed 目录后再编译，这样二进制是自包含的。
$webDir = Join-Path $PSScriptRoot 'cmd\ffmpeg-remote-ui\web'
if (Test-Path $webDir) {
  Remove-Item $webDir -Recurse -Force
}
New-Item -ItemType Directory -Path $webDir -Force | Out-Null
Copy-Item -Path (Join-Path $PSScriptRoot 'frontend\dist\*') -Destination $webDir -Recurse -Force

& go vet ./...
if ($LASTEXITCODE -ne 0) { Fail 'go vet 失败' }

& go test ./...
if ($LASTEXITCODE -ne 0) { Fail 'go test 失败' }

# 版本信息在链接期注入；不在 git 仓库里（或还没有 tag）时退回 dev。
& git rev-parse --git-dir *> $null
if ($LASTEXITCODE -eq 0) {
  $buildVersion = (& git describe --tags --dirty 2>$null)
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($buildVersion)) {
    $buildVersion = 'dev'
  }

  $buildCommit = (& git rev-parse --short HEAD 2>$null)
  if ($LASTEXITCODE -ne 0) { $buildCommit = 'unknown' }

  # HEAD 之后还有没提交的改动时把哈希标成 -dirty：不然这个哈希会让人以为
  # 二进制里的代码就是那个提交里的代码，而实际构建还夹带了工作区的改动。
  if ($buildCommit -ne 'unknown' -and -not [string]::IsNullOrWhiteSpace((& git status --porcelain))) {
    $buildCommit = "$buildCommit-dirty"
  }
} else {
  $buildVersion = 'dev'
  $buildCommit = 'unknown'
}
$buildDate = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')

$bin = 'ffmpeg-remote-ui.exe'
$ldflags = "-s -w -X main.version=$buildVersion -X main.commit=$buildCommit -X main.buildDate=$buildDate"

# ldflags 整体作为单个参数传出去：里面有空格，拆开就会被 go 当成别的选项。
& go build -trimpath "-ldflags=$ldflags" -o $bin ./cmd/ffmpeg-remote-ui
if ($LASTEXITCODE -ne 0) { Fail 'go build 失败' }

Write-Host ''
Write-Host "构建完成：.\$bin（直接运行即可，终端会打印监听地址）"
Write-Host "版本：$(& ".\$bin" --version)"
