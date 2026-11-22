"use strict";

const { spawn, execFile } = require("node:child_process");
const { createHash } = require("node:crypto");
const { once } = require("node:events");
const { createWriteStream, rmSync } = require("node:fs");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const { basename, dirname, join } = require("node:path");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { promisify } = require("node:util");

const execute = promisify(execFile);
const repository = "5h1nRyu/GlyphCut";
const archive = "GlyphCut-Windows-x64.zip";
const latest = `https://api.github.com/repos/${repository}/releases/latest`;
const versionPattern = /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/;
const downloadHosts = new Set(["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]);
const headers = { "User-Agent": "GlyphCut-Desktop" };

function findUpdate(data, current) {
  if (!data || data.draft || data.prerelease) return null;
  const tag = data.tag_name;
  const version = typeof tag === "string" ? tag.replace(/^v/, "") : "";
  if (!versionPattern.test(version) || !versionPattern.test(current)) return null;
  const oldParts = current.split(".").map(Number);
  const difference = version.split(".").map((part, index) => Number(part) - oldParts[index]).find(value => value !== 0);
  if (!(difference > 0)) return null;

  const asset = data.assets?.find(candidate => candidate.name === archive && candidate.state === "uploaded");
  const digest = /^sha256:([a-f0-9]{64})$/i.exec(asset?.digest ?? "")?.[1].toLowerCase();
  if (!asset || !digest || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 1024 ** 3) {
    throw new Error("最新版缺少可验证的 Windows x64 更新包。");
  }
  const url = `https://github.com/${repository}/releases/download/${tag}/${archive}`;
  return { version, url, digest, size: asset.size, notes: typeof data.body === "string" ? data.body.slice(0, 3000) : "" };
}

async function fetchArchive(request, release, target, signal, report) {
  let url = new URL(release.url);
  let response;
  for (let i = 0; i < 5; i++) {
    if (url.protocol !== "https:" || !downloadHosts.has(url.hostname) || url.username || url.password || url.port) {
      throw new Error("更新下载地址无效。");
    }
    response = await request(url, { signal, redirect: "manual", headers });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    await response.body?.cancel();
    const location = response.headers.get("location");
    if (!location) throw new Error("更新下载地址无效。");
    url = new URL(location, url);
  }
  if (!response?.ok || !response.body) {
    await response?.body?.cancel().catch(() => {});
    throw new Error("更新下载失败，请检查网络后重试。");
  }

  const hash = createHash("sha256");
  let received = 0;
  const measure = new Transform({
    transform(chunk, _, callback) {
      received += chunk.length;
      if (received > release.size) return callback(new Error("更新包大小与发布信息不一致。"));
      hash.update(chunk);
      report(Math.floor(received * 100 / release.size));
      callback(null, chunk);
    }
  });
  await pipeline(Readable.fromWeb(response.body), measure, createWriteStream(target, { flags: "wx" }), { signal });
  if (received !== release.size || hash.digest("hex") !== release.digest) {
    throw new Error("更新包校验失败，请重新下载。");
  }
}

function createUpdater({ version, executable, notify, request = fetch, supported =
  process.platform === "win32" && process.arch === "x64" && basename(executable).toLowerCase() === "glyphcut.exe" }) {
  const installDir = dirname(executable);
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  let state = { phase: supported ? "idle" : "unsupported", currentVersion: version };
  let release;
  let workDir;
  let downloadAbort;
  let installer;

  function publish(phase, detail = {}) {
    state = { phase, currentVersion: version, ...(release && { version: release.version, notes: release.notes }), ...detail };
    notify(state);
    return state;
  }

  async function argumentsFor(mode) {
    // Encode parameters separately so paths never become PowerShell source.
    const params = Buffer.from(JSON.stringify({
      mode, installDir, workDir, version: release.version, digest: release.digest, pid: process.pid
    })).toString("base64");
    const source = await readFile(join(__dirname, "portable-update.ps1"), "utf8");
    const script = `$Update = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${params}')) | ConvertFrom-Json\n${source}`;
    return ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
  }

  async function check() {
    if (!["idle", "current", "available", "checkFailed"].includes(state.phase)) return state;
    release = undefined;
    publish("checking");
    try {
      const response = await request(latest, {
        signal: AbortSignal.timeout(15000), redirect: "error", headers: { ...headers, Accept: "application/vnd.github+json" }
      });
      if (response.status === 404) return publish("current");
      if (!response.ok) throw new Error("无法查询 GitHub Releases，请稍后重试。");
      release = findUpdate(await response.json(), version);
      return publish(release ? "available" : "current");
    } catch (error) {
      return publish("checkFailed", { message: error.message.includes("最新版缺少") ? error.message : "无法检查更新，请检查网络后重试。" });
    }
  }

  async function download() {
    if (state.phase !== "available") return state;
    publish("downloading", { progress: 0 });
    try {
      workDir = await mkdtemp(join(installDir, ".glyphcut-update-"));
      const zip = join(workDir, "bundle.zip");
      downloadAbort = new AbortController();
      const signal = AbortSignal.any([downloadAbort.signal, AbortSignal.timeout(30 * 60 * 1000)]);
      await fetchArchive(request, release, zip, signal, progress => {
        if (progress !== state.progress) publish("downloading", { progress });
      });
      publish("preparing");
      await execute(powershell, await argumentsFor("stage"), { windowsHide: true, cwd: workDir, timeout: 180000 });
      await rm(zip);
      return publish("ready");
    } catch (error) {
      if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
      workDir = undefined;
      const message = state.phase === "preparing" ? "更新包解压或版本校验失败。" :
        typeof error.code === "string" && ["EACCES", "EPERM", "EROFS"].includes(error.code)
          ? "程序目录不可写。请将免安装版放在可写目录中。" :
          error.message.startsWith("更新") ? error.message : "下载更新失败，请检查网络和磁盘空间后重试。";
      return publish("available", { message });
    } finally {
      downloadAbort = undefined;
    }
  }

  async function install() {
    if (state.phase !== "ready") return false;
    publish("installing");
    try {
      // The helper must have a working directory outside the files it moves or removes.
      installer = spawn(powershell, await argumentsFor("apply"), {
        detached: true, windowsHide: true, stdio: "ignore", cwd: installDir
      });
      await once(installer, "spawn");
      installer.unref();
      return true;
    } catch {
      installer = undefined;
      publish("ready", { message: "无法启动更新器，请重试。" });
      return false;
    }
  }

  return {
    status: () => state, check, download, install,
    cancelInstall() {
      if (!installer) return;
      installer.kill();
      installer = undefined;
      publish("ready");
    },
    stop() {
      downloadAbort?.abort();
      if (!installer && workDir) {
        try { rmSync(workDir, { recursive: true, force: true }); } catch { /* Local staging may still be in use. */ }
      }
    }
  };
}

module.exports = { createUpdater, findUpdate, fetchArchive };
