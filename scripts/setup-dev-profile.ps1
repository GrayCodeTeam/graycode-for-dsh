# 把 dsh web profile 切换为 GrayCode 目录链接开发模式（幂等，可重跑）
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/setup-dev-profile.ps1
# 前置：dsh web profile 已存在（至少启动过一次 dsh web）

$ErrorActionPreference = 'Stop'

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$profileDir = Join-Path $env:USERPROFILE '.dsh\profiles\web'
$linkDir = Join-Path $profileDir '_dev-link'

if (-not (Test-Path $profileDir)) {
    throw "web profile 不存在: $profileDir （先运行一次 dsh web 初始化 profile）"
}

# 1. _dev-link junction → 仓库根（幂等）
if (-not (Test-Path $linkDir)) {
    cmd /c "mklink /J `"$linkDir`" `"$repo`"" | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "创建 _dev-link junction 失败" }
    Write-Host "[ok] _dev-link -> $repo"
} else {
    Write-Host "[skip] _dev-link 已存在"
}

# 2. 改写 package.json 依赖
$pkgPath = Join-Path $profileDir 'package.json'
$json = Get-Content $pkgPath -Raw | ConvertFrom-Json
$json.dependencies.'@graycode/dsh' = 'link:./_dev-link/scripts/.dev-bundle'
$json.dependencies.'@graycode/dsh-plugin' = 'link:./_dev-link/packages/plugin'
$json.dependencies.'@graycode/dsh-client' = 'link:./_dev-link/packages/client'
$json | ConvertTo-Json -Depth 10 | Set-Content $pkgPath -Encoding UTF8
Write-Host '[ok] package.json 依赖已改写为 link:./_dev-link/...'

# 3. 重建链接
Push-Location $profileDir
try {
    pnpm install --force
    if ($LASTEXITCODE -ne 0) { throw 'pnpm install 失败' }
} finally {
    Pop-Location
}

# 4. 校验
$probe = Join-Path $profileDir 'node_modules\@graycode\dsh-plugin\package.json'
if (-not (Test-Path $probe)) { throw '链接校验失败：@graycode/dsh-plugin 未解析' }
Write-Host '[ok] 开发模式就绪：dsh web 启动后，client 改动重建即可刷新网页生效'
