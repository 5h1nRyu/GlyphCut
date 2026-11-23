"use strict";

const { randomUUID } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } = require("node:fs/promises");
const { join } = require("node:path");

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const templateFormat = "glyph-cut-template";
const fontFormat = "glyph-cut-font";
const characterSets = {
  upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  lower: "abcdefghijklmnopqrstuvwxyz",
  digits: "0123456789"
};
const allGroups = Object.keys(characterSets);
const nameKey = name => name.trim().normalize("NFC").toLowerCase();

function projectName(name) {
  if (typeof name !== "string" || !name.trim() || name.trim().length > 100) {
    throw new Error("请输入 1–100 个字符的项目名称。");
  }
  return name.trim();
}

function validateGroups(groups = allGroups) {
  if (!Array.isArray(groups) || !groups.length || Array.from(groups).some(group => !allGroups.includes(group))) {
    throw new Error("请选择有效的字形范围。");
  }
  return allGroups.filter(group => groups.includes(group));
}

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
  const { name, glyphs, baseline, spacing, sample, character,
    autoSample = sample === "" || sample === "ABC 123" } = project;
  const characterGroups = validateGroups(project.characterGroups);
  const characters = characterGroups.map(group => characterSets[group]).join("");
  if (typeof name !== "string" || !name.trim() || name.length > 100 ||
      !glyphs || typeof glyphs !== "object" || Array.isArray(glyphs) ||
      !Object.entries(glyphs).every(([ch, ids]) => ch.length === 1 && characters.includes(ch) &&
        Array.isArray(ids) && ids.every(index => Number.isInteger(index) && index >= 0)) ||
      !Number.isFinite(baseline) || baseline < 0 || baseline > 100 ||
      !Number.isFinite(spacing) || spacing < 0 || spacing > 8192 ||
      typeof sample !== "string" || sample.length > 100 || typeof autoSample !== "boolean" ||
      typeof character !== "string" || character.length !== 1 || !characters.includes(character)) {
    throw new Error("字体数据无效。");
  }
  return { format: fontFormat, id, name: name.trim(), template, glyphs, baseline, spacing, sample, autoSample,
    characterGroups, character,
    ...(project.unconfirmed === true ? { unconfirmed: true } : {}) };
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

  async function projectNames() {
    const [templates, fonts] = await Promise.all([list("templates", []), list("fonts", [])]);
    return new Set([...templates, ...fonts].map(record => nameKey(record.name)));
  }

  async function requireUniqueName(name, previous) {
    const key = nameKey(name);
    if (previous && nameKey(previous) === key) return;
    if ((await projectNames()).has(key)) throw new Error("已有同名的模板或字体，请换一个名称。");
  }

  async function suggestedName(base, decoration = "") {
    const names = await projectNames();
    const withSuffix = suffix => base.slice(0, 100 - suffix.length).replace(/[\uD800-\uDBFF]$/, "") + suffix;
    let name = withSuffix(decoration);
    for (let n = 2; names.has(nameKey(name)); n++) name = withSuffix(`${decoration} ${n}`);
    return name;
  }

  async function deleteLinkedProjects(id) {
    await requireRecord("templates", id);
    const linked = (await list("fonts", [])).filter(font => font.template.id === id);
    const records = linked.map(font => ["fonts", font.id]);
    records.push(["templates", id]);
    const staging = await mkdtemp(join(root, ".deleting-"));
    const moved = [];
    try {
      for (const [kind, recordId] of records) {
        const source = path(kind, recordId);
        const destination = join(staging, `${kind}-${recordId}.json`);
        await rename(source, destination);
        moved.push({ source, destination });
      }
    } catch (error) {
      const restored = await Promise.allSettled(moved.map(({ source, destination }) => rename(destination, source)));
      if (restored.some(result => result.status === "rejected")) {
        throw new Error(`部分项目无法恢复，文件保存在 ${staging}。`, { cause: error });
      }
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }

  async function saveTemplateAndFont(id, template, changes, previousTemplate) {
    const next = fontData(template, changes, id);
    await write("templates", template);
    try {
      await write("fonts", next);
    } catch (error) {
      try {
        if (previousTemplate) await write("templates", previousTemplate);
        else await rm(path("templates", template.id), { force: true });
      } catch (rollbackError) {
        throw new Error("保存字体失败，且无法回退模板。请重新打开项目。", { cause: rollbackError });
      }
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
      const previous = input.id ? await requireRecord("templates", input.id) : null;
      const template = templateData(input, input.id ?? randomUUID());
      await requireUniqueName(template.name, previous?.name);
      return write("templates", template);
    }),
    copyProject: (kind, id, name) => queue(async () => {
      if (kind !== "template" && kind !== "font") throw new Error("项目类型无效。");
      const collection = kind === "template" ? "templates" : "fonts";
      const original = await requireRecord(collection, id);
      const fields = { ...original, name: projectName(name), unconfirmed: false };
      await requireUniqueName(fields.name);
      const nextId = randomUUID();
      const copy = kind === "template" ? templateData(fields, nextId) : fontData(original.template, fields, nextId);
      return write(collection, copy);
    }),
    deleteTemplate: (id, linked) => queue(() => linked === true ?
      deleteLinkedProjects(id) : rm(path("templates", id), { force: true })),
    deleteFont: id => queue(() => rm(path("fonts", id), { force: true })),
    createFont: (templateId, options = {}) => queue(async () => {
      const template = await requireRecord("templates", templateId);
      const characterGroups = validateGroups(options.characterGroups);
      const font = fontData(template, {
        name: options.name === undefined ? await suggestedName(template.name, " 字体") : projectName(options.name),
        glyphs: {}, baseline: 86, spacing: 18, sample: "",
        characterGroups, character: characterSets[characterGroups[0]][0], unconfirmed: true
      }, randomUUID());
      await requireUniqueName(font.name);
      return write("fonts", font);
    }),
    importFont: (input, standaloneName) => queue(async () => {
      const name = projectName(input.name);
      const standalone = standaloneName !== undefined;
      const templateName = projectName(standalone ? standaloneName : input.template.name);
      const template = templateData({ ...input.template, name: templateName }, randomUUID());
      const fields = { ...input, name, unconfirmed: false };
      const id = randomUUID();
      await requireUniqueName(name);
      if (standalone) {
        if (nameKey(name) === nameKey(template.name)) throw new Error("字体和独立模板的名称不能相同。");
        await requireUniqueName(template.name);
        return (await saveTemplateAndFont(id, template, fields)).font;
      }
      return write("fonts", fontData(template, fields, id));
    }),
    saveFont: (id, changes) => queue(async () => {
      const font = await requireRecord("fonts", id);
      const current = await read("templates", font.template.id);
      if (current && !templateMatches(font.template, current)) throw new Error("关联模板已更改，请先处理模板变更。");
      const template = current ?? font.template;
      const fields = { ...changes, characterGroups: font.characterGroups, unconfirmed: font.unconfirmed };
      const next = fontData(template, fields, id);
      await requireUniqueName(next.name, font.name);
      return { font: await write("fonts", next) };
    }),
    simplifyFont: (id, input) => queue(async () => {
      const font = await requireRecord("fonts", id);
      const current = await read("templates", font.template.id);
      if (current && !templateMatches(font.template, current)) throw new Error("关联模板已更改，请先处理模板变更。");
      let template;
      if (input.destination === "original") {
        if (!current) throw new Error("原模板已删除，请保存为独立模板。");
        template = templateData({ ...input, name: current.name }, current.id);
      } else if (input.destination === "independent") {
        template = templateData({ ...input, name: projectName(input.name) }, randomUUID());
        await requireUniqueName(template.name);
      } else {
        throw new Error("请选择简化模板的保存方式。");
      }
      const previousTemplate = input.destination === "original" ? current : null;
      return saveTemplateAndFont(font.id, template, { ...font, glyphs: input.glyphs }, previousTemplate);
    }),
    confirmFont: id => queue(async () => {
      const font = await requireRecord("fonts", id);
      if (!font.unconfirmed) return font;
      delete font.unconfirmed;
      return write("fonts", font);
    }),
    adaptFont: (id, previewTemplate, glyphs) => queue(async () => {
      const font = await requireRecord("fonts", id);
      const current = await requireRecord("templates", font.template.id);
      if (!templateMatches(previewTemplate, current)) throw new Error("模板在预览后已更改，请重新预览。");
      if (templateMatches(font.template, current)) throw new Error("字体已使用当前模板。");
      return write("fonts", fontData(current, { ...font, glyphs }, id));
    }),
    keepTemplate: (id, name) => queue(async () => {
      const font = await requireRecord("fonts", id);
      if (templateMatches(font.template, await read("templates", font.template.id))) {
        throw new Error("字体已使用当前模板。");
      }
      const template = templateData({ ...font.template, name: projectName(name) }, randomUUID());
      await requireUniqueName(template.name);
      return saveTemplateAndFont(font.id, template, font);
    })
  };
}

module.exports = { createProjects };
