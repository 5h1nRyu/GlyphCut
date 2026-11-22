"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("glyphCutDesktop", {
  loadProjects: () => ipcRenderer.invoke("project:load"),
  saveTemplate: template => ipcRenderer.invoke("project:saveTemplate", template),
  createFont: templateId => ipcRenderer.invoke("project:createFont", templateId),
  saveFont: (id, changes, simplified) => ipcRenderer.invoke("project:saveFont", id, changes, simplified),
  adaptFont: (id, template, glyphs) => ipcRenderer.invoke("project:adaptFont", id, template, glyphs),
  keepTemplate: id => ipcRenderer.invoke("project:keepTemplate", id),
  controlWindow: action => ipcRenderer.invoke("window:control", action),
  onMaximized: callback => {
    ipcRenderer.on("window:maximized", (_, maximized) => callback(maximized));
  },
  saveFile: (filename, data) => ipcRenderer.invoke("file:save", filename, data)
});
