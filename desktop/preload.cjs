"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("glyphCutDesktop", {
  recoverProject: () => ipcRenderer.invoke("project:recover"),
  autosaveProject: json => ipcRenderer.invoke("project:autosave", json),
  saveFile: (filename, data) => ipcRenderer.invoke("file:save", filename, data)
});
