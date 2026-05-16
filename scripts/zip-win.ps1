# 在仓库根目录执行 .\\scripts\\zip-win.ps1
# 前提：已运行 npm run tauri build 或 cargo build -p my-tools --release
# 产物：在仓库根生成 my-tools-win-portable.zip，内含 my-tools.exe 及说明。

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

$exe = Join-Path $root "src-tauri\target\release\my-tools.exe"
if (-not (Test-Path $exe)) {
  Write-Error "未找到 $exe 。请先执行: npm run tauri build"
}

$ver = (Get-Content (Join-Path $root "package.json") | ConvertFrom-Json).version
$pack = Join-Path $root "portable-tmp\my-tools"
New-Item -ItemType Directory -Force -Path $pack | Out-Null
Copy-Item -Force $exe (Join-Path $pack "my-tools.exe")

# 说明正文（中文）。文件名使用纯 ASCII，避免 Compress-Archive 对 ZIP 内中文条目名用旧编码导致解压后文件名乱码。
$readmeBody = @"
网页快开（绿软 / 可拷 U 盘）
============================

1. 需已安装 WebView2 Runtime（Windows 10/11 通常已带）。
2. 收藏与配置在 my-tools.exe 同目录：favorites.json、app.json（首次运行会自动创建默认）。
3. 修改管理页数据后，速开列表需用速开中输入 /reload 或重启应用后生效（按实现约定）。
4. 本压缩包为「免安装」部署：整文件夹复制到任意盘即可用。

package.json 版本: $ver
生成时间: $((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))
"@
$readmePath = Join-Path $pack "readme-zh.txt"
# UTF-8 带 BOM，便于 Windows「记事本」按 UTF-8 打开正文不乱码
$utf8Bom = New-Object System.Text.UTF8Encoding $true
[System.IO.File]::WriteAllText($readmePath, $readmeBody, $utf8Bom)

$zip = Join-Path $root "my-tools-win-portable.zip"
if (Test-Path $zip) { Remove-Item -Force $zip }
Compress-Archive -Path (Join-Path $root "portable-tmp\my-tools") -DestinationPath $zip
Remove-Item -Recurse -Force (Join-Path $root "portable-tmp")
Write-Host "已生成: $zip"
