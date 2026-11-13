$ErrorActionPreference = 'Stop'

$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$authoring = Join-Path $root '.cache/nagato-authoring'
$archive = Join-Path $authoring 'PSD2Live-3.6.7-windows-x64-portable.zip'
$archiveHash = '7505627FAFC502BFB7556B59F8948058A976690F51384A280E8DF561D3668FDD'
$proxyHash = 'AE6DF5898BC9927F2FBAD6CE93F22FF14430210164CF080EA5395A093686692C'
$toolsFolder = Join-Path $env:LOCALAPPDATA 'Programs/PSD2Live-3.6.7'
$editor = Join-Path $toolsFolder 'PSD2Live.exe'
$projectFolder = Join-Path ([Environment]::GetFolderPath('MyDocuments')) '长门有希 Live2D'
$projectName = '长门有希 常服.psd2live'
$workingProject = Join-Path $projectFolder $projectName
$bundle = Join-Path $root 'apps/desktop/models/live2d/nagato-uniform-review'
$projectSource = Join-Path $bundle 'nagato-uniform-review.psd2live'
$launcherFolder = Join-Path $env:LOCALAPPDATA 'PSD2Live/Nagato'
$launcher = Join-Path $launcherFolder 'open-nagato-editor.py'
$existingProxy = Join-Path $authoring 'psd2live-3.6.7/mcp_proxy.py'
$shortcutPath = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) '长门有希 常服编辑.lnk'

if (-not (Test-Path -LiteralPath $projectSource -PathType Leaf)) {
    throw "找不到常服工程 $projectSource"
}

if (-not (Test-Path -LiteralPath $editor -PathType Leaf)) {
    if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) {
        New-Item -ItemType Directory -Path $authoring -Force | Out-Null
        Invoke-WebRequest 'https://github.com/tsunehimatoi/psd2live/releases/download/v3.6.7/PSD2Live-3.6.7-windows-x64-portable.zip' -OutFile $archive
    }
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $archiveHash) {
        throw "PSD2Live 便携包校验失败 $archive"
    }
    New-Item -ItemType Directory -Path $toolsFolder -Force | Out-Null
    tar.exe -xf $archive -C $toolsFolder
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $editor -PathType Leaf)) {
        throw 'PSD2Live 便携包解压失败。'
    }
}

New-Item -ItemType Directory -Path $projectFolder, $launcherFolder -Force | Out-Null
if (-not (Test-Path -LiteralPath $workingProject)) {
    Copy-Item -LiteralPath $projectSource -Destination $workingProject
}
$cubism = Join-Path $projectFolder '长门有希 常服.cmo3'
if (-not (Test-Path -LiteralPath $cubism)) {
    Copy-Item -LiteralPath (Join-Path $bundle 'nagato-uniform-review.cmo3') -Destination $cubism
}
$proxy = Join-Path $launcherFolder 'mcp_proxy.py'
if (-not (Test-Path -LiteralPath $proxy -PathType Leaf) -or (Get-FileHash -LiteralPath $proxy).Hash -ne $proxyHash) {
    $proxyCandidate = $existingProxy
    if (-not (Test-Path -LiteralPath $proxyCandidate -PathType Leaf) -or (Get-FileHash -LiteralPath $proxyCandidate).Hash -ne $proxyHash) {
        $proxyCandidate = Join-Path $launcherFolder 'mcp_proxy.download'
        Invoke-WebRequest 'https://raw.githubusercontent.com/tsunehimatoi/psd2live/v3.6.7/mcp_proxy.py' -OutFile $proxyCandidate
    }
    if ((Get-FileHash -LiteralPath $proxyCandidate).Hash -ne $proxyHash) {
        throw 'PSD2Live 本地连接脚本校验失败。'
    }
    Copy-Item -LiteralPath $proxyCandidate -Destination $proxy -Force
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'open-nagato-editor.py') -Destination $launcher -Force

$python = Get-Command pythonw.exe -CommandType Application -ErrorAction SilentlyContinue
$pythonPath = $python.Source
if (-not $pythonPath) {
    $uv = Get-Command uv.exe -CommandType Application -ErrorAction SilentlyContinue
    if ($uv) {
        $uvPython = & $uv.Source python find --no-project
        if ($LASTEXITCODE -eq 0 -and $uvPython) {
            $pythonPath = Join-Path (Split-Path -Parent ($uvPython | Select-Object -First 1)) 'pythonw.exe'
        }
    }
}
if (-not $pythonPath -or -not (Test-Path -LiteralPath $pythonPath -PathType Leaf)) {
    throw "PSD2Live 和工程已就绪，创建自动打开快捷方式需要本机 Python 的 pythonw.exe。工程在 $workingProject"
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $pythonPath
$shortcut.Arguments = '"' + $launcher + '" "' + $editor + '" "' + $workingProject + '"'
$shortcut.WorkingDirectory = $projectFolder
$shortcut.IconLocation = $editor + ',0'
$shortcut.Description = '用 PSD2Live 打开长门有希常服工程'
$shortcut.Save()

Write-Output $shortcutPath
Write-Output $workingProject
