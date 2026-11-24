"use strict";

(() => {
  const desktop = globalThis.glyphCutDesktop;
  const G = globalThis.GlyphGeometry;
  const $ = id => document.getElementById(id);
  const menu = $("desktop-menu");
  const menuContent = menu.querySelector(".desktop-library-content");
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
  const svgNS = "http://www.w3.org/2000/svg";
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const sameShape = (a, b) => same(a.spec, b.spec) && same(a.disabledRegions, b.disabledRegions);
  const nameKey = name => name.trim().normalize("NFC").toLowerCase();
  const duplicateName = "已有同名的模板或字体，请换一个名称。";
  let studio;
  let page;
  let editingRecord;
  let savedEditorState;
  let resolvingFont;
  let editWhenResolved = false;
  let preview;
  let busy = false;
  let activeAction;
  let saving;
  let autoSaveTimer;
  let saveFailed = false;
  let closing = false;
  let allowUnload = false;
  let refreshSample;
  let stopMenuScroll;
  let templates = new Map();
  let fonts = new Map();

  const project = () => studio.project();
  const templateFields = () => ({ spec: project().draft, disabledRegions: project().disabledRegions });
  const fontFields = () => {
    const p = project();
    return { name: p.fontName.trim(), glyphs: p.glyphs, baseline: p.baseline, spacing: p.spacing,
      sample: p.sample, autoSample: p.autoSample, characterGroups: p.characterGroups, character: p.character };
  };
  function sampleText(font) {
    const available = studio.charactersFor(font);
    const characters = [...(font.autoSample ? available : font.sample)]
      .filter(ch => available.includes(ch) && font.glyphs[ch]?.length);
    return (font.autoSample ? characters.slice(0, 3) : characters).join("");
  }
  const editing = () => page === "template" || page === "font";
  const unconfirmedFont = () => page === "font" && editingRecord.unconfirmed === true;
  function editorState() {
    if (page === "template") return { name: nameInput.value.trim(), ...templateFields() };
    return { ...fontFields(), ...templateFields() };
  }
  const dirty = () => editing() && (!editingRecord || !same(editorState(), savedEditorState));
  const pendingTemplate = font => {
    const current = templates.get(font.template.id);
    return Boolean(current && !sameShape(font.template, current));
  };
  const linkedFonts = id => [...fonts.values()].filter(font => font.template.id === id);

  function nameTaken(name, record) {
    const key = nameKey(name);
    if (record && nameKey(record.name) === key) return false;
    return [...templates.values(), ...fonts.values()].some(project => nameKey(project.name) === key);
  }

  function checkNewName(input) {
    if (!input.value.trim()) throw new Error("请输入名称。");
    if (nameTaken(input.value)) throw new Error(duplicateName);
    return input.value.trim();
  }

  function suggestedName(base, suffix) {
    const withSuffix = ending => base.slice(0, 100 - ending.length).replace(/[\uD800-\uDBFF]$/, "") + ending;
    let name = withSuffix(suffix);
    for (let n = 2; nameTaken(name); n++) name = withSuffix(`${suffix} ${n}`);
    return name;
  }

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
    const sample = sampleText(font).slice(0, 7);
    const spec = font.template.spec;
    const svg = art(spec);
    if (!sample) return svg;
    const geometry = studio.geometry(spec);
    const advance = spec.width + 2 * font.spacing;
    let offset = 0;
    for (const character of sample) {
      const glyph = document.createElementNS(svgNS, "g");
      glyph.setAttribute("transform", `translate(${offset + font.spacing} 0)`);
      addPath(glyph, glyphPath(geometry, font.glyphs[character]), "", "currentColor");
      svg.append(glyph);
      offset += advance;
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
      const duplicate = await promptProject({
        title: `拷贝${kindLabel}`, caption: "副本名称", name: suggestedName(record.name, "（副本）"), action: "创建副本"
      }, name => desktop.copyProject(kind, record.id, name));
      if (!duplicate) return;
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
      const hasLinkedFonts = isTemplate && linkedFonts(record.id).length > 0;
      $("desktop-delete-title").textContent = label + "？";
      $("desktop-delete-detail").textContent = hasLinkedFonts ?
        "保留的字体会继续使用各自内嵌的模板。" : isTemplate ? "该模板将被删除。" : "该字体及其字形将被删除。";
      $("desktop-delete-linked-label").hidden = !hasLinkedFonts;
      const option = $("desktop-delete-linked");
      option.checked = false;
      if (await showDialog("desktop-delete-dialog") !== "delete") return;
      await desktop.deleteProject(kind, record.id, hasLinkedFonts && option.checked);
      await reload();
      showMenu(page);
      studio.notify(`已${label}。`);
      requestAnimationFrame(() => {
        ($("desktop-cards").querySelector(".desktop-card") ?? $("desktop-menu-title")).focus({ preventScroll: true });
      });
    }));
    const actions = element("div", "desktop-card-actions");
    actions.append(copy, remove);
    const main = card(record.name, status, image, open, className);
    main.draggable = true;
    wrapper.append(main, actions);
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

  async function promptProject({ title, caption, name, action, simplify }, submit) {
    const dialog = $("desktop-project-dialog");
    const form = $("desktop-project-form");
    const scope = $("desktop-simplify-destinations");
    const original = scope.querySelector("[value=original]");
    const independent = scope.querySelector("[value=independent]");
    const input = $("desktop-project-name");
    const error = $("desktop-project-error");
    const note = $("desktop-simplify-note");
    const listeners = new AbortController();
    const options = { signal: listeners.signal };
    let result;
    let submitting = false;
    $("desktop-project-title").textContent = title;
    $("desktop-project-name-caption").textContent = caption;
    $("desktop-project-submit").textContent = action;
    scope.hidden = !simplify;
    original.disabled = !simplify?.original;
    original.checked = !original.disabled;
    independent.checked = original.disabled;
    input.value = name;

    function refresh() {
      input.disabled = original.checked;
      $("desktop-project-name-label").hidden = input.disabled;
      note.textContent = original.disabled ? "当前字体使用内嵌模板，可以保存为独立模板。" :
        `另有 ${simplify?.linked ?? 0} 个字体使用此模板。修改后，打开这些字体时需要处理模板变更。`;
      note.hidden = !simplify || (!original.disabled && (!original.checked || !simplify.linked));
      error.hidden = true;
    }
    refresh();
    scope.addEventListener("change", refresh, options);
    input.addEventListener("input", () => { error.hidden = true; }, options);
    $("desktop-project-cancel").addEventListener("click", () => dialog.close(), options);
    dialog.addEventListener("cancel", event => { if (submitting) event.preventDefault(); }, options);
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (submitting) return;
      submitting = true;
      form.inert = true;
      try {
        result = await submit(input.disabled ? undefined : checkNewName(input), original.checked ? "original" : "independent");
        dialog.close();
      } catch (failure) {
        error.textContent = failure.message;
        error.hidden = false;
        form.inert = false;
        (input.disabled ? original : input).focus();
      } finally {
        submitting = false;
        form.inert = false;
      }
    }, options);
    try {
      const closed = showDialog(dialog.id);
      (input.disabled ? original : input).focus();
      if (!input.disabled) input.select();
      await closed;
      return result;
    } finally {
      listeners.abort();
    }
  }

  function setPage(next) {
    stopMenuScroll?.();
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
    document.body.classList.toggle("desktop-font-editing", next === "font");
    document.body.classList.toggle("desktop-resolving", next === "resolve");
  }

  function showMenu(next) {
    editingRecord = null;
    resolvingFont = null;
    editWhenResolved = false;
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
        const linked = linkedFonts(template.id).length;
        cards.append(projectCard(template, "template", {
          status: `${linked} 个关联字体`, image: templateArt(template), open: () => openTemplate(template)
        }));
      }
      cards.append(card("创建新模板", "", icon("i-plus"), openTemplateSetup, "desktop-card-new"));
      cards.append(card("导入外部模板", "", icon("i-import"), () => importProject("template"), "desktop-card-new desktop-card-import"));
    } else {
      for (const font of fonts.values()) {
        const stale = pendingTemplate(font);
        const linked = templates.get(font.template.id);
        cards.append(projectCard(font, "font", {
          status: stale ? "模板有更新" : linked?.name ?? `${font.template.name}（内嵌模板）`,
          image: fontArt(font),
          open: () => openFont(font),
          className: stale ? "pending" : ""
        }));
      }
      cards.append(card("导入外部字体", "", icon("i-import"), () => importProject("font"), "desktop-card-new desktop-card-import"));
    }
    menuContent.scrollTop = 0;
    if (!busy) title.focus({ preventScroll: true });
  }

  function initializeCardSorting() {
    const cards = $("desktop-cards");
    let source;
    let target;
    const cardAt = event => event.target.closest(".desktop-card-slot");
    function highlight(card) {
      if (card === target) return;
      target?.classList.remove("drop-target");
      target = card;
      target?.classList.add("drop-target");
    }
    function endDrag() {
      highlight(null);
      source?.classList.remove("drag-source");
      source = null;
    }
    cards.addEventListener("dragstart", event => {
      const card = cardAt(event);
      if (!card || !event.target.closest(".desktop-card[draggable=true]") || busy) {
        event.preventDefault();
        return;
      }
      source = card;
      source.classList.add("drag-source");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-glyphcut-project", source.dataset.projectId);
    });
    cards.addEventListener("dragover", event => {
      if (!source) return;
      const next = cardAt(event);
      highlight(next === source ? null : next);
      if (!target) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    });
    cards.addEventListener("dragleave", event => {
      if (!cards.contains(event.relatedTarget)) highlight(null);
    });
    cards.addEventListener("dragend", endDrag);
    cards.addEventListener("drop", event => {
      if (!source) return;
      event.preventDefault();
      const moved = source;
      const destination = cardAt(event);
      endDrag();
      if (!destination || destination === moved) return;
      const collection = page;
      const projects = collection === "templates" ? templates : fonts;
      const order = [...cards.querySelectorAll(".desktop-card-slot")].map(card => card.dataset.projectId);
      const from = order.indexOf(moved.dataset.projectId);
      const to = order.indexOf(destination.dataset.projectId);
      order.splice(to, 0, order.splice(from, 1)[0]);
      run(async () => {
        await desktop.reorderProjects(collection, order);
        const reordered = order.map(id => [id, projects.get(id)]);
        if (collection === "templates") templates = new Map(reordered);
        else fonts = new Map(reordered);
        cards.insertBefore(moved, from < to ? destination.nextElementSibling : destination);
      });
    });
  }

  async function slideMenu(next) {
    if (menu.hidden || page === next) return showMenu(next);
    const content = menuContent;
    const outgoing = content.cloneNode(true);
    const scrollTop = content.scrollTop;
    for (const node of outgoing.querySelectorAll("[id]")) node.removeAttribute("id");
    outgoing.inert = true;
    outgoing.setAttribute("aria-hidden", "true");
    outgoing.classList.add("desktop-library-outgoing");
    const direction = next === "fonts" ? 1 : -1;
    showMenu(next);
    menu.prepend(outgoing);
    outgoing.scrollTop = scrollTop;
    const options = { duration: 500, easing: "cubic-bezier(.22,.75,.28,1)" };
    const departing = outgoing.animate({ transform: ["translateX(0)", `translateX(${-direction * 100}%)`] }, options);
    const arriving = content.animate({ transform: [`translateX(${direction * 100}%)`, "translateX(0)"] }, options);
    try {
      await Promise.all([departing.finished, arriving.finished]);
    } finally {
      outgoing.remove();
    }
  }

  function initializeMenuScroll() {
    const element = menuContent;
    const maxScroll = () => element.scrollHeight - element.clientHeight;
    let frame = null;
    let position = 0;
    let destination = 0;
    let lastTime = 0;

    function stop() {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    }

    function step(time) {
      destination = Math.min(destination, maxScroll());
      const remaining = destination - position;
      if (Math.abs(remaining) < 1) {
        element.scrollTop = destination;
        frame = null;
        return;
      }
      // Exponential easing preserves momentum across consecutive wheel events.
      const elapsed = Math.min(48, Math.max(0, time - lastTime));
      position += remaining * (1 - Math.exp(-elapsed / 105));
      element.scrollTop = position;
      lastTime = time;
      frame = requestAnimationFrame(step);
    }

    menu.addEventListener("wheel", event => {
      if (!event.deltaY || event.ctrlKey || maxScroll() <= 0) return;
      event.preventDefault();
      const units = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 :
        event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? element.clientHeight : 1;
      if (frame === null) {
        position = element.scrollTop;
        destination = position;
        lastTime = performance.now();
        frame = requestAnimationFrame(step);
      } else if (event.deltaY * (destination - position) < 0) {
        destination = position;
      }
      destination = Math.min(maxScroll(), Math.max(0, destination + event.deltaY * units));
    }, { passive: false });
    menu.addEventListener("pointerdown", stop, true);
    menu.addEventListener("dragstart", stop, true);
    return stop;
  }

  function readImport(value, filename, kind) {
    const fallback = filename.replace(/(?:\.template|\.glyphs)?\.json$/i, "").trim().slice(0, 96)
      .replace(/[\uD800-\uDBFF]$/, "") || "导入项目";
    let source;
    let font;
    if (value?.format === "glyph-cut-template") {
      source = value;
    } else if (value?.format === "glyph-cut-font" && value.template) {
      source = value.template;
      font = value;
    } else if (value?.format === "glyph-cut-v1") {
      source = { name: value.templateName, spec: value.template ?? value.draft, disabledRegions: value.disabledRegions };
      if (value.glyphs !== undefined) {
        font = { ...value, name: value.fontName, baseline: value.baseline ?? 86, spacing: value.spacing ?? 18,
          sample: value.sample ?? "", character: value.character ?? "A" };
      }
    } else {
      throw new Error("请选择字形切片导出的 JSON 文件。");
    }
    if (font && kind === "template") throw new Error("请在字体菜单导入字体文件。");
    if (!font && kind === "font") throw new Error("请选择字体项目 JSON。单独的模板可在模板菜单导入。");

    const spec = studio.validateSpec(source.spec);
    const count = studio.geometry(spec).faces.length;
    const validRegion = id => Number.isInteger(id) && id >= 0 && id < count;
    const disabled = source.disabledRegions ?? [];
    if (!Array.isArray(disabled) || !disabled.every(validRegion)) throw new Error("模板包含无效的禁用区块。");
    const disabledSet = new Set(disabled);
    const disabledRegions = [...disabledSet].sort((a, b) => a - b);
    const sourceName = typeof source.name === "string" ? source.name.trim() : "";
    const template = { name: sourceName || (font ? fallback + " 模板" : fallback), spec, disabledRegions };
    if (font) {
      const glyphs = font.glyphs;
      if (!glyphs || typeof glyphs !== "object" || Array.isArray(glyphs) ||
          !Object.values(glyphs).every(ids => Array.isArray(ids) && ids.every(id => validRegion(id) && !disabledSet.has(id)))) {
        throw new Error("字体包含无效的字形区块。");
      }
    }
    const fontName = typeof font?.name === "string" ? font.name.trim() : "";
    return { name: font ? fontName || fallback : template.name, template, font };
  }

  async function importProject(kind) {
    const dialog = $("desktop-import-dialog");
    const form = $("desktop-import-form");
    const picker = $("desktop-import-file");
    const filename = $("desktop-import-filename");
    const name = $("desktop-import-name");
    const standalone = $("desktop-import-standalone");
    const templateName = $("desktop-import-template-name");
    const error = $("desktop-import-error");
    const submit = $("desktop-import-submit");
    const listeners = new AbortController();
    const options = { signal: listeners.signal };
    let candidate;
    let saved;
    let submitting = false;
    let selection = 0;
    let errorMessage = "";
    filename.textContent = "选择 JSON 文件";
    picker.value = "";
    standalone.checked = false;
    $("desktop-import-title").textContent = kind === "font" ? "导入外部字体" : "导入外部模板";

    function refresh() {
      const includesTemplate = Boolean(candidate?.font && standalone.checked);
      $("desktop-import-name-label").hidden = !candidate;
      $("desktop-import-name-caption").textContent = candidate?.font ? "字体名称" : "模板名称";
      $("desktop-import-template-option").hidden = !candidate?.font;
      $("desktop-import-template-label").hidden = !includesTemplate;
      let conflict = "";
      if (candidate && nameTaken(name.value)) conflict = duplicateName;
      else if (includesTemplate && nameTaken(templateName.value)) conflict = "独立模板名称已被使用，请换一个名称。";
      else if (includesTemplate && nameKey(name.value) && nameKey(name.value) === nameKey(templateName.value)) {
        conflict = "字体和独立模板的名称不能相同。";
      }
      submit.disabled = !candidate || Boolean(conflict) || !name.value.trim() ||
        (includesTemplate && !templateName.value.trim());
      error.textContent = errorMessage || conflict;
      error.hidden = !error.textContent;
    }
    async function selectFile(files) {
      if (!files.length || submitting) return;
      const [file] = files;
      const ticket = ++selection;
      candidate = undefined;
      errorMessage = "";
      filename.textContent = files.length === 1 ? file.name : "选择 JSON 文件";
      refresh();
      try {
        if (files.length !== 1) throw new Error("请一次导入一个文件。");
        if (file.size > 8_000_000) throw new Error("文件超过 8 MB。");
        const contents = await file.text();
        if (listeners.signal.aborted || ticket !== selection) return;
        candidate = readImport(JSON.parse(contents.replace(/^\uFEFF/, "")), file.name, kind);
        name.value = candidate.name;
        templateName.value = candidate.template.name;
        standalone.checked = false;
      } catch (failure) {
        if (listeners.signal.aborted || ticket !== selection) return;
        errorMessage = failure instanceof SyntaxError ? "文件不是有效的 JSON。" : failure.message;
      }
      refresh();
      if (candidate) {
        name.focus();
        if (nameTaken(name.value)) name.select();
      }
    }
    refresh();
    $("desktop-import-choose").addEventListener("click", () => picker.click(), options);
    picker.addEventListener("change", () => {
      const files = [...picker.files];
      picker.value = "";
      selectFile(files);
    }, options);
    dialog.addEventListener("dragover", event => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = submitting ? "none" : "copy";
      dialog.classList.toggle("file-drag-over", !submitting);
    }, options);
    dialog.addEventListener("dragleave", event => {
      if (!dialog.contains(event.relatedTarget)) dialog.classList.remove("file-drag-over");
    }, options);
    dialog.addEventListener("drop", event => {
      event.preventDefault();
      dialog.classList.remove("file-drag-over");
      selectFile([...event.dataTransfer.files]);
    }, options);
    form.addEventListener("input", event => {
      if (event.target === picker) return;
      errorMessage = "";
      refresh();
    }, options);
    $("desktop-import-cancel").addEventListener("click", () => dialog.close(), options);
    dialog.addEventListener("cancel", event => { if (submitting) event.preventDefault(); }, options);
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (submitting || submit.disabled) return;
      submitting = true;
      form.inert = true;
      try {
        const importedName = checkNewName(name);
        saved = candidate.font
          ? await desktop.importFont({ ...candidate.font, name: importedName, template: candidate.template },
            standalone.checked ? checkNewName(templateName) : undefined)
          : await desktop.saveTemplate({ ...candidate.template, name: importedName });
        dialog.close();
      } catch (failure) {
        errorMessage = failure.message;
        refresh();
      } finally {
        submitting = false;
        form.inert = false;
      }
    }, options);
    try {
      await showDialog(dialog.id);
    } finally {
      listeners.abort();
      dialog.classList.remove("file-drag-over");
    }
    if (!saved) return;
    await reload();
    await slideMenu(candidate.font ? "fonts" : "templates");
    studio.notify(candidate.font ? "字体已导入。" : "模板已导入。");
    requestAnimationFrame(() => {
      $("desktop-cards").querySelector(`[data-project-id="${saved.id}"] .desktop-card`)?.focus();
    });
  }

  async function reload() {
    const data = await desktop.loadProjects();
    templates = new Map(data.templates.filter(item => readable(item)).map(item => [item.id, item]));
    fonts = new Map(data.fonts.filter(item => readable(item.template)).map(item => [item.id, item]));
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
    const name = checkNewName(setupName);
    const spec = studio.validateSpec({ ...dimensions, strokes: [] });
    const template = await desktop.saveTemplate({ name, spec, disabledRegions: [] });
    templates.set(template.id, template);
    openTemplate(template);
  }

  async function jumpToEditor(record, label, open) {
    $("desktop-jump-title").textContent = `前往${label}「${record.name}」？`;
    $("desktop-jump-detail").textContent = unconfirmedFont() ?
      "确认后将自动保存当前修改，并保留此字体项目。" : "确认后将自动保存当前修改。";
    if (await showDialog("desktop-jump-dialog") !== "jump") return;
    await saveManually();
    open(record);
  }

  function renderLinkedFonts(template) {
    const list = $("desktop-linked-font-list");
    const items = linkedFonts(template.id);
    $("desktop-linked-font-empty").hidden = items.length > 0;
    list.replaceChildren(...items.map(font => {
      const item = element("li");
      const button = element("button", "button block");
      button.type = "button";
      button.title = font.name;
      button.setAttribute("aria-haspopup", "dialog");
      button.append(element("span", "", font.name));
      button.addEventListener("click", () => run(() => jumpToEditor(font, "字体", target => openFont(target, true))));
      item.append(button);
      return item;
    }));
    list.scrollTop = 0;
  }

  function openTemplate(template) {
    editingRecord = template;
    saveFailed = false;
    setPage("template");
    nameInput.value = template.name;
    $("desktop-back-label").textContent = "模板菜单";
    studio.open({ draft: template.spec, template: template.spec, disabledRegions: template.disabledRegions });
    renderLinkedFonts(template);
    savedEditorState = structuredClone(editorState());
    updateSaveStatus();
  }

  function openFont(font, editAfterResolution = false) {
    if (pendingTemplate(font)) {
      resolve(font, editAfterResolution);
      return;
    }
    editingRecord = font;
    saveFailed = false;
    setPage("font");
    $("desktop-back-label").textContent = "字体菜单";
    const goToTemplate = $("desktop-go-to-template");
    goToTemplate.disabled = !templates.has(font.template.id);
    goToTemplate.title = goToTemplate.disabled ? "此字体使用内嵌模板，没有关联的独立模板。" : "";
    showCharacterGroups(false);
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
  }

  function markChanged() {
    clearTimeout(autoSaveTimer);
    saveFailed = false;
    updateSaveStatus();
    if (dirty() && (page !== "template" || (nameInput.value.trim() && !nameTaken(nameInput.value, editingRecord)))) {
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
      const result = await desktop.saveFont(editingRecord.id, fields);
      editingRecord = result.font;
      fonts.set(editingRecord.id, editingRecord);
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
    fontSetupName.value = suggestedName(editingRecord.name, " 字体");
    fontSetupForm.querySelectorAll("[name=character-group]").forEach(input => { input.checked = true; });
    $("desktop-font-setup-submit").disabled = false;
    setPage("font-setup");
  }

  async function createFont() {
    const name = checkNewName(fontSetupName);
    const characterGroups = new FormData(fontSetupForm).getAll("character-group");
    const font = await desktop.createFont(editingRecord.id, { name, characterGroups });
    fonts.set(font.id, font);
    openFont(font);
  }

  async function simplifyFont() {
    const simplification = studio.simplifiedTemplate();
    if (!simplification) {
      studio.notify("没有可合并或新禁用的区块。");
      return;
    }
    const { template } = editingRecord;
    const saved = await promptProject({
      title: "自动简化模板", caption: "独立模板名称", name: suggestedName(template.name, "（简化）"), action: "简化并保存",
      simplify: { original: templates.has(template.id), linked: linkedFonts(template.id).length - 1 }
    }, async (name, destination) => {
      await flushSave();
      return desktop.simplifyFont(editingRecord.id, { ...simplification, name, destination });
    });
    if (!saved) return;
    templates.set(saved.template.id, saved.template);
    fonts.set(saved.font.id, saved.font);
    openFont(saved.font);
    studio.notify("模板已简化。");
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

  function initializeGlyphControls() {
    const settings = $("font-settings");
    const fill = $("glyph-tools").closest("section");
    settings.classList.remove("split");
    fill.classList.add("split");
    fill.before(settings);
    const actions = element("section", "desktop-glyph-actions");
    const goToTemplate = element("button", "button block", "修改模板");
    goToTemplate.type = "button";
    goToTemplate.id = "desktop-go-to-template";
    goToTemplate.setAttribute("aria-haspopup", "dialog");
    goToTemplate.addEventListener("click", () => run(() => {
      const template = templates.get(editingRecord.template.id);
      if (template) return jumpToEditor(template, "模板", openTemplate);
    }));
    $("clear-glyph").classList.replace("clear", "accent");
    actions.append($("simplify-template"), goToTemplate, $("clear-glyph"));
    fill.after(actions);

    const viewport = $("characters");
    let drag;
    let suppressClick = false;
    viewport.addEventListener("pointerdown", event => {
      if (!event.isPrimary || event.button !== 0) return;
      suppressClick = false;
      if (event.pointerType === "touch" || viewport.scrollHeight <= viewport.clientHeight) return;
      drag = { pointer: event.pointerId, y: event.clientY, scrollTop: viewport.scrollTop, moved: false };
    });
    window.addEventListener("pointermove", event => {
      if (drag?.pointer !== event.pointerId) return;
      if (!(event.buttons & 1)) return endDrag(event);
      const delta = event.clientY - drag.y;
      if (!drag.moved) {
        if (Math.abs(delta) < 5) return;
        drag.moved = true;
        viewport.setPointerCapture(event.pointerId);
        viewport.classList.add("dragging");
      }
      viewport.scrollTop = drag.scrollTop - delta;
    });
    function endDrag(event) {
      if (drag?.pointer !== event.pointerId) return;
      suppressClick = drag.moved;
      drag = undefined;
      viewport.classList.remove("dragging");
    }
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    viewport.addEventListener("lostpointercapture", endDrag);
    viewport.addEventListener("click", event => {
      if (!suppressClick || event.detail === 0) return;
      suppressClick = false;
      event.stopImmediatePropagation();
      event.preventDefault();
    }, { capture: true });
  }

  function showCharacterGroups(show) {
    const button = $("desktop-edit-character-groups");
    const label = show ? "完成字库范围修改" : "修改字库范围";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-expanded", show);
    button.querySelector("use").setAttribute("href", show ? "#desktop-done-icon" : "#desktop-pencil-icon");
    $("desktop-character-groups").hidden = !show;
    $("character-tabs").hidden = show;
    $("characters").hidden = show;
    if (show) {
      const selected = project().characterGroups;
      for (const input of $("desktop-character-groups").querySelectorAll("input")) {
        input.checked = selected.includes(input.value);
      }
    } else positionChoice($("character-tabs"));
  }

  async function finishCharacterGroups() {
    const selected = [...$("desktop-character-groups").querySelectorAll(":checked")].map(input => input.value);
    const removed = studio.glyphsRemovedByScope(selected);
    if (!selected.length || removed.length) {
      const isEmpty = !selected.length;
      $("desktop-scope-title").textContent = isEmpty ? "请选择字库范围" : "删除已绘制的字形？";
      $("desktop-scope-detail").textContent = isEmpty ? "请至少保留一个类别。" :
        `本次修改将删除 ${removed.length} 个已绘制的字形（${removed.join("、")}）。`;
      $("desktop-scope-cancel").textContent = isEmpty ? "知道了" : "取消";
      $("desktop-scope-confirm").hidden = isEmpty;
      if (await showDialog("desktop-scope-dialog") !== "delete") return;
    }
    studio.setCharacterGroups(selected);
    showCharacterGroups(false);
  }

  function positionChoice(container) {
    if (!container.clientWidth) return;
    const selected = container.querySelector('[aria-pressed="true"]');
    if (!selected) return;
    container.style.setProperty("--choice-x", `${selected.offsetLeft}px`);
    container.style.setProperty("--choice-y", `${selected.offsetTop}px`);
    container.style.setProperty("--choice-width", `${selected.offsetWidth}px`);
    container.style.setProperty("--choice-height", `${selected.offsetHeight}px`);
    container.classList.add("choice-positioned");
  }

  function resolve(font, editAfterResolution) {
    resolvingFont = font;
    editWhenResolved = editAfterResolution;
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
    const chars = [...studio.charactersFor(font)].filter(ch => font.glyphs[ch]?.length || glyphs[ch]?.length);
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
      const { id, template } = resolvingFont;
      const result = await promptProject({
        title: "保留旧模板", caption: "独立模板名称", name: suggestedName(template.name, "（保留）"), action: "保留模板"
      }, name => desktop.keepTemplate(id, name));
      if (!result) return;
      templates.set(result.template.id, result.template);
      font = result.font;
    } else {
      font = await desktop.adaptFont(resolvingFont.id, preview.template, preview.glyphs);
    }
    fonts.set(font.id, font);
    if (editWhenResolved) {
      resolvingFont = null;
      editWhenResolved = false;
      preview = null;
      openFont(font);
    } else {
      showMenu("fonts");
    }
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
    initializeGlyphControls();
    initializeCardSorting();
    stopMenuScroll = initializeMenuScroll();
    const scopeButton = $("desktop-edit-character-groups");
    const scope = $("desktop-character-groups");
    scopeButton.hidden = false;
    scopeButton.addEventListener("click", () => {
      if (scope.hidden) showCharacterGroups(true);
      else run(finishCharacterGroups);
    });
    const choiceSizes = new ResizeObserver(entries => {
      for (const { target } of entries) positionChoice(target);
    });
    for (const id of ["tools", "glyph-tools", "character-tabs"]) {
      const container = $(id);
      container.classList.add("desktop-sliding-choice");
      choiceSizes.observe(container);
    }
    window.addEventListener("keydown", event => {
      if (event.key === "Tab") event.preventDefault();
    }, { capture: true });
    $("use-template").textContent = "使用此模板创建字体";
    $("simplify-template").textContent = "自动简化模板";
    $("clear-template").classList.replace("clear", "accent");
    $("desktop-setup-fields").append($("dimensions"));
    $("apply-dimensions").textContent = "创建并编辑";
    $("apply-dimensions").classList.add("accent");
    $("dimensions").addEventListener("input", renderSetupPreview);
    new ResizeObserver(renderSetupPreview).observe(setupCanvas.parentElement);
    const history = $("undo").parentElement;
    history.className = "desktop-history";
    for (const button of history.children) button.className = "button";
    $("desktop-export-project").before(history);
    for (const id of ["desktop-delete-dialog", "desktop-retain-font", "desktop-project-dialog", "desktop-jump-dialog", "desktop-scope-dialog"]) {
      $(id).addEventListener("keydown", event => event.stopPropagation());
    }
    $("desktop-template-identity").hidden = false;
    $("desktop-linked-fonts").hidden = false;
    $("tools").querySelector("[data-tool=exclude]").removeAttribute("title");
    initializeSampleScroll();
    nameInput.addEventListener("input", markChanged);
    nameInput.addEventListener("change", () => {
      if (!nameInput.value.trim() || !validEditorName(nameInput.value)) nameInput.value = editingRecord.name;
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
    $("desktop-prev-menu").addEventListener("click", () => run(() => slideMenu("templates")));
    $("desktop-next-menu").addEventListener("click", () => run(() => slideMenu("fonts")));
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

  function validEditorName(name) {
    if (!nameTaken(name, editingRecord)) return true;
    studio.notify(duplicateName);
    return false;
  }

  globalThis.GlyphCutWorkspace = {
    start, markChanged, editing, sampleText, validEditorName, positionChoice,
    createTemplate: dimensions => run(() => createTemplate(dimensions)),
    openFontSetup: () => run(openFontSetup),
    simplifyFont: () => run(simplifyFont),
    refreshSample: () => refreshSample?.(),
    exportTemplate: () => run(() => exportProject(true))
  };
})();
