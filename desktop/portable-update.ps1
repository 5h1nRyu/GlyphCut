$ErrorActionPreference = 'Stop'
$install = $Update.installDir
$work = $Update.workDir
$incoming = Join-Path $work 'payload/GlyphCut-Windows-x64'
$manifest = 'portable-files.json'

function Read-PackageFiles($Root) {
    $names = Get-Content -LiteralPath (Join-Path $Root $manifest) -Raw -Encoding UTF8 | ConvertFrom-Json
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($name in $names) {
        if ($name -isnot [string] -or $name -notmatch '^[\p{L}\p{N}][\p{L}\p{N}_.-]*$' -or
            $name.EndsWith('.') -or -not $seen.Add($name)) {
            throw 'Invalid portable file manifest.'
        }
    }
    if (-not $seen.Contains($manifest) -or -not $seen.Contains('GlyphCut.exe') -or -not $seen.Contains('resources')) {
        throw 'Incomplete portable file manifest.'
    }
    return $names
}

function Move-Entry($From, $To) {
    for ($attempt = 0; $attempt -lt 12; $attempt++) {
        try {
            if ([IO.Directory]::Exists($From)) {
                [IO.Directory]::Move($From, $To)
            } else {
                [IO.File]::Move($From, $To)
            }
            return
        } catch {
            if ($attempt -eq 11) { throw }
            Start-Sleep -Milliseconds 250
        }
    }
}

function Start-GlyphCut($Executable, $SessionName) {
    $launch = [Diagnostics.ProcessStartInfo]::new()
    $launch.FileName = $Executable
    $launch.WorkingDirectory = $install
    $launch.UseShellExecute = $false
    $launch.EnvironmentVariables.Remove('GLYPHCUT_UPDATE_SESSION')
    if ($SessionName) { $launch.EnvironmentVariables['GLYPHCUT_UPDATE_SESSION'] = $SessionName }
    return [Diagnostics.Process]::Start($launch)
}

if ($Update.mode -eq 'stage') {
    $bundle = Join-Path $work 'bundle.zip'
    if ((Get-FileHash -LiteralPath $bundle -Algorithm SHA256).Hash -ne $Update.digest) {
        throw 'Archive digest does not match the release.'
    }
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($bundle)
    try {
        $size = 0L
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName
            if (-not $name.StartsWith('GlyphCut-Windows-x64/', [StringComparison]::Ordinal) -or
                $name -match '[:\\]|(^|/)\.{1,2}(/|$)') {
                throw 'Invalid archive entry.'
            }
            $size += $entry.Length
            if ($size -gt 1GB) { throw 'Expanded archive is too large.' }
        }
    } finally {
        $zip.Dispose()
    }
    [IO.Compression.ZipFile]::ExtractToDirectory($bundle, (Join-Path $work 'payload'))
    $newFiles = @(Read-PackageFiles $incoming)
    $oldFiles = @(Read-PackageFiles $install)
    $actual = @(Get-ChildItem -LiteralPath $incoming -Force | ForEach-Object Name)
    if (Compare-Object $newFiles $actual) { throw 'Archive does not match its manifest.' }
    $package = Get-Content -LiteralPath (Join-Path $incoming 'resources/app/package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($package.version -cne $Update.version -or $package.name -cne 'glyph-cut') {
        throw 'The package version does not match the release tag.'
    }
    foreach ($name in $newFiles) {
        if ($name -notin $oldFiles -and (Test-Path -LiteralPath (Join-Path $install $name))) {
            throw "Updating would overwrite an unmanaged file: $name"
        }
    }
    exit 0
}
if ($Update.mode -ne 'apply') { throw 'Unknown update phase.' }

try {
    $newFiles = @(Read-PackageFiles $incoming)
    $oldFiles = @(Read-PackageFiles $install)
    $running = Get-Process -Id $Update.pid -ErrorAction SilentlyContinue
    # Open the process handle while the original program is still alive.
    if ($running) { [void]$running.Handle }
    [IO.File]::WriteAllText((Join-Path $work 'installer-ready'), '')
} catch {
    [IO.File]::WriteAllText((Join-Path $work 'install-error.txt'), "更新助手启动失败。$_")
    exit 2
}

$backup = Join-Path $work 'backup'
$exe = Join-Path $install 'GlyphCut.exe'
$movedOld = [Collections.Generic.List[string]]::new()
$movedNew = [Collections.Generic.List[string]]::new()
$reopened = $null
try {
    if ($running -and -not $running.WaitForExit(120000)) {
        [IO.File]::WriteAllText((Join-Path $install '.glyphcut-update-error.txt'), '程序退出超时。请退出程序后重新更新。')
        exit 2
    }
    [IO.Directory]::CreateDirectory($backup) | Out-Null
    foreach ($name in $oldFiles) {
        $current = Join-Path $install $name
        if (Test-Path -LiteralPath $current) {
            Move-Entry $current (Join-Path $backup $name)
            $movedOld.Add($name)
        }
    }
    foreach ($name in $newFiles) {
        Move-Entry (Join-Path $incoming $name) (Join-Path $install $name)
        $movedNew.Add($name)
    }
    $reopened = Start-GlyphCut $exe (Split-Path -Leaf $work)
    $visibility = Join-Path $work 'window-ready'
    for ($attempt = 0; $attempt -lt 120 -and -not (Test-Path -LiteralPath $visibility); $attempt++) {
        if ($reopened.HasExited) { throw "新版程序在打开窗口前退出，退出代码 $($reopened.ExitCode)。" }
        Start-Sleep -Milliseconds 250
    }
    if (-not (Test-Path -LiteralPath $visibility)) { throw '新版程序未在 30 秒内确认窗口已打开。' }
    $reopened.Dispose()
} catch {
    $failure = $_.Exception.Message
    $restored = $true
    if ($reopened) {
        try {
            if (-not $reopened.HasExited) {
                $reopened.Kill()
                if (-not $reopened.WaitForExit(5000)) { $restored = $false }
            }
        } catch { $restored = $false }
        finally { $reopened.Dispose() }
    }
    foreach ($name in $movedNew) {
        try { Move-Entry (Join-Path $install $name) (Join-Path $incoming $name) }
        catch { $restored = $false }
    }
    foreach ($name in $movedOld) {
        try { Move-Entry (Join-Path $backup $name) (Join-Path $install $name) }
        catch { $restored = $false }
    }
    $message = "更新失败。`n$failure"
    if ($restored) {
        try {
            $log = Join-Path $install '.glyphcut-update-error.txt'
            [IO.File]::WriteAllText($log, "$message`n已还原更新前的程序。")
            $restoredProcess = Start-GlyphCut $exe
            if ($restoredProcess) { $restoredProcess.Dispose() }
            Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
            exit 1
        } catch { $message += "`n可从原程序目录重新启动。`n$($_.Exception.Message)" }
    } else {
        $message += "`n部分文件未能还原，原文件备份位置：`n$backup"
    }
    Write-Host $message
    try {
        $shell = New-Object -ComObject WScript.Shell
        [void]$shell.Popup($message, 10, 'GlyphCut', 16)
    } catch { Write-Host $_.Exception.Message }
    exit 1
}
Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
