"use strict";

const { randomUUID } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { mkdir, readdir, readFile, rename, rm, writeFile } = require("node:fs/promises");
const { join } = require("node:path");

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const templateFormat = "glyph-cut-template";
const fontFormat = "glyph-cut-font";

function templateMatches(snapshot, template) {
  return snapshot.id === template?.id && isDeepStrictEqual(snapshot.spec, template.spec) &&
    isDeepStrictEqual(snapshot.disabledRegions, template.disabledRegions);
}

function templateData(input, id) {
  const { name, spec, disabledRegions } = input;
  if (typeof id !== "string" || !uuid.test(id) || typeof name !== "string" || !name.trim() || name.length > 100 ||
      !spec || !Array.isArray(spec.strokes) || !Array.isArray(disabledRegions) ||
      !disabledRegions.every(index => Number.isInteger(index) && index >= 0)) {
    throw new Error("模板数据无效。");
  }
  return { format: templateFormat, id, name: name.trim(), spec, disabledRegions };
}

function fontData(template, project, id) {
  const { name, glyphs, baseline, spacing, sample, character } = project;
  if (typeof name !== "string" || !name.trim() || name.length > 100 ||
      !glyphs || typeof glyphs !== "object" || Array.isArray(glyphs) ||
      !Object.entries(glyphs).every(([ch, ids]) => /^[A-Za-z0-9]$/.test(ch) &&
        Array.isArray(ids) && ids.every(index => Number.isInteger(index) && index >= 0)) ||
      !Number.isFinite(baseline) || baseline < 0 || baseline > 100 ||
      !Number.isFinite(spacing) || spacing < 0 || spacing > 8192 ||
      typeof sample !== "string" || sample.length > 100 ||
      typeof character !== "string" || !/^[A-Za-z0-9]$/.test(character)) {
    throw new Error("字体数据无效。");
  }
  return { format: fontFormat, id, name: name.trim(), template, glyphs, baseline, spacing, sample, character };
}

function createProjects(root) {
  let pending;

  function path(kind, id) {
    if (typeof id !== "string" || !uuid.test(id)) throw new Error("项目标识无效。");
    return join(root, kind, id + ".json");
  }

  async function read(kind, id) {
    try {
      const value = JSON.parse(await readFile(path(kind, id), "utf8"));
      const format = kind === "templates" ? templateFormat : fontFormat;
      if (value.format !== format || value.id !== id) throw new Error("项目文件格式无效。");
      return kind === "templates" ? templateData(value, id) : fontData(templateData(value.template, value.template.id), value, id);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async function write(kind, record) {
    const filename = path(kind, record.id);
    const temporary = filename + ".tmp";
    await mkdir(join(root, kind), { recursive: true });
    try {
      await writeFile(temporary, JSON.stringify(record, null, 2) + "\n", "utf8");
      await rename(temporary, filename);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
    return record;
  }

  function queue(operation) {
    const result = (pending ?? Promise.resolve()).catch(() => {}).then(operation);
    pending = result;
    return result.finally(() => {
      if (pending === result) pending = undefined;
    });
  }

  async function list(kind, warnings) {
    const directory = join(root, kind);
    const names = await readdir(directory).catch(error => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const items = [];
    for (const name of names) {
      if (!name.endsWith(".json") || !uuid.test(name.slice(0, -5))) continue;
      try {
        const item = await read(kind, name.slice(0, -5));
        if (item) items.push(item);
      } catch {
        warnings.push(kind + "/" + name);
      }
    }
    return items.sort((a, b) => a.name.localeCompare(b.name, "zh-CN") || a.id.localeCompare(b.id));
  }

  async function requireRecord(kind, id) {
    const record = await read(kind, id);
    if (!record) throw new Error(kind === "templates" ? "找不到该模板。" : "找不到该字体。");
    return record;
  }

  async function fork(font, input, changes = font) {
    const existing = await list("templates", []);
    const base = input.name.slice(0, 84);
    let name = base;
    for (let i = 2; existing.some(template => template.name === name); i++) name = `${base} ${i}`;
    const template = templateData({ ...input, name }, randomUUID());
    const next = fontData(template, changes, font.id);
    await write("templates", template);
    try {
      await write("fonts", next);
    } catch (error) {
      await rm(path("templates", template.id), { force: true }).catch(() => {});
      throw error;
    }
    return { template, font: next };
  }

  return {
    pending: () => pending,
    async load() {
      await pending;
      const warnings = [];
      const [templates, fonts] = await Promise.all([list("templates", warnings), list("fonts", warnings)]);
      return { templates, fonts, warnings };
    },
    saveTemplate: input => queue(async () => {
      if (input.id) await requireRecord("templates", input.id);
      return write("templates", templateData(input, input.id ?? randomUUID()));
    }),
    createFont: templateId => queue(async () => {
      const template = await requireRecord("templates", templateId);
      const font = fontData(template, {
        name: `${template.name.slice(0, 96)} 字体`,
        glyphs: {}, baseline: 86, spacing: 18, sample: "ABC 123", character: "A"
      }, randomUUID());
      return write("fonts", font);
    }),
    saveFont: (id, changes, simplified) => queue(async () => {
      const font = await requireRecord("fonts", id);
      const current = await read("templates", font.template.id);
      if (!templateMatches(font.template, current)) throw new Error("关联模板已更改，请先处理模板变更。");
      if (simplified) return fork(font, { ...simplified, name: `${current.name}（简化）` }, changes);
      return { font: await write("fonts", fontData(current, changes, id)) };
    }),
    adaptFont: (id, previewTemplate, glyphs) => queue(async () => {
      const font = await requireRecord("fonts", id);
      const current = await requireRecord("templates", font.template.id);
      if (!templateMatches(previewTemplate, current)) throw new Error("模板在预览后已更改，请重新预览。");
      if (templateMatches(font.template, current)) throw new Error("字体已使用当前模板。");
      return write("fonts", fontData(current, { ...font, glyphs }, id));
    }),
    keepTemplate: id => queue(async () => {
      const font = await requireRecord("fonts", id);
      if (templateMatches(font.template, await read("templates", font.template.id))) {
        throw new Error("字体已使用当前模板。");
      }
      return fork(font, { ...font.template, name: `${font.template.name}（保留）` });
    })
  };
}

module.exports = { createProjects };
