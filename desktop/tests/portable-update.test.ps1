$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$helper = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../portable-update.ps1') -Raw -Encoding UTF8
$temp = Join-Path ([IO.Path]::GetTempPath()) ("GlyphCut [test] " + [char]0x6D4B + " " + [Guid]::NewGuid())
$exe = Join-Path $env:SystemRoot 'System32/whoami.exe'

function Assert-True($Condition, $Message) {
    if (-not $Condition) { throw $Message }
}

function New-Package($Directory, $Version, $VersionFile) {
    $appDir = Join-Path $Directory 'resources/app'
    [IO.Directory]::CreateDirectory($appDir) | Out-Null
    Copy-Item -LiteralPath $exe -Destination (Join-Path $Directory 'GlyphCut.exe')
    Set-Content -LiteralPath (Join-Path $appDir 'package.json') -Value ('{"name":"glyph-cut","version":"' + $Version + '"}') -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $Directory $VersionFile) -Value $Version -Encoding ASCII
    $files = @('GlyphCut.exe', 'resources', 'portable-files.json', $VersionFile)
    Set-Content -LiteralPath (Join-Path $Directory 'portable-files.json') -Value (ConvertTo-Json -InputObject $files) -Encoding ASCII
}

function Invoke-Updater($Mode, $Install, $Work, $Version, $Digest, $Expect) {
    $payload = @{
        mode = $Mode; installDir = $Install; workDir = $Work; version = $Version
        digest = $Digest; pid = [int]::MaxValue
    } | ConvertTo-Json -Compress
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))
    $prefix = '$Update = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("{0}")) | ConvertFrom-Json' -f $encoded
    $script = $prefix + [Environment]::NewLine + $helper
    $command = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
    & powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand $command
    Assert-True ($LASTEXITCODE -eq $Expect) "$Mode exited with $LASTEXITCODE, expected $Expect."
}

try {
    foreach ($test in @('success', 'rollback')) {
        $install = Join-Path $temp "$test/program"
        $work = Join-Path $install '.glyphcut-update-test'
        $source = Join-Path $temp "$test/source/GlyphCut-Windows-x64"
        New-Package $install '1.1.0' 'old-only.dll'
        New-Package $source '1.2.0' 'new-only.dll'
        [IO.Directory]::CreateDirectory($work) | Out-Null
        Set-Content -LiteralPath (Join-Path $install 'user-export.svg') -Value 'keep me' -Encoding ASCII
        $archive = Join-Path $work 'bundle.zip'
        $zip = [IO.Compression.ZipFile]::Open($archive, [IO.Compression.ZipArchiveMode]::Create)
        try {
            foreach ($entry in (Get-ChildItem -LiteralPath $source -Recurse -File)) {
                $relative = $entry.FullName.Substring($source.Length + 1).Replace('\', '/')
                [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $entry.FullName, "GlyphCut-Windows-x64/$relative") | Out-Null
            }
        } finally { $zip.Dispose() }

        $digest = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
        Invoke-Updater stage $install $work '1.2.0' $digest 0
        if ($test -eq 'success') {
            Invoke-Updater apply $install $work '1.2.0' $digest 0
            Assert-True (Test-Path -LiteralPath (Join-Path $install 'new-only.dll')) 'New file was not installed.'
            Assert-True (-not (Test-Path -LiteralPath (Join-Path $install 'old-only.dll'))) 'Obsolete file stayed installed.'
            $expectedVersion = '1.2.0'
        } else {
            Remove-Item -LiteralPath (Join-Path $work 'payload/GlyphCut-Windows-x64/new-only.dll')
            Invoke-Updater apply $install $work '1.2.0' $digest 1
            Assert-True (Test-Path -LiteralPath (Join-Path $install 'old-only.dll')) 'Old file was not restored.'
            Assert-True (Test-Path -LiteralPath (Join-Path $install '.glyphcut-update-error.txt')) 'Rollback was not reported.'
            $expectedVersion = '1.1.0'
        }
        $package = Get-Content -LiteralPath (Join-Path $install 'resources/app/package.json') -Raw | ConvertFrom-Json
        Assert-True ($package.version -eq $expectedVersion) 'Incorrect installed version.'
        Assert-True ((Get-Content -LiteralPath (Join-Path $install 'user-export.svg')) -eq 'keep me') 'Unmanaged file was changed.'
        Assert-True (-not (Test-Path -LiteralPath $work)) 'Update working directory was not cleaned.'
    }
    Write-Host 'Windows portable update and rollback passed.'
} finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
exit 0
