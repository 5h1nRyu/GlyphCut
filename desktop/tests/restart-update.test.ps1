$ErrorActionPreference = 'Stop'
$zip = (Resolve-Path -LiteralPath 'GlyphCut-Windows-x64.zip').Path
$temp = Join-Path ([IO.Path]::GetTempPath()) ('GlyphCut restart ' + [Guid]::NewGuid())
$install = Join-Path $temp 'GlyphCut-Windows-x64'
$exe = Join-Path $install 'GlyphCut.exe'
$log = Join-Path $temp 'progress.txt'

try {
    Expand-Archive -LiteralPath $zip -DestinationPath $temp
    $app = Join-Path $install 'resources/app'
    $packagePath = Join-Path $app 'package.json'
    $package = Get-Content -LiteralPath $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $release = @{
        version = $package.version
        zip = $zip
        size = (Get-Item -LiteralPath $zip).Length
        digest = (Get-FileHash -LiteralPath $zip).Hash.ToLowerInvariant()
        log = $log
    }
    [IO.File]::WriteAllText((Join-Path $app 'test-release.json'), ($release | ConvertTo-Json -Compress))
    $package.main = 'test-restart.cjs'
    $package.version = '0.0.0'
    [IO.File]::WriteAllText($packagePath, ($package | ConvertTo-Json))
    Set-Content -LiteralPath (Join-Path $app 'test-restart.cjs') -Encoding UTF8 -Value @'
const { app } = require("electron");
const { appendFileSync, createReadStream } = require("node:fs");
const { Readable } = require("node:stream");
const updateCode = require("./updates.cjs");
const release = require("./test-release.json");
const log = text => appendFileSync(release.log, text + "\n");
const createUpdater = updateCode.createUpdater;
updateCode.createUpdater = options => createUpdater({
  ...options,
  notify: state => {
    if (state.phase !== "downloading" || state.progress === 0) log(JSON.stringify(state));
    options.notify(state);
  },
  request: async target => {
    if (String(target).startsWith("https://api.github.com/")) {
      return new Response(JSON.stringify({
        tag_name: "v" + release.version,
        assets: [{
          name: "GlyphCut-Windows-x64.zip", state: "uploaded",
          size: release.size, digest: "sha256:" + release.digest
        }]
      }));
    }
    return new Response(Readable.toWeb(createReadStream(release.zip)));
  }
});

async function clickWhen(window, selector, expected) {
  for (let attempt = 0; attempt < 160; attempt++) {
    const clicked = await window.webContents.executeJavaScript(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element || element.hidden || (${JSON.stringify(expected)} && element.textContent !== ${JSON.stringify(expected)})) return false;
      element.click();
      return true;
    })()`);
    if (clicked) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for " + selector);
}

app.on("browser-window-created", (_, window) => {
  window.webContents.once("did-finish-load", async () => {
    try {
      await clickWhen(window, "#desktop-update", "");
      await clickWhen(window, "#desktop-update-action", "\u4e0b\u8f7d\u66f4\u65b0");
      await clickWhen(window, "#desktop-update-action", "\u91cd\u542f\u5e76\u66f4\u65b0");
    } catch (error) {
      log(error.stack);
      app.exit(1);
    }
  });
});
require("./main.cjs");
'@

    $old = Start-Process -FilePath $exe -WorkingDirectory $install -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    do {
        Start-Sleep -Milliseconds 350
        $replacement = Get-Process -Name GlyphCut -ErrorAction SilentlyContinue | Where-Object {
            $_.Id -ne $old.Id -and $_.Path -ieq $exe -and $_.MainWindowHandle -ne 0
        }
        $staging = Get-ChildItem -LiteralPath $install -Directory -Force -Filter '.glyphcut-update-*'
        if ($replacement -and -not $staging -and (Test-Path -LiteralPath $packagePath)) {
            $updated = Get-Content -LiteralPath $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($updated.version -eq $release.version -and $old.HasExited) {
                Write-Host "GlyphCut $($updated.version) restarted with a visible window after an in-app update."
                exit 0
            }
        }
        $failure = Join-Path $install '.glyphcut-update-error.txt'
        if (Test-Path -LiteralPath $failure) { throw (Get-Content -LiteralPath $failure -Raw -Encoding UTF8) }
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'The app did not restart into the updated version.'
} finally {
    if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log -Encoding UTF8 }
    Get-Process -Name GlyphCut -ErrorAction SilentlyContinue | Where-Object { $_.Path -ieq $exe } |
        Stop-Process -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
