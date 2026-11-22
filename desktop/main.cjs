"use strict";

const { app, BrowserWindow, dialog, ipcMain, protocol } = require("electron");
const { mkdir, readFile, rename, writeFile } = require("node:fs/promises");
const { basename, extname, join } = require("node:path");

const page = "glyph-cut://studio/index.html";
const files = new Map([
  ["/index.html", "text/html; charset=utf-8"],
  ["/style.css", "text/css; charset=utf-8"],
  ["/geometry.js", "text/javascript; charset=utf-8"],
  ["/truetype.js", "text/javascript; charset=utf-8"],
  ["/studio.js", "text/javascript; charset=utf-8"]
]);
const fileTypes = new Map([
  [".json", "项目 JSON"],
  [".svg", "SVG 矢量图"],
  [".png", "PNG 图像"],
  [".ttf", "TrueType 字体"]
]);
const contentPolicy = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; object-src 'none'; base-uri 'none'";
let mainWindow;
let recoveryWrite;

app.setName("Glyph Cut");
protocol.registerSchemesAsPrivileged([
  { scheme: "glyph-cut", privileges: { standard: true, secure: true } }
]);

function trustedWindow(event) {
  if (event.senderFrame?.url !== page || event.senderFrame.parent) {
    throw new Error("此页面无法访问桌面文件功能。");
  }
  return BrowserWindow.fromWebContents(event.sender);
}

function registerFiles() {
  protocol.handle("glyph-cut", async request => {
    const url = new URL(request.url);
    const type = files.get(url.pathname);
    if (url.host !== "studio" || request.method !== "GET" || !type) {
      return new Response(null, { status: 404 });
    }
    const data = await readFile(join(__dirname, "dist", basename(url.pathname)));
    return new Response(data, { headers: { "Content-Type": type, "Content-Security-Policy": contentPolicy } });
  });

  const directory = app.getPath("userData");
  const recovery = join(directory, "recovery.glyphs.json");
  ipcMain.handle("project:recover", async event => {
    trustedWindow(event);
    try {
      return await readFile(recovery, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  });
  ipcMain.handle("project:autosave", (event, json) => {
    trustedWindow(event);
    if (typeof json !== "string") throw new Error("恢复稿格式无效。");
    const write = (recoveryWrite ?? Promise.resolve()).catch(() => {}).then(async () => {
      await mkdir(directory, { recursive: true });
      const temporary = `${recovery}.tmp`;
      await writeFile(temporary, json, "utf8");
      await rename(temporary, recovery);
    });
    recoveryWrite = write;
    return write.finally(() => {
      if (recoveryWrite === write) recoveryWrite = undefined;
    });
  });
  ipcMain.handle("file:save", async (event, filename, data) => {
    const window = trustedWindow(event);
    if (typeof filename !== "string" || basename(filename) !== filename || !(data instanceof ArrayBuffer)) {
      throw new Error("导出文件格式无效。");
    }
    const extension = extname(filename);
    const name = fileTypes.get(extension);
    if (!name) throw new Error("不支持此导出格式。");
    const result = await dialog.showSaveDialog(window, {
      title: "保存文件",
      defaultPath: filename,
      filters: [{ name, extensions: [extension.slice(1)] }]
    });
    if (!result.canceled && result.filePath) await writeFile(result.filePath, Buffer.from(data));
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: "字形切片",
    width: 1320,
    height: 895,
    minWidth: 520,
    minHeight: 480,
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.setMenu(null);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", event => event.preventDefault());
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => { mainWindow = undefined; });
  mainWindow.loadURL(page).catch(error => {
    dialog.showErrorBox("字形切片启动失败", error.message);
    app.quit();
  });
}

if (app.requestSingleInstanceLock()) {
  app.on("second-instance", () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
  });
  app.whenReady().then(() => {
    registerFiles();
    createWindow();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", event => {
    if (!recoveryWrite) return;
    event.preventDefault();
    recoveryWrite.then(() => app.quit(), () => app.quit());
  });
} else {
  app.quit();
}
