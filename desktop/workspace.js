"use strict";

(() => {
  const desktop = globalThis.glyphCutDesktop;
  const G = globalThis.GlyphGeometry;
  const $ = id => document.getElementById(id);
  const menu = $("desktop-menu");
  const editorBar = $("desktop-editor-bar");
  const templateSetup = $("desktop-template-setup");
  const fontSetup = $("desktop-font-setup");
  const fontSetupForm = $("desktop-font-setup-form");
  const fontSetupName = $("desktop-font-setup-name");
  const resolvePanel = $("desktop-resolve");
  const nameInput = $("desktop-template-name");
  const setupName = $("desktop-setup-name");
  const setupCanvas = $("desktop-setup-preview-canvas");
  const dimensions = ["width", "height", "stepX", "stepY"];
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
  let activeAction;
  let saving;
  let autoSaveTimer;
  let saveFailed = false;
  let closing = false;
  let allowUnload = false;
  let refreshSample;
  let templates = new Map();
  let fonts = new Map();

  const project = () => studio.project();
  const templateFields = () => ({ spec: project().draft, disabledRegions: project().disabledRegions });
  const fontFields = () => {
    const p = project();
    return { name: p.fontName.trim(), glyphs: p.glyphs, baseline: p.baseline, spacing: p.spacing,
      sample: p.sample, autoSample: p.autoSample, characterGroups: p.characterGroups, character: p.character };
  };
  const sampleText = font => font.autoSample ?
    [...alphabet].filter(ch => font.glyphs[ch]?.length).slice(0, 3).join("") : font.sample;
  const editing = () => page === "template" || page === "font";
  const unconfirmedFont = () => page === "font" && editingRecord.unconfirmed === true;
  const simplified = () => page === "font" && !sameShape(editingRecord.template, templateFields());
  function editorState() {
    if (page === "template") return { name: nameInput.value.trim(), ...templateFields() };
    return { ...fontFields(), ...templateFields() };
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
    const sample = sampleText(font).trim();
    const spec = font.template.spec;
    const svg = art(spec);
    if (!sample) return svg;
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
    const titleLine = element("strong", "desktop-card-line");
    titleLine.append(element("span", "", title));
    caption.append(titleLine);
    if (subtitle) {
      const subtitleLine = element("small", "desktop-card-line");
      subtitleLine.append(element("span", "", subtitle));
      caption.append(subtitleLine);
    }
    button.append(visual, caption);
    button.addEventListener("pointerenter", () => {
      for (const line of caption.children) {
        const distance = line.scrollWidth - line.clientWidth;
        if (distance <= 1) continue;
        if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
          line.title = line.textContent;
          continue;
        }
        line.classList.add("scrolling");
        line.firstElementChild.animate({ transform: ["translateX(0)", `translateX(-${distance}px)`] },
          { delay: 300, duration: Math.min(8000, Math.max(850, distance * 18)), fill: "forwards" });
      }
    });
    button.addEventListener("pointerleave", () => {
      for (const line of caption.children) {
        line.firstElementChild.getAnimations().forEach(animation => animation.cancel());
        line.classList.remove("scrolling");
      }
    });
    button.addEventListener("click", () => run(handler));
    return button;
  }

  function projectCard(record, kind, options) {
    const { status, image, open, className } = options;
    const wrapper = element("div", "desktop-card-slot");
    wrapper.dataset.projectId = record.id;
    const isTemplate = kind === "template";
    const kindLabel = isTemplate ? "模板" : "字体";
    const copy = element("button", "desktop-card-action desktop-copy");
    copy.type = "button";
    copy.title = `拷贝${kindLabel}「${record.name}」`;
    copy.setAttribute("aria-label", copy.title);
    copy.append(icon("desktop-copy-icon"));
    copy.addEventListener("click", () => run(async () => {
      const duplicate = await desktop.copyProject(kind, record.id);
      await reload();
      showMenu(page);
      studio.notify(`已创建${kindLabel}副本。`);
      requestAnimationFrame(() => {
        $("desktop-cards").querySelector(`[data-project-id="${duplicate.id}"] .desktop-card`)?.focus();
      });
    }));
    const remove = element("button", "desktop-card-action desktop-delete");
    remove.type = "button";
    const label = `删除${kindLabel}「${record.name}」`;
    remove.title = label;
    remove.setAttribute("aria-label", label);
    remove.append(icon("desktop-trash-icon"));
    remove.addEventListener("click", () => run(async () => {
      $("desktop-delete-title").textContent = label + "？";
      $("desktop-delete-detail").textContent = isTemplate ?
        "保留的字体会继续使用各自内嵌的模板。" : "该字体及其字形将被删除。";
      $("desktop-delete-linked-label").hidden = !isTemplate;
      const option = $("desktop-delete-linked");
      option.checked = false;
      if (await showDialog("desktop-delete-dialog") !== "delete") return;
      await desktop.deleteProject(kind, record.id, isTemplate && option.checked);
      await reload();
      showMenu(page);
      studio.notify(`已${label}。`);
      requestAnimationFrame(() => {
        ($("desktop-cards").querySelector(".desktop-card") ?? $("desktop-menu-title")).focus({ preventScroll: true });
      });
    }));
    const actions = element("div", "desktop-card-actions");
    actions.append(copy, remove);
    wrapper.append(card(record.name, status, image, open, className), actions);
    return wrapper;
  }

  function showDialog(id) {
    const dialog = $(id);
    dialog.returnValue = "";
    dialog.showModal();
    return new Promise(resolve => {
      dialog.addEventListener("close", () => resolve(dialog.returnValue), { once: true });
    });
  }

  function setPage(next) {
    page = next;
    menu.hidden = next !== "templates" && next !== "fonts";
    editorBar.hidden = !editing();
    templateSetup.hidden = next !== "setup";
    fontSetup.hidden = next !== "font-setup";
    resolvePanel.hidden = next !== "resolve";
    const exportButton = $("desktop-export-project");
    if (next === "font") exportButton.setAttribute("aria-haspopup", "dialog");
    else exportButton.removeAttribute("aria-haspopup");
    document.body.classList.toggle("desktop-editing", editing());
    document.body.classList.toggle("desktop-template-editing", next === "template");
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
      cards.append(card("创建新模板", "", icon("i-plus"), openTemplateSetup, "desktop-card-new"));
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

  function renderSetupPreview() {
    if (page !== "setup") return;
    const fields = dimensions.map($);
    const valid = fields.every(field => field.validity.valid);
    setupCanvas.toggleAttribute("hidden", !valid);
    $("desktop-setup-preview-empty").hidden = valid;
    if (!valid) return;
    const [width, height, stepX, stepY] = fields.map(field => field.valueAsNumber);
    const margin = Math.max(width, height) * .025;
    const viewWidth = width + 2 * margin;
    const viewHeight = height + 2 * margin;
    setupCanvas.setAttribute("viewBox", `${-margin} ${-margin} ${viewWidth} ${viewHeight}`);
    const paper = $("desktop-setup-preview-paper");
    paper.setAttribute("width", width);
    paper.setAttribute("height", height);
    const bounds = setupCanvas.getBoundingClientRect();
    const scale = Math.min(bounds.width / viewWidth, bounds.height / viewHeight);
    // Keep each visible line on the actual grid even when the preview is too small to show every line.
    const interval = step => step * Math.max(1, Math.ceil(3 / (step * scale)));
    const xInterval = interval(stepX);
    const yInterval = interval(stepY);
    const lines = [];
    for (let x = xInterval; x < width; x += xInterval) lines.push(`M${x} 0V${height}`);
    for (let y = yInterval; y < height; y += yInterval) lines.push(`M0 ${y}H${width}`);
    $("desktop-setup-preview-grid").setAttribute("d", lines.join(""));
  }

  function openTemplateSetup() {
    const draft = studio.blankDraft();
    setupName.value = "";
    for (const key of dimensions) $(key).value = draft[key];
    setPage("setup");
    renderSetupPreview();
  }

  async function createTemplate(dimensions) {
    const name = setupName.value.trim();
    if (!name) throw new Error("请输入模板名称。");
    const spec = studio.validateSpec({ ...dimensions, strokes: [] });
    const template = await desktop.saveTemplate({ name, spec, disabledRegions: [] });
    templates.set(template.id, template);
    openTemplate(template);
  }

  function openTemplate(template) {
    editingRecord = template;
    saveFailed = false;
    setPage("template");
    nameInput.value = template.name;
    $("desktop-font-title").hidden = true;
    $("desktop-back-label").textContent = "模板菜单";
    studio.open({ draft: template.spec, template: template.spec, disabledRegions: template.disabledRegions });
    savedEditorState = structuredClone(editorState());
    updateSaveStatus();
  }

  function openFont(font) {
    if (pendingTemplate(font)) {
      resolve(font);
      return;
    }
    editingRecord = font;
    saveFailed = false;
    setPage("font");
    $("desktop-font-title").hidden = false;
    $("desktop-back-label").textContent = "字体菜单";
    studio.open({ ...font, fontName: font.name, draft: font.template.spec, template: font.template.spec,
      disabledRegions: font.template.disabledRegions, mode: "glyph" });
    savedEditorState = structuredClone(editorState());
    updateSaveStatus();
  }

  function updateSaveStatus() {
    if (!editing()) return;
    const status = $("desktop-save-status");
    const unsaved = dirty();
    status.classList.toggle("dirty", unsaved);
    if (saving) status.textContent = "正在保存…";
    else if (unsaved) status.textContent = saveFailed ? "保存失败" : "等待自动保存";
    else status.textContent = unconfirmedFont() ? "草稿已保存" : "已保存";
    if (page === "font") $("desktop-font-title").textContent = project().fontName;
  }

  function markChanged() {
    clearTimeout(autoSaveTimer);
    saveFailed = false;
    updateSaveStatus();
    if (dirty() && (page !== "template" || nameInput.value.trim())) {
      autoSaveTimer = setTimeout(() => save().catch(error => studio.notify(error.message)), 650);
    }
  }

  async function writeEditor() {
    if (page === "template" && !nameInput.value.trim()) throw new Error("请输入模板名称。");
    const state = structuredClone(editorState());
    const { spec, disabledRegions, ...fields } = state;
    if (page === "template") {
      editingRecord = await desktop.saveTemplate({ id: editingRecord.id, ...fields, spec, disabledRegions });
      templates.set(editingRecord.id, editingRecord);
    } else {
      if (!fields.name) throw new Error("请输入字体名称。");
      const result = await desktop.saveFont(editingRecord.id, fields, simplified() ? { spec, disabledRegions } : null);
      editingRecord = result.font;
      fonts.set(editingRecord.id, editingRecord);
      if (result.template) templates.set(result.template.id, result.template);
    }
    savedEditorState = state;
  }

  function save() {
    clearTimeout(autoSaveTimer);
    if (saving) return saving;
    if (!dirty()) return;
    saving = writeEditor().then(() => {
      saveFailed = false;
    }, error => {
      saveFailed = true;
      throw error;
    }).finally(() => {
      saving = undefined;
      if (saveFailed) updateSaveStatus();
      else markChanged();
    });
    updateSaveStatus();
    return saving;
  }

  async function flushSave() {
    document.activeElement?.blur();
    clearTimeout(autoSaveTimer);
    while (saving || dirty()) await save();
  }

  async function saveManually() {
    await flushSave();
    if (unconfirmedFont()) {
      editingRecord = await desktop.confirmFont(editingRecord.id);
      fonts.set(editingRecord.id, editingRecord);
      updateSaveStatus();
    }
  }

  async function prepareToLeave() {
    if (!unconfirmedFont()) {
      await flushSave();
      return true;
    }
    $("desktop-retain-detail").textContent = `要保留尚未手动保存的字体「${project().fontName}」吗？`;
    const answer = await showDialog("desktop-retain-font");
    if (answer === "keep") await saveManually();
    else if (answer === "discard") {
      // Let an in-flight write finish before removing the draft.
      await saving?.catch(() => {});
      clearTimeout(autoSaveTimer);
      await desktop.deleteProject("font", editingRecord.id);
      fonts.delete(editingRecord.id);
      showMenu("fonts");
    } else return false;
    return true;
  }

  async function openFontSetup() {
    await flushSave();
    fontSetupName.value = `${editingRecord.name.slice(0, 96)} 字体`;
    fontSetupForm.querySelectorAll("[name=character-group]").forEach(input => { input.checked = true; });
    $("desktop-font-setup-submit").disabled = false;
    setPage("font-setup");
  }

  async function createFont() {
    const name = fontSetupName.value.trim();
    if (!name) throw new Error("请输入字体名称。");
    const characterGroups = new FormData(fontSetupForm).getAll("character-group");
    const font = await desktop.createFont(editingRecord.id, { name, characterGroups });
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

  function initializeExports() {
    const dialog = $("desktop-export-dialog");
    const options = $("desktop-export-options");
    for (const id of ["export-ttf", "export-svg", "export-all-svg", "export-all-png", "export-template"]) {
      options.append($(id));
    }
    $("font-settings").append($("simplify-template"));
    $("font-exports").hidden = true;
    $("desktop-export-project").addEventListener("click", () => {
      if (page === "font") dialog.showModal();
      else run(() => exportProject());
    });
    dialog.addEventListener("keydown", event => event.stopPropagation());
    options.addEventListener("click", event => {
      if (event.target.closest("button")) dialog.close();
    }, { capture: true });
    $("desktop-export-font-json").addEventListener("click", () => run(() => exportProject()));
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
    const content = [menu, templateSetup, fontSetup, editorBar, resolvePanel, document.querySelector(".workbench")];
    content.forEach(node => { node.inert = true; });
    const previousPage = page;
    activeAction = Promise.resolve().then(action);
    try {
      return await activeAction;
    } catch (error) {
      studio.notify(error.message);
    } finally {
      activeAction = undefined;
      busy = false;
      content.forEach(node => { node.inert = false; });
      if (page !== previousPage) {
        if (!menu.hidden) $("desktop-menu-title").focus({ preventScroll: true });
        else if (!resolvePanel.hidden) $("desktop-resolve-title").focus({ preventScroll: true });
        else if (page === "setup") $("desktop-setup-name").focus();
        else if (page === "font-setup") {
          fontSetupName.focus();
          fontSetupName.select();
        }
        else if (page === "template") nameInput.focus();
        else if (page === "font") $("font-name").focus();
      }
    }
  }

  function initializeSampleScroll() {
    const viewport = $("sample-output");
    let frame = null;
    let position = 0;
    let direction = 1;
    let lastTime;
    let holdUntil = 0;
    let hovered = false;

    function tick(time) {
      frame = null;
      const remaining = viewport.scrollWidth - viewport.clientWidth;
      if (!viewport.clientWidth || remaining <= 0 || hovered) {
        lastTime = undefined;
        return;
      }
      const elapsed = lastTime === undefined ? 0 : Math.min(time - lastTime, 50);
      lastTime = time;
      if (time >= holdUntil) {
        position = Math.max(0, Math.min(remaining, position + direction * elapsed * 0.035));
        if ((direction > 0 && position >= remaining) || (direction < 0 && position <= 0)) {
          direction *= -1;
          holdUntil = time + 650;
        }
        viewport.scrollLeft = position;
      }
      resume();
    }

    function resume() {
      if (frame === null && !hovered) frame = requestAnimationFrame(tick);
    }

    viewport.addEventListener("pointerenter", () => {
      hovered = true;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      lastTime = undefined;
    });
    viewport.addEventListener("pointerleave", () => {
      hovered = false;
      resume();
    });
    new ResizeObserver(resume).observe(viewport);
    refreshSample = () => {
      position = 0;
      direction = 1;
      lastTime = undefined;
      holdUntil = performance.now() + 650;
      viewport.scrollLeft = 0;
      hovered = viewport.matches(":hover");
      resume();
    };
  }

  function initializeUpdates() {
    const button = $("desktop-update");
    const panel = $("desktop-update-dialog");
    const action = $("desktop-update-action");
    const browser = $("desktop-update-browser");
    const meter = $("desktop-update-progress");
    const notes = $("desktop-update-notes");
    let phase;
    const messages = {
      checking: "正在检查 GitHub Releases…",
      current: "当前已是最新版本。",
      available: "发现新版本。",
      downloading: "正在下载更新包…",
      preparing: "正在校验并解压更新包…",
      ready: "更新已就绪。重启前会自动保存当前修改。",
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
      browser.hidden = phase !== "checkFailed" && !state.message;
    }

    const report = () => studio.notify("无法处理更新，请稍后重试。");
    button.addEventListener("click", () => {
      panel.showModal();
      if (["idle", "checkFailed", "current"].includes(phase)) desktop.checkForUpdate().catch(report);
    });
    panel.addEventListener("keydown", event => event.stopPropagation());
    browser.addEventListener("click", () => desktop.openReleasePage().catch(report));
    action.addEventListener("click", () => {
      if (phase === "available") desktop.downloadUpdate().catch(report);
      else if (phase === "ready" && !busy) {
        run(prepareToLeave).then(saved => {
          if (saved) return desktop.installUpdate();
        }).catch(report);
      }
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
    initializeExports();
    $("use-template").textContent = "使用此模板创建字体";
    $("simplify-template").textContent = "简化为独立模板";
    $("desktop-setup-fields").append($("dimensions"));
    $("apply-dimensions").textContent = "创建并编辑";
    $("apply-dimensions").classList.add("accent");
    $("dimensions").addEventListener("input", renderSetupPreview);
    new ResizeObserver(renderSetupPreview).observe(setupCanvas.parentElement);
    const history = $("undo").parentElement;
    history.className = "desktop-history";
    for (const button of history.children) button.className = "button";
    $("desktop-export-project").before(history);
    for (const id of ["desktop-delete-dialog", "desktop-retain-font"]) {
      $(id).addEventListener("keydown", event => event.stopPropagation());
    }
    $("desktop-template-identity").hidden = false;
    $("tools").querySelector("[data-tool=exclude]").removeAttribute("title");
    initializeSampleScroll();
    nameInput.addEventListener("input", markChanged);
    nameInput.addEventListener("change", () => {
      if (!nameInput.value.trim()) nameInput.value = editingRecord.name;
      markChanged();
    });
    $("desktop-setup-back").addEventListener("click", () => run(() => showMenu("templates")));
    $("desktop-font-setup-back").addEventListener("click", () => run(() => setPage("template")));
    fontSetupForm.addEventListener("change", () => {
      $("desktop-font-setup-submit").disabled = !fontSetupForm.querySelector("[name=character-group]:checked");
    });
    fontSetupForm.addEventListener("submit", event => {
      event.preventDefault();
      run(createFont);
    });
    $("desktop-save").addEventListener("click", () => run(saveManually));
    $("desktop-editor-back").addEventListener("click", () => run(async () => {
      const next = page === "template" ? "templates" : "fonts";
      if (!await prepareToLeave()) return;
      await reload();
      showMenu(next);
    }));
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
    desktop.onSaveBeforeClose(async () => {
      if (closing) return;
      closing = true;
      await activeAction?.catch(() => {});
      try {
        const saved = await run(prepareToLeave);
        if (saved || (saved === undefined && !unconfirmedFont() &&
            window.confirm("自动保存失败。要放弃未保存的修改并退出吗？"))) {
          allowUnload = true;
          await desktop.controlWindow("close");
        }
      } finally {
        allowUnload = false;
        closing = false;
      }
    });
    window.addEventListener("beforeunload", event => {
      if (allowUnload) return;
      document.activeElement?.blur();
      if (busy || saving || dirty() || unconfirmedFont()) {
        event.preventDefault();
        event.returnValue = "";
      }
    });
    document.addEventListener("keydown", event => {
      if (!editing() || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      run(saveManually);
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
    start, markChanged, editing, sampleText,
    createTemplate: dimensions => run(() => createTemplate(dimensions)),
    openFontSetup: () => run(openFontSetup),
    refreshSample: () => refreshSample?.(),
    exportTemplate: () => run(() => exportProject(true))
  };
})();
