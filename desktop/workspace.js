"use strict";

(() => {
  const desktop = globalThis.glyphCutDesktop;
  const G = globalThis.GlyphGeometry;
  const $ = id => document.getElementById(id);
  const menu = $("desktop-menu");
  const editorBar = $("desktop-editor-bar");
  const resolvePanel = $("desktop-resolve");
  const nameInput = $("desktop-template-name");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const svgNS = "http://www.w3.org/2000/svg";
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const sameShape = (a, b) => same(a.spec, b.spec) && same(a.disabledRegions, b.disabledRegions);
  let studio;
  let page;
  let editingRecord;
  let savedEditorState;
  let resolvingFont;
  let preview;
  let busy = false;
  let templates = new Map();
  let fonts = new Map();

  const project = () => studio.project();
  const templateFields = () => ({ spec: project().draft, disabledRegions: project().disabledRegions });
  const fontFields = () => {
    const p = project();
    return { name: p.fontName.trim(), glyphs: p.glyphs, baseline: p.baseline, spacing: p.spacing,
      sample: p.sample, character: p.character };
  };
  const editing = () => page === "template" || page === "font";
  const simplified = () => page === "font" && !sameShape(editingRecord.template, templateFields());
  function editorState() {
    if (page === "template") return { name: nameInput.value.trim(), ...templateFields() };
    const { character, ...fields } = fontFields();
    return { ...fields, ...templateFields() };
  }
  const dirty = () => editing() && (!editingRecord || !same(editorState(), savedEditorState));
  const pendingTemplate = font => {
    const current = templates.get(font.template.id);
    return Boolean(current && !sameShape(font.template, current));
  };

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function glyphPath(geometry, ids) {
    return ids?.length ? G.path(G.trace(geometry, new Set(ids))) : "";
  }

  function art(spec) {
    const svg = document.createElementNS(svgNS, "svg");
    svg.classList.add("desktop-art");
    svg.setAttribute("viewBox", `-2 -2 ${spec.width + 4} ${spec.height + 4}`);
    svg.setAttribute("aria-hidden", "true");
    return svg;
  }

  function addPath(svg, d, className, fill) {
    const path = document.createElementNS(svgNS, "path");
    if (className) path.setAttribute("class", className);
    path.setAttribute("d", d);
    path.setAttribute("fill", fill);
    svg.append(path);
  }

  function templateArt(template) {
    const spec = template.spec;
    const svg = art(spec);
    const geometry = studio.geometry(spec);
    addPath(svg, glyphPath(geometry, template.disabledRegions), "template-disabled", "currentColor");
    const lines = geometry.boundary.concat(geometry.unused).map(({ a, b, c }) =>
      `M${a.join(" ")}${c ? `Q${c.join(" ")} ${b.join(" ")}` : `L${b.join(" ")}`}`).join("");
    addPath(svg, lines, "template-line", "none");
    return svg;
  }

  function fontArt(font) {
    const sample = font.sample.trim();
    if (!sample) return icon("i-glyph");
    const spec = font.template.spec;
    const svg = art(spec);
    svg.classList.add("desktop-font-sample");
    const geometry = studio.geometry(spec);
    const advance = spec.width + 2 * font.spacing;
    let offset = 0;
    let count = 0;
    for (const character of sample) {
      if (count === 7) break;
      if (character === " ") {
        offset += advance / 2;
        continue;
      }
      const ids = font.glyphs[character];
      if (ids?.length) {
        const glyph = document.createElementNS(svgNS, "g");
        glyph.setAttribute("transform", `translate(${offset + font.spacing} 0)`);
        addPath(glyph, glyphPath(geometry, ids), "", "currentColor");
        svg.append(glyph);
      } else {
        const placeholder = document.createElementNS(svgNS, "text");
        placeholder.setAttribute("x", String(offset + advance / 2));
        placeholder.setAttribute("y", String(spec.height / 2));
        placeholder.setAttribute("font-size", String(Math.min(spec.height * 0.65, advance)));
        placeholder.textContent = character;
        svg.append(placeholder);
      }
      offset += advance;
      count++;
    }
    svg.setAttribute("viewBox", `0 0 ${offset} ${spec.height}`);
    return svg;
  }

  function icon(id) {
    const svg = document.createElementNS(svgNS, "svg");
    const use = document.createElementNS(svgNS, "use");
    use.setAttribute("href", "#" + id);
    svg.setAttribute("aria-hidden", "true");
    svg.append(use);
    return svg;
  }

  function card(title, subtitle, image, handler, className = "") {
    const button = element("button", `desktop-card ${className}`);
    button.type = "button";
    const visual = element("span", "desktop-card-visual");
    visual.append(image);
    const caption = element("span", "desktop-card-caption");
    caption.append(element("strong", "", title));
    if (subtitle) caption.append(element("small", "", subtitle));
    button.append(visual, caption);
    button.addEventListener("click", () => run(handler));
    return button;
  }

  function projectCard(record, kind, options) {
    const { status, image, open, className } = options;
    const wrapper = element("div", "desktop-card-slot");
    const remove = element("button", "desktop-delete");
    remove.type = "button";
    const label = `删除${kind === "template" ? "模板" : "字体"}「${record.name}」`;
    remove.title = label;
    remove.setAttribute("aria-label", label);
    remove.append(icon("desktop-trash-icon"));
    remove.addEventListener("click", () => run(async () => {
      if (!await desktop.deleteProject(kind, record.id)) return;
      const records = kind === "template" ? templates : fonts;
      records.delete(record.id);
      showMenu(page);
      studio.notify(`已${label}。`);
      requestAnimationFrame(() => {
        ($("desktop-cards").querySelector(".desktop-card") ?? $("desktop-menu-title")).focus({ preventScroll: true });
      });
    }));
    wrapper.append(card(record.name, status, image, open, className), remove);
    return wrapper;
  }

  function setPage(next) {
    page = next;
    menu.hidden = next !== "templates" && next !== "fonts";
    editorBar.hidden = !editing();
    resolvePanel.hidden = next !== "resolve";
    document.body.classList.toggle("desktop-editing", editing());
    document.body.classList.toggle("desktop-resolving", next === "resolve");
  }

  function showMenu(next) {
    editingRecord = null;
    resolvingFont = null;
    preview = null;
    setPage(next);
    const isTemplates = next === "templates";
    const cards = $("desktop-cards");
    const title = $("desktop-menu-title");
    title.textContent = isTemplates ? "模板菜单" : "字体菜单";
    $("desktop-prev-menu").hidden = isTemplates;
    $("desktop-next-menu").hidden = !isTemplates;
    $("desktop-empty").hidden = isTemplates || fonts.size > 0;
    cards.replaceChildren();

    if (isTemplates) {
      for (const template of templates.values()) {
        const linked = [...fonts.values()].filter(font => font.template.id === template.id).length;
        cards.append(projectCard(template, "template", {
          status: `${linked} 个关联字体`, image: templateArt(template), open: () => openTemplate(template)
        }));
      }
      cards.append(card("创建新模板", "", icon("i-plus"), () => openTemplate(null), "desktop-card-new"));
    } else {
      for (const font of fonts.values()) {
        const stale = pendingTemplate(font);
        const linked = templates.get(font.template.id);
        cards.append(projectCard(font, "font", {
          status: stale ? "模板有更新" : linked?.name ?? `${font.template.name}（内嵌模板）`,
          image: fontArt(font),
          open: () => stale ? resolve(font) : openFont(font),
          className: stale ? "pending" : ""
        }));
      }
    }
    const content = menu.querySelector(".desktop-library-content");
    content.scrollTop = 0;
    if (!busy) title.focus({ preventScroll: true });
  }

  async function reload() {
    const data = await desktop.loadProjects();
    const sortByName = (a, b) => a.name.localeCompare(b.name, "zh-CN") || a.id.localeCompare(b.id);
    templates = new Map(data.templates.filter(item => readable(item)).sort(sortByName).map(item => [item.id, item]));
    fonts = new Map(data.fonts.filter(item => readable(item.template)).sort(sortByName).map(item => [item.id, item]));
    if (data.warnings.length || templates.size < data.templates.length || fonts.size < data.fonts.length) {
      studio.notify("部分本地项目文件无法读取。");
    }
  }

  function readable(template) {
    try {
      studio.geometry(template.spec);
      return true;
    } catch {
      return false;
    }
  }

  function openTemplate(template) {
    editingRecord = template;
    setPage("template");
    nameInput.value = template?.name ?? "未命名模板";
    $("desktop-template-name-label").hidden = false;
    $("desktop-font-title").hidden = true;
    $("desktop-back-label").textContent = "模板菜单";
    studio.open(template ? { draft: template.spec, template: template.spec,
      disabledRegions: template.disabledRegions } : {});
    savedEditorState = structuredClone(editorState());
    markChanged();
  }

  function openFont(font) {
    if (pendingTemplate(font)) {
      resolve(font);
      return;
    }
    editingRecord = font;
    setPage("font");
    $("desktop-template-name-label").hidden = true;
    $("desktop-font-title").hidden = false;
    $("desktop-back-label").textContent = "字体菜单";
    studio.open({ ...font, fontName: font.name, draft: font.template.spec, template: font.template.spec,
      disabledRegions: font.template.disabledRegions, mode: "glyph" });
    savedEditorState = structuredClone(editorState());
    markChanged();
  }

  function markChanged() {
    if (!editing()) return;
    const status = $("desktop-save-status");
    const unsaved = dirty();
    status.classList.toggle("dirty", unsaved);
    status.textContent = simplified() ? "保存时另存为独立模板" : unsaved ? "未保存" : "已保存";
    if (page === "font") $("desktop-font-title").textContent = project().fontName;
  }

  async function save() {
    if (page === "template") {
      if (!nameInput.value.trim()) throw new Error("请输入模板名称。");
      studio.prepareTemplate();
      editingRecord = await desktop.saveTemplate({ id: editingRecord?.id, name: nameInput.value, ...templateFields() });
      templates.set(editingRecord.id, editingRecord);
    } else {
      const fields = fontFields();
      if (!fields.name) throw new Error("请输入字体名称。");
      const result = await desktop.saveFont(editingRecord.id, fields, simplified() ? templateFields() : null);
      editingRecord = result.font;
      fonts.set(editingRecord.id, editingRecord);
      if (result.template) templates.set(result.template.id, result.template);
    }
    savedEditorState = structuredClone(editorState());
    markChanged();
  }

  async function createFont() {
    await save();
    const font = await desktop.createFont(editingRecord.id);
    fonts.set(font.id, font);
    openFont(font);
  }

  function exportProject(templateOnly = false) {
    const saveAsTemplate = templateOnly || page === "template";
    if (page === "template") studio.prepareTemplate();
    const template = { format: "glyph-cut-template", id: page === "template" ? editingRecord?.id : editingRecord.template.id,
      name: page === "template" ? nameInput.value.trim() : editingRecord.template.name, ...templateFields() };
    const record = saveAsTemplate ? template : { format: "glyph-cut-font", id: editingRecord.id, template, ...fontFields() };
    const extension = saveAsTemplate ? ".template.json" : ".glyphs.json";
    return studio.download(JSON.stringify(record, null, 2), "application/json", studio.safeName(record.name) + extension);
  }

  function resolve(font) {
    resolvingFont = font;
    preview = null;
    const current = templates.get(font.template.id);
    setPage("resolve");
    $("desktop-resolve-title").textContent = font.name;
    $("desktop-resolve-note").textContent = `「${current.name}」已修改，请选择如何处理该字体。`;
    resolvePanel.querySelector(".desktop-resolve-content").scrollTop = 0;
    $("desktop-adaptation").hidden = true;
    $("desktop-preview-adaptation").hidden = false;
    $("desktop-apply-adaptation").hidden = true;
  }

  function previewAdaptation() {
    const font = resolvingFont;
    const current = templates.get(font.template.id);
    const glyphs = G.adaptGlyphs(font.template, current, font.glyphs);
    const geometry = studio.geometry(current.spec);
    const list = $("desktop-adapted-glyphs");
    const chars = [...alphabet].filter(ch => font.glyphs[ch]?.length || glyphs[ch]?.length);
    list.replaceChildren(...chars.map(ch => {
      const glyph = element("figure", "desktop-glyph-preview");
      const svg = art(current.spec);
      addPath(svg, glyphPath(geometry, glyphs[ch]), "", "currentColor");
      const caption = element("figcaption", "", ch);
      if (!glyphs[ch]?.length) caption.append(element("small", "", "留空"));
      glyph.append(svg, caption);
      return glyph;
    }));
    preview = { template: current, glyphs };
    $("desktop-resolve-note").textContent = `「${current.name}」的自动适配预览`;
    $("desktop-adaptation-empty").hidden = chars.length > 0;
    $("desktop-adaptation").hidden = false;
    $("desktop-preview-adaptation").hidden = true;
    $("desktop-apply-adaptation").hidden = false;
  }

  async function finishResolution(retain) {
    let font;
    if (retain) {
      const result = await desktop.keepTemplate(resolvingFont.id);
      templates.set(result.template.id, result.template);
      font = result.font;
    } else {
      font = await desktop.adaptFont(resolvingFont.id, preview.template, preview.glyphs);
    }
    fonts.set(font.id, font);
    showMenu("fonts");
    studio.notify(retain ? "已保留为独立模板。" : "已应用适配。");
  }

  async function run(action) {
    if (busy) return;
    busy = true;
    const content = [menu, editorBar, resolvePanel, document.querySelector(".workbench")];
    content.forEach(node => { node.inert = true; });
    const previousPage = page;
    try {
      await action();
    } catch (error) {
      studio.notify(error.message);
    } finally {
      busy = false;
      content.forEach(node => { node.inert = false; });
      if (page !== previousPage) {
        if (!menu.hidden) $("desktop-menu-title").focus({ preventScroll: true });
        else if (!resolvePanel.hidden) $("desktop-resolve-title").focus({ preventScroll: true });
        else if (page === "template") nameInput.focus();
        else if (page === "font") $("font-name").focus();
      }
    }
  }

  function initializeUpdates() {
    const button = $("desktop-update");
    const panel = $("desktop-update-dialog");
    const action = $("desktop-update-action");
    const meter = $("desktop-update-progress");
    const notes = $("desktop-update-notes");
    let phase;
    const messages = {
      checking: "正在检查 GitHub Releases…",
      current: "当前已是最新版本。",
      available: "发现新版本。",
      downloading: "正在下载更新包…",
      preparing: "正在校验并解压更新包…",
      ready: "更新已就绪。请保存当前修改，然后重启更新。",
      installing: "即将退出程序并应用更新。"
    };
    const actions = { idle: "检查更新", current: "重新检查", checkFailed: "重试", available: "下载更新", ready: "重启并更新" };

    function renderUpdate(state) {
      phase = state.phase;
      button.hidden = phase === "unsupported";
      const available = Boolean(state.version);
      button.classList.toggle("available", available);
      button.textContent = available ? `更新 v${state.version}` : "检查更新";
      $("desktop-update-version").textContent = available ?
        `当前 v${state.currentVersion}　·　新版 v${state.version}` : `当前版本 v${state.currentVersion}`;
      $("desktop-update-message").textContent = state.message ??
        (phase === "downloading" ? `正在下载更新包… ${state.progress}%` : messages[phase] ?? "");
      meter.hidden = phase !== "downloading";
      meter.value = state.progress ?? 0;
      notes.hidden = !state.notes;
      notes.textContent = state.notes ?? "";
      action.hidden = !actions[phase];
      action.textContent = actions[phase] ?? "";
    }

    const report = () => studio.notify("无法处理更新，请稍后重试。");
    button.addEventListener("click", () => {
      panel.showModal();
      if (["idle", "checkFailed", "current"].includes(phase)) desktop.checkForUpdate().catch(report);
    });
    panel.addEventListener("keydown", event => event.stopPropagation());
    action.addEventListener("click", () => {
      if (phase === "available") desktop.downloadUpdate().catch(report);
      else if (phase === "ready") desktop.installUpdate().catch(report);
      else desktop.checkForUpdate().catch(report);
    });
    desktop.onUpdate(renderUpdate);
    desktop.updateStatus().then(state => {
      renderUpdate(state);
      if (state.phase === "idle") return desktop.checkForUpdate();
    }).catch(report);
  }

  function start(api) {
    studio = api;
    initializeUpdates();
    $("use-template").textContent = "使用此模板创建字体";
    $("simplify-template").textContent = "简化为独立模板";
    nameInput.addEventListener("input", markChanged);
    $("desktop-save").addEventListener("click", () => run(save));
    $("desktop-export-project").addEventListener("click", () => run(() => exportProject()));
    $("desktop-editor-back").addEventListener("click", () => {
      if (!dirty() || window.confirm("放弃未保存的改动并返回菜单？")) run(async () => {
        const next = page === "template" ? "templates" : "fonts";
        await reload();
        showMenu(next);
      });
    });
    $("desktop-prev-menu").addEventListener("click", () => run(() => showMenu("templates")));
    $("desktop-next-menu").addEventListener("click", () => run(() => showMenu("fonts")));
    $("desktop-resolve-back").addEventListener("click", () => run(async () => {
      await reload();
      showMenu("fonts");
    }));
    $("desktop-preview-adaptation").addEventListener("click", () => run(previewAdaptation));
    $("desktop-apply-adaptation").addEventListener("click", () => run(() => finishResolution(false)));
    $("desktop-keep-template").addEventListener("click", () => run(() => finishResolution(true)));
    for (const action of ["minimize", "maximize", "close"]) {
      $("desktop-" + action).addEventListener("click", () => desktop.controlWindow(action));
    }
    desktop.onMaximized(maximized => {
      const button = $("desktop-maximize");
      const label = maximized ? "还原" : "最大化";
      button.title = label;
      button.setAttribute("aria-label", label);
      $("desktop-maximize-icon").setAttribute("d", maximized ?
        "M3.5 5.5h7v7h-7z M5.5 5.5v-2h7v7h-2" : "M3.5 3.5h9v9h-9z");
    });
    window.addEventListener("beforeunload", event => {
      if (busy || dirty()) event.returnValue = "";
    });
    document.addEventListener("keydown", event => {
      if (!editing() || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      document.activeElement.blur();
      run(save);
    });
    return run(async () => {
      try {
        await reload();
      } finally {
        showMenu("templates");
      }
    });
  }

  globalThis.GlyphCutWorkspace = {
    start, markChanged, editing, createFont: () => run(createFont), exportTemplate: () => run(() => exportProject(true))
  };
})();
