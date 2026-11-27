"use strict";

(() => {
  if (globalThis.glyphCutDesktop) return;

  const collections = ["templates", "fonts"];
  const groups = {
    upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    lower: "abcdefghijklmnopqrstuvwxyz",
    digits: "0123456789"
  };
  const alphabet = Object.values(groups).join("");
  const nameKey = name => name.trim().normalize("NFC").toLowerCase();
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const matches = (snapshot, template) => snapshot.id === template?.id &&
    same(snapshot.spec, template.spec) && same(snapshot.disabledRegions, template.disabledRegions);
  let database;

  function result(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function openDatabase() {
    if (database) return database;
    database = new Promise((resolve, reject) => {
      const open = indexedDB.open("glyph-cut-workspace", 1);
      open.onupgradeneeded = () => {
        for (const kind of collections) open.result.createObjectStore(kind, { keyPath: "id" });
        open.result.createObjectStore("settings");
      };
      open.onsuccess = () => {
        const db = open.result;
        db.onversionchange = () => {
          db.close();
          database = undefined;
        };
        resolve(db);
      };
      open.onerror = () => reject(open.error);
    }).catch(error => {
      database = undefined;
      throw new Error("无法打开浏览器项目库。请检查此站点的存储权限。", { cause: error });
    });
    return database;
  }

  async function transact(mode, operation) {
    const db = await openDatabase();
    const transaction = db.transaction([...collections, "settings"], mode);
    const complete = new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error ?? new Error("项目保存已中止。"));
    });
    const stores = {
      templates: transaction.objectStore("templates"),
      fonts: transaction.objectStore("fonts"),
      settings: transaction.objectStore("settings")
    };
    try {
      const value = await operation(stores);
      await complete;
      return value;
    } catch (error) {
      try { transaction.abort(); } catch { /* The transaction has already finished. */ }
      await complete.catch(() => {});
      if (error.name === "QuotaExceededError") {
        throw new Error("浏览器存储空间不足。请导出备份或释放空间后重试。", { cause: error });
      }
      throw error;
    }
  }

  const read = operation => transact("readonly", operation);
  const write = operation => transact("readwrite", operation);

  function conflict(message = "此项目已在其他标签页修改，请重新打开项目。") {
    return Object.assign(new Error(message), { code: "project-conflict" });
  }

  async function requireRecord(store, id, revision) {
    const record = await result(store.get(id));
    if (revision !== undefined && record?._revision !== revision) throw conflict();
    if (!record) throw new Error(store.name === "templates" ? "找不到该模板。" : "找不到该字体。");
    return record;
  }

  function put(store, record) {
    const updated = { ...record, _revision: crypto.randomUUID() };
    store.put(updated);
    return updated;
  }

  function projectName(value) {
    const name = typeof value === "string" ? value.trim() : "";
    if (!name || name.length > 100) throw new Error("请输入 1–100 个字符的项目名称。");
    return name;
  }

  async function projectNames(stores) {
    const records = await Promise.all(collections.map(kind => result(stores[kind].getAll())));
    return new Set(records.flat().map(record => nameKey(record.name)));
  }

  async function requireUniqueName(stores, name, previous) {
    const key = nameKey(name);
    if (previous && nameKey(previous) === key) return;
    if ((await projectNames(stores)).has(key)) throw new Error("已有同名的模板或字体，请换一个名称。");
  }

  function uniqueName(names, base) {
    const trim = length => base.slice(0, length).replace(/[\uD800-\uDBFF]$/, "").trimEnd();
    let name = trim(100);
    for (let n = 2; names.has(nameKey(name)); n++) {
      const suffix = ` ${n}`;
      name = trim(100 - suffix.length) + suffix;
    }
    names.add(nameKey(name));
    return name;
  }

  function templateData(input, id = crypto.randomUUID()) {
    const { name, spec, disabledRegions } = input;
    return { format: "glyph-cut-template", id, name: projectName(name), spec, disabledRegions };
  }

  function fontData(template, input, id = crypto.randomUUID()) {
    const { name, glyphs, baseline = 86, spacing = 18, sample = "", autoSample = sample === "" || sample === "ABC 123" } = input;
    const selected = input.characterGroups ?? Object.keys(groups);
    if (!Array.isArray(selected) || !selected.length || selected.some(group => !Object.hasOwn(groups, group))) {
      throw new Error("请选择有效的字库范围。");
    }
    const characterGroups = Object.keys(groups).filter(group => selected.includes(group));
    const characters = characterGroups.map(group => groups[group]).join("");
    const character = input.character ?? characters[0];
    if (!glyphs || typeof glyphs !== "object" || Array.isArray(glyphs) ||
        !Object.keys(glyphs).every(ch => ch.length === 1 && alphabet.includes(ch)) ||
        !Number.isFinite(baseline) || baseline < 0 || baseline > 100 ||
        !Number.isFinite(spacing) || spacing < 0 || spacing > 8192 ||
        typeof sample !== "string" || sample.length > 100 || typeof autoSample !== "boolean" ||
        typeof character !== "string" || character.length !== 1 || !characters.includes(character)) {
      throw new Error("字体数据无效。");
    }
    const { _revision, ...snapshot } = template;
    return { format: "glyph-cut-font", id, name: projectName(name), template: snapshot, glyphs, baseline, spacing,
      sample, autoSample, characterGroups, character, ...(input.unconfirmed === true ? { unconfirmed: true } : {}) };
  }

  async function saveLegacyDraft(stores, base, spec) {
    const names = await projectNames(stores);
    const name = uniqueName(names, base.slice(0, 88).replace(/[\uD800-\uDBFF]$/, "") + "（未生成草稿）");
    put(stores.templates, templateData({ name, spec, disabledRegions: [] }));
  }

  async function ordered(stores, kind) {
    const [records, order] = await Promise.all([result(stores[kind].getAll()), result(stores.settings.get(kind))]);
    const positions = new Map((order ?? []).map((id, index) => [id, index]));
    const position = record => positions.get(record.id) ?? positions.size;
    return records.sort((a, b) => position(a) - position(b) || a.name.localeCompare(b.name, "zh-CN") || a.id.localeCompare(b.id));
  }

  async function fontForEdit(stores, id, revision) {
    const font = await requireRecord(stores.fonts, id, revision);
    const current = await result(stores.templates.get(font.template.id));
    if (current && !matches(font.template, current)) throw conflict("关联模板已更改，请重新打开字体处理模板变更。");
    return { font, current };
  }

  globalThis.GlyphCutWebProjects = {
    loadProjects: () => read(async stores => {
      const [templates, fonts] = await Promise.all(collections.map(kind => ordered(stores, kind)));
      return { templates, fonts, warnings: [] };
    }),

    reorderProjects: (kind, ids, previousOrder) => write(async stores => {
      const current = (await ordered(stores, kind)).map(record => record.id);
      if (!same(current, previousOrder)) throw conflict("菜单里的项目或顺序已变更，已刷新列表。");
      stores.settings.put(ids, kind);
    }),

    saveTemplate: (input, revision, legacyDraft) => write(async stores => {
      const previous = input.id ? await requireRecord(stores.templates, input.id, revision) : undefined;
      const template = templateData(input, previous?.id);
      await requireUniqueName(stores, template.name, previous?.name);
      const saved = put(stores.templates, template);
      if (legacyDraft) await saveLegacyDraft(stores, template.name, legacyDraft);
      return saved;
    }),

    copyProject: (kind, id, name) => write(async stores => {
      const store = kind === "template" ? stores.templates : stores.fonts;
      const original = await requireRecord(store, id);
      name = projectName(name);
      await requireUniqueName(stores, name);
      const input = { ...original, name, unconfirmed: false };
      return put(store, kind === "template" ? templateData(input) : fontData(original.template, input));
    }),

    deleteProject: (kind, id, linked, revision, linkedRevisions) => write(async stores => {
      const store = kind === "template" ? stores.templates : stores.fonts;
      await requireRecord(store, id, revision);
      if (kind === "template" && linked) {
        const fonts = (await result(stores.fonts.getAll())).filter(font => font.template.id === id);
        const expected = new Map(linkedRevisions);
        if (fonts.length !== expected.size || fonts.some(font => expected.get(font.id) !== font._revision)) {
          throw conflict("关联字体已更改，请刷新菜单后重新确认删除。");
        }
        for (const font of fonts) stores.fonts.delete(font.id);
      }
      store.delete(id);
    }),

    createFont: (templateId, { name, characterGroups }, revision) => write(async stores => {
      const template = await requireRecord(stores.templates, templateId, revision);
      const font = fontData(template, { name, characterGroups, glyphs: {}, unconfirmed: true });
      await requireUniqueName(stores, font.name);
      return put(stores.fonts, font);
    }),

    importFont: (input, standaloneName, legacyDraft) => write(async stores => {
      const template = templateData({ ...input.template, name: standaloneName ?? input.template.name });
      const font = fontData(template, { ...input, unconfirmed: false });
      await requireUniqueName(stores, font.name);
      if (standaloneName !== undefined) {
        if (nameKey(font.name) === nameKey(template.name)) throw new Error("字体和独立模板的名称不能相同。");
        await requireUniqueName(stores, template.name);
        put(stores.templates, template);
      }
      const saved = put(stores.fonts, font);
      if (legacyDraft) await saveLegacyDraft(stores, template.name, legacyDraft);
      return saved;
    }),

    saveFont: (id, changes, revision) => write(async stores => {
      const { font, current } = await fontForEdit(stores, id, revision);
      const updated = fontData(current ?? font.template, { ...changes, unconfirmed: font.unconfirmed }, id);
      await requireUniqueName(stores, updated.name, font.name);
      return { font: put(stores.fonts, updated) };
    }),

    confirmFont: (id, revision) => write(async stores => {
      const font = await requireRecord(stores.fonts, id, revision);
      if (!font.unconfirmed) return font;
      delete font.unconfirmed;
      return put(stores.fonts, font);
    }),

    simplifyFont: (id, input, revision) => write(async stores => {
      const { font, current } = await fontForEdit(stores, id, revision);
      if (input.destination === "original" && !current) throw new Error("原模板已删除，请保存为独立模板。");
      const original = input.destination === "original" ? current : undefined;
      const template = templateData({ ...input, name: original?.name ?? input.name }, original?.id);
      if (!original) await requireUniqueName(stores, template.name);
      const next = fontData(template, { ...font, glyphs: input.glyphs }, id);
      return { template: put(stores.templates, template), font: put(stores.fonts, next) };
    }),

    adaptFont: (id, previewTemplate, glyphs, revision) => write(async stores => {
      const font = await requireRecord(stores.fonts, id, revision);
      const current = await requireRecord(stores.templates, font.template.id);
      if (!matches(previewTemplate, current)) throw conflict("模板在预览后已更改，请重新打开字体预览。");
      if (matches(font.template, current)) throw new Error("字体已使用当前模板。");
      return put(stores.fonts, fontData(current, { ...font, glyphs }, id));
    }),

    keepTemplate: (id, name, revision) => write(async stores => {
      const font = await requireRecord(stores.fonts, id, revision);
      const current = await result(stores.templates.get(font.template.id));
      if (matches(font.template, current)) throw new Error("字体已使用当前模板。");
      const template = templateData({ ...font.template, name });
      await requireUniqueName(stores, template.name);
      return { template: put(stores.templates, template), font: put(stores.fonts, fontData(template, font, id)) };
    }),

    migrateLegacy: readLegacy => write(async stores => {
      if (await result(stores.settings.get("legacy-migrated"))) return false;
      const legacy = readLegacy();
      if (!legacy) return false;
      const names = await projectNames(stores);
      const template = templateData({
        name: uniqueName(names, legacy.templateName),
        spec: legacy.template ?? legacy.draft,
        disabledRegions: legacy.disabledRegions
      });
      put(stores.templates, template);
      if (legacy.hasFont) {
        put(stores.fonts, fontData(template, { ...legacy, name: uniqueName(names, legacy.fontName) }));
      }
      if (legacy.template && !same(legacy.draft, legacy.template)) {
        await saveLegacyDraft(stores, template.name, legacy.draft);
      }
      stores.settings.put(true, "legacy-migrated");
      return true;
    })
  };
})();
