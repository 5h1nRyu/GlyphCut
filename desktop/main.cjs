"use strict";

const { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } = require("electron");
const { readFile, unlink, writeFile } = require("node:fs/promises");
const { basename, dirname, extname, join } = require("node:path");
const { createProjects } = require("./projects.cjs");
const { createUpdater, createUpdateRequest, releasePage } = require("./updates.cjs");

const page = "glyph-cut://studio/index.html";
const files = new Map([
  ["/index.html", "text/html; charset=utf-8"],
  ["/style.css", "text/css; charset=utf-8"],
  ["/geometry.js", "text/javascript; charset=utf-8"],
  ["/truetype.js", "text/javascript; charset=utf-8"],
  ["/workspace.js", "text/javascript; charset=utf-8"],
  ["/workspace.css", "text/css; charset=utf-8"],
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
let projects;
let updates;

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
    let data = await readFile(join(__dirname, "dist", basename(url.pathname)));
    if (url.pathname === "/index.html") {
      const shell = await readFile(join(__dirname, "workspace.html"), "utf8");
      data = data.toString("utf8")
        .replace('<script defer src="studio.js"></script>',
          '<link rel="stylesheet" href="workspace.css"><script defer src="workspace.js"></script><script defer src="studio.js"></script>')
        .replace("<body>", '<body class="desktop-app">' + shell);
    }
    return new Response(data, { headers: { "Content-Type": type, "Content-Security-Policy": contentPolicy } });
  });

  projects = createProjects(join(app.getPath("userData"), "workspace"));
  for (const method of ["load", "saveTemplate", "createFont", "saveFont", "confirmFont", "adaptFont", "keepTemplate"]) {
    ipcMain.handle(`project:${method}`, (event, ...args) => {
      trustedWindow(event);
      return projects[method](...args);
    });
  }
  ipcMain.handle("project:delete", (event, kind, id, linked) => {
    trustedWindow(event);
    if (kind === "template") return projects.deleteTemplate(id, linked);
    if (kind === "font") return projects.deleteFont(id);
    throw new Error("项目类型无效。");
  });
  updates = createUpdater({
    version: app.getVersion(), executable: process.execPath,
    request: createUpdateRequest(net),
    notify: state => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("update:state", state);
    }
  });
  for (const method of ["status", "check", "download"]) {
    ipcMain.handle(`update:${method}`, event => {
      trustedWindow(event);
      return updates[method]();
    });
  }
  ipcMain.handle("update:open-release", event => {
    trustedWindow(event);
    return shell.openExternal(releasePage);
  });
  ipcMain.handle("update:install", async event => {
    trustedWindow(event);
    if (await updates.install()) app.quit();
  });
  ipcMain.handle("window:control", (event, action) => {
    const window = trustedWindow(event);
    if (action === "minimize") window.minimize();
    if (action === "maximize") {
      if (window.isMaximized()) window.unmaximize();
      else window.maximize();
    }
    if (action === "close") window.close();
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
    width: 990,
    height: 671,
    minWidth: 520,
    minHeight: 480,
    frame: false,
    backgroundColor: "#edf0f5",
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
  mainWindow.webContents.on("will-prevent-unload", () => {
    updates.cancelInstall();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("window:save-before-close");
  });
  for (const name of ["maximize", "unmaximize"]) {
    mainWindow.on(name, () => mainWindow.webContents.send("window:maximized", mainWindow.isMaximized()));
  }
  mainWindow.once("ready-to-show", async () => {
    const window = mainWindow;
    window.show();
    if (updates.status().phase === "unsupported") return;
    const installDir = dirname(process.execPath);
    const updateSession = process.env.GLYPHCUT_UPDATE_SESSION;
    delete process.env.GLYPHCUT_UPDATE_SESSION;
    if (updateSession && /^\.glyphcut-update-[a-z0-9]{6}$/i.test(updateSession)) {
      await writeFile(join(installDir, updateSession, "window-ready"), "", { flag: "wx" }).catch(() => {});
    }
    const log = join(installDir, ".glyphcut-update-error.txt");
    try {
      const detail = await readFile(log, "utf8");
      await unlink(log);
      if (!window.isDestroyed()) await dialog.showMessageBox(window, { type: "warning", title: "字形切片", message: detail.trim() });
    } catch { /* A normal startup has no update failure to report. */ }
  });
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
  app.on("will-quit", () => updates?.approveInstall());
  app.on("quit", () => updates?.stop());
  app.on("before-quit", event => {
    const write = projects?.pending();
    if (!write) return;
    event.preventDefault();
    write.then(() => app.quit(), () => app.quit());
  });
} else {
  app.quit();
}
