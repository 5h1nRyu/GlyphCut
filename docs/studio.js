"use strict";

(() => {
  const G = globalThis.GlyphGeometry;
  const TTF = globalThis.GlyphTrueType;
  const $ = id => document.getElementById(id);
  const board = $("drawing-svg");
  const groups = {
    upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    lower: "abcdefghijklmnopqrstuvwxyz",
    digits: "0123456789"
  };
  const groupNames = Object.keys(groups);
  const alphabet = Object.values(groups).join("");
  const colors = ["#d9ebfd", "#e6f2dc", "#f8e3d1", "#ebe3fa", "#f7dfe7", "#d8eee8", "#f8efca", "#e0e5fb"];
  const axes = ["width", "height", "stepX", "stepY"];
  const cursorHelp = {
    line: "依次点击两个网格交点，右键取消起点。",
    curve: "依次选择起点、终点和控制点。右键退回一步。",
    select: "点击线条后拖动端点或控制点，都会吸附到网格交点。",
    erase: "点击要删除的线条。",
    exclude: "点击区块切换禁用状态。斜纹区块在所有字形中留空。"
  };
  const storageKey = "glyph-cut/studio-v1";
  const desktop = globalThis.glyphCutDesktop;
  const workspace = globalThis.GlyphCutWorkspace;
  const copy = value => structuredClone(value);
  const pack = value => JSON.stringify(value);
  const blankDraft = () => ({ width: 480, height: 600, stepX: 60, stepY: 60, strokes: [] });
  const newProject = () => ({
    draft: blankDraft(), template: null, glyphs: {}, disabledRegions: [], fontName: "Glyph Cut",
    baseline: 86, spacing: 18, character: "A", sample: "ABC 123", mode: "template"
  });
  const MAX_STROKES = 500;
  const MIN_ZOOM = 0.5;
  const MAX_ZOOM = 32;
  let project = newProject();
  let tool = "line";
  let glyphTool = "regions";
  const outlinePoints = [];
  const outlineSteps = [];
  let pointRegions = [];
  let hoveredOutlinePoint = null;
  let paint = null;
  let exportingPng = false;
  let group = "upper";
  let zoom = 1;
  let grid = true;
  let pending = null;
  let selectedStroke = -1;
  let drag = null;
  let rawCursor = null;
  let stageScale = 1;
  let noticeTimer;
  const previous = [];
  const future = [];
  const geometryCache = new Map();

  const xy = p => p.map(G.number).join(" ");
  const edgePath = edge => `M${xy(edge.a)}${edge.c ? `Q${xy(edge.c)} ${xy(edge.b)}` : `L${xy(edge.b)}`}`;
  function snapAxis(value, step, extent) {
    const nearest = Math.min(Math.floor(extent / step + 1e-10), Math.max(0, Math.round(value / step))) * step;
    return Math.abs(value - extent) <= Math.abs(value - nearest) ? extent : G.number(Math.min(extent, nearest));
  }

  function snap(p, draft) {
    return [snapAxis(p[0], draft.stepX, draft.width), snapAxis(p[1], draft.stepY, draft.height)];
  }

  const same = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-7;
  function onBoard() {
    if (!rawCursor) return false;
    const { width, height } = project.draft;
    const [x, y] = rawCursor;
    const margin = 5 / stageScale;
    return x >= -margin && x <= width + margin && y >= -margin && y <= height + margin;
  }

  const ready = () => project.template && pack(project.draft) === pack(project.template);

  function getGeometry(spec, computed) {
    const key = pack(spec);
    if (!geometryCache.has(key)) {
      const geometry = computed ?? G.arrange(spec);
      if (geometryCache.size === 5) geometryCache.delete(geometryCache.keys().next().value);
      geometryCache.set(key, geometry);
    }
    return geometryCache.get(key);
  }

  function validateSpec(value) {
    if (!value || typeof value !== "object" || !Array.isArray(value.strokes) || value.strokes.length > MAX_STROKES) {
      throw new Error("无法读取模板线条。");
    }
    const spec = {};
    axes.forEach((key, i) => {
      const n = value[key];
      if (!Number.isFinite(n) || n < (i < 2 ? 1 : 0.01) || n > 8192) throw new Error("画布或网格尺寸不在可用范围内。");
      spec[key] = n;
    });
    const limit = Math.max(spec.width, spec.height) * 5;
    const point = p => Array.isArray(p) && p.length === 2 && p.every(n => Number.isFinite(n) && Math.abs(n) <= limit);
    spec.strokes = value.strokes.map(edge => {
      if (!edge || !point(edge.a) || !point(edge.b) || (edge.c !== undefined && !point(edge.c))) {
        throw new Error("文件包含无效的线条坐标。");
      }
      const a = snap(edge.a, spec);
      const b = snap(edge.b, spec);
      if (!same(a, edge.a) || !same(b, edge.b) || same(a, b)) throw new Error("线条端点必须落在不同的网格交点。");
      const stroke = edge.c ? { a, b, c: edge.c.map(G.number) } : { a, b };
      if (edge.ranges !== undefined) {
        if (!Array.isArray(edge.ranges) || !edge.ranges.length || edge.ranges.length > MAX_STROKES * 4 + 16 ||
          edge.ranges.some((range, i, ranges) => !Array.isArray(range) || range.length !== 2 ||
            !range.every(Number.isFinite) || range[0] < (ranges[i - 1]?.[1] ?? 0) ||
            range[0] >= range[1] || range[1] > 1)) throw new Error("文件包含无效的线条分段。");
        stroke.ranges = edge.ranges;
      }
      return stroke;
    });
    return spec;
  }

  function readProject(value) {
    if (!value || value.format !== "glyph-cut-v1") throw new Error("请选择字形切片导出的 JSON 文件。");
    const restored = newProject();
    let characters = alphabet;
    if (workspace) {
      const selected = Array.isArray(value.characterGroups)
        ? groupNames.filter(group => value.characterGroups.includes(group)) : groupNames;
      restored.characterGroups = selected.length ? selected : groupNames;
      characters = restored.characterGroups.map(group => groups[group]).join("");
      restored.character = characters[0];
    }
    restored.draft = validateSpec(value.draft);
    if (value.template) {
      restored.template = validateSpec(value.template);
      const available = getGeometry(restored.template).faces.length;
      const isRegionId = id => Number.isInteger(id) && id >= 0 && id < available;
      const disabled = new Set(Array.isArray(value.disabledRegions) ? value.disabledRegions.filter(isRegionId) : []);
      restored.disabledRegions = [...disabled].sort((a, b) => a - b);
      for (const ch of characters) {
        const ids = value.glyphs?.[ch];
        if (!Array.isArray(ids)) continue;
        const valid = ids.filter(id => isRegionId(id) && !disabled.has(id));
        if (valid.length) restored.glyphs[ch] = [...new Set(valid)].sort((a, b) => a - b);
      }
    }
    if (typeof value.fontName === "string") restored.fontName = value.fontName.slice(0, 100);
    if (Number.isFinite(value.baseline) && value.baseline >= 0 && value.baseline <= 100) restored.baseline = value.baseline;
    if (Number.isFinite(value.spacing) && value.spacing >= 0 && value.spacing <= 8192) restored.spacing = value.spacing;
    if (typeof value.character === "string" && value.character.length === 1 && characters.includes(value.character)) {
      restored.character = value.character;
    }
    if (typeof value.sample === "string") restored.sample = value.sample.slice(0, 100);
    if (workspace) restored.autoSample = value.autoSample === true;
    restored.mode = value.mode === "glyph" && restored.template && pack(restored.template) === pack(restored.draft)
      ? "glyph" : "template";
    return restored;
  }

  function persist() {
    if (workspace) {
      workspace.markChanged();
      return;
    }
    const json = pack({ format: "glyph-cut-v1", ...project });
    try { localStorage.setItem(storageKey, json); }
    catch { /* Project downloads also work with browser storage disabled. */ }
  }

  function notify(message) {
    clearTimeout(noticeTimer);
    $("notification").textContent = message;
    $("notification").hidden = false;
    noticeTimer = setTimeout(() => { $("notification").hidden = true; }, 4800);
  }

  function checkpoint() {
    previous.push(copy(project));
    if (previous.length > 60) previous.shift();
    future.length = 0;
  }

  function change(edit) {
    checkpoint();
    edit();
    if (workspace && project.mode === "template" && !ready()) updateTemplate();
    persist();
    render();
  }

  function resetPointer() {
    pending = null;
    drag = null;
    rawCursor = null;
    selectedStroke = -1;
    paint = null;
    resetOutline();
  }

  function resetOutline() {
    outlinePoints.length = 0;
    outlineSteps.length = 0;
    pointRegions = [];
    hoveredOutlinePoint = null;
  }

  function groupFor(ch) {
    return groupNames.find(key => groups[key].includes(ch));
  }

  function travel(source, destination) {
    if (!source.length) return;
    destination.push(copy(project));
    project = source.pop();
    group = groupFor(project.character);
    resetPointer();
    persist();
    render();
  }

  function activateTool(nextTool) {
    if (project.mode !== "template" || (nextTool === "exclude" && !ready())) return;
    tool = nextTool;
    resetPointer();
    render();
  }

  function updateTemplate() {
    const next = getGeometry(project.draft);
    const existingGlyphs = Object.entries(project.glyphs);
    const nextGlyphs = {};
    let nextDisabled = [];
    let removed = 0;
    let removedDisabled = 0;
    if (existingGlyphs.length || project.disabledRegions.length) {
      const current = getGeometry(project.template);
      const nextIds = new Map(next.faces.map(face => [face.key, face.id]));
      const inherited = G.inheritedFaces(project.template, current, project.draft, next);
      const replacements = current.faces.map(({ id, key }) => {
        if (inherited?.[id]?.length) return inherited[id];
        const identical = nextIds.get(key);
        return identical === undefined ? [] : [identical];
      });
      const remap = ids => [...new Set(ids.flatMap(id => replacements[id] ?? []))].sort((a, b) => a - b);
      nextDisabled = remap(project.disabledRegions);
      removedDisabled = project.disabledRegions.filter(id => !replacements[id]?.length).length;
      const disabled = new Set(nextDisabled);
      for (const [ch, ids] of existingGlyphs) {
        const kept = remap(ids).filter(id => !disabled.has(id));
        removed += ids.filter(id => !replacements[id]?.some(child => !disabled.has(child))).length;
        if (kept.length) nextGlyphs[ch] = kept;
      }
    }
    project.template = copy(project.draft);
    project.glyphs = nextGlyphs;
    project.disabledRegions = nextDisabled;
    const changes = [];
    if (removed) changes.push(`${removed} 处旧选区已取消`);
    if (removedDisabled) changes.push(`${removedDisabled} 个旧区块的禁用状态已取消`);
    if (changes.length) notify(`分区改变，${changes.join("，")}。可撤销恢复。`);
  }

  function generate(enterGlyphs = false) {
    if (!ready()) {
      checkpoint();
      updateTemplate();
    }
    resetPointer();
    if (enterGlyphs) project.mode = "glyph";
    persist();
    render();
  }

  function switchMode(mode) {
    if (project.mode === mode) return;
    if (mode === "glyph") {
      generate(true);
      return;
    }
    project.mode = mode;
    resetPointer();
    persist();
    render();
  }

  function makeDemo() {
    const draft = { width: 480, height: 600, stepX: 30, stepY: 30, strokes: [] };
    const top = [[4, 1], [12, 1], [13, 2], [12, 3], [4, 3], [3, 2]];
    const side = [[2, 3], [3, 4], [3, 8], [2, 9], [1, 8], [1, 4]];
    const horizontal = y => top.map(([x, row]) => [x, row + y]);
    const vertical = (right, lower) => side.map(([x, y]) => [right ? 16 - x : x, y + (lower ? 8 : 0)]);
    const segments = [
      [horizontal(0), [8, 2], { 0: [8, 0] }],
      [vertical(true, false), [14, 6], {}],
      [vertical(true, true), [14, 14], {}],
      [horizontal(16), [8, 18], { 3: [8, 20] }],
      [vertical(false, true), [2, 14], {}],
      [vertical(false, false), [2, 6], {}],
      [horizontal(8), [8, 10], {}]
    ];
    const unit = p => p.map(n => n * 30);
    for (const [contour, , curves] of segments) {
      contour.forEach((a, i) => {
        const b = contour[(i + 1) % contour.length];
        draft.strokes.push(curves[i] ? { a: unit(a), b: unit(b), c: unit(curves[i]) } : { a: unit(a), b: unit(b) });
      });
    }
    const mesh = getGeometry(draft);
    const regions = segments.map(([, center]) => G.regionAt(mesh, unit(center)));
    const digits = ["012345", "12", "01643", "01236", "5612", "05623", "056234", "012", "0123456", "012356"];
    const glyphs = Object.fromEntries(digits.map((selection, digit) => [digit,
      [...selection].map(id => regions[Number(id)]).filter(id => id !== undefined).sort((a, b) => a - b)]));
    return { ...newProject(), draft, template: copy(draft), glyphs, character: "8", sample: "2026",
      fontName: "Seven Segment Cut", mode: "glyph", spacing: 0 };
  }

  function padFor(draft) { return Math.max(draft.width, draft.height) * 0.06; }

  function pointerPosition(event) {
    const matrix = board.getScreenCTM();
    if (!matrix) return [0, 0];
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return [point.x, point.y];
  }

  function sizeStage() {
    const { width, height } = project.draft;
    const pad = padFor(project.draft);
    const frameWidth = width + pad * 2;
    const frameHeight = height + pad * 2;
    const stage = $("stage");
    stageScale = Math.max(0.002, Math.min((stage.offsetWidth - 30) / frameWidth, (stage.offsetHeight - 30) / frameHeight)) * zoom;
    board.style.width = `${frameWidth * stageScale}px`;
    board.style.height = `${frameHeight * stageScale}px`;
    $("fit").textContent = `${Math.round(100 * zoom)}%`;
    $("zoom-out").disabled = zoom <= MIN_ZOOM;
    $("zoom-in").disabled = zoom >= MAX_ZOOM;
  }

  function marker(p, type = "preview", control = false) {
    // Leave an outer ring for the control point when it snaps onto an endpoint.
    const radius = (control ? 7.5 : 4.2) / stageScale;
    const key = type === "preview" ? 'pointer-events="none"' : `data-handle="${type}"`;
    return `<circle class="handle" cx="${p[0]}" cy="${p[1]}" r="${radius}" fill="${control ? "#bcccff" : "#fff"}" ${key}/>`;
  }

  function draftOverlay() {
    const layer = $("draft-overlay");
    if (!layer) return;
    const coordinate = rawCursor && (pending?.b || drag || onBoard()) ? snap(rawCursor, project.draft) : null;
    $("coordinates").textContent = coordinate ? `X ${G.number(coordinate[0]).toFixed(1)} · Y ${G.number(coordinate[1]).toFixed(1)}` : "";
    if (project.mode !== "template" || (tool !== "line" && tool !== "curve")) {
      layer.replaceChildren();
      return;
    }
    if (!pending) {
      layer.innerHTML = coordinate ? marker(coordinate) : "";
      return;
    }
    const cursor = coordinate ?? pending.a;
    if (!pending.b) {
      layer.innerHTML = `<path class="board-line draft" d="${edgePath({ a: pending.a, b: cursor })}"/>${marker(pending.a)}${marker(cursor)}`;
      return;
    }
    const c = pending.c ?? coordinate ?? pending.defaultControl;
    const curve = { ...pending, c };
    layer.innerHTML = `<path class="guideline" d="M${xy(curve.a)}L${xy(c)}L${xy(curve.b)}"/>
      <path class="board-line draft" d="${edgePath(curve)}"/>${marker(curve.a)}${marker(curve.b)}${marker(c, "preview", true)}`;
  }

  function renderGlyphVertices(geometry, selected) {
    const vertices = geometry ? G.outlineVertices(geometry, selected) : [];
    $("glyph-vertex-count").textContent = vertices.length;
    const radius = 3 / stageScale;
    $("glyph-vertex-overlay").innerHTML = vertices.map(([x, y]) =>
      `<circle class="glyph-vertex" cx="${x}" cy="${y}" r="${radius}"/>`).join("");
  }

  const outlineClosed = () => outlineSteps.length > 0 && outlinePoints[0] === outlinePoints.at(-1);
  const pointFillActive = () => project.mode === "glyph" && glyphTool === "points";
  const chosenConnection = step => step.options[step.index];

  function nearestOutlinePoint(geometry, event) {
    const [x, y] = pointerPosition(event);
    let closest = null;
    let distance = 8 / stageScale;
    for (const node of geometry.boundaryPoints) {
      const offset = Math.hypot(x - node.p[0], y - node.p[1]);
      if (offset >= distance) continue;
      closest = node;
      distance = offset;
    }
    return closest;
  }

  function updateOutlineHover(node) {
    if (node === hoveredOutlinePoint) return;
    hoveredOutlinePoint = node;
    const overlay = $("point-fill-overlay");
    overlay?.querySelector(".hovered")?.classList.remove("hovered");
    if (node) overlay?.querySelector(`[data-outline-point="${node.id}"]`)?.classList.add("hovered");
  }

  function renderPointFill(geometry, selected) {
    const closed = outlineClosed();
    const regions = pointRegions.map(({ ids, path }, index) => {
      if (!ids.length) return "";
      const pressed = ids.every(id => selected.has(id)) ? "true" : ids.some(id => selected.has(id)) ? "mixed" : "false";
      return `<path class="outline-region" d="${path}" fill-rule="nonzero" data-point-region="${index}"
        tabindex="0" role="button" aria-label="画布分区 ${index + 1}" aria-pressed="${pressed}"/>`;
    }).join("");
    const selectedNodes = new Set(outlinePoints);
    const steps = outlineSteps.map((step, i) => {
      const connection = chosenConnection(step);
      const commands = connection.map(edge => edge.c ? `Q${xy(edge.c)} ${xy(edge.b)}` : `L${xy(edge.b)}`).join("");
      const current = i === outlineSteps.length - 1 && step.options.length > 1;
      return `<path class="outline-segment${current ? " current" : ""}" d="M${xy(connection[0].a)}${commands}"/>`;
    }).join("");
    const points = geometry.boundaryPoints.map(node => {
      const chosen = selectedNodes.has(node);
      const start = node === outlinePoints[0];
      const hovered = !closed && node === hoveredOutlinePoint;
      const [x, y] = node.p;
      const radius = (chosen ? 5 : 3.5) / stageScale;
      return `<circle class="outline-point${chosen ? " selected" : ""}${start ? " start" : ""}${hovered ? " hovered" : ""}"
        data-outline-point="${node.id}" cx="${x}" cy="${y}" r="${radius}" tabindex="0" role="button"
        aria-label="模板点 ${G.number(x)}, ${G.number(y)}" aria-pressed="${chosen}"/>`;
    }).join("");
    $("point-fill-overlay").innerHTML = `${regions}<g aria-hidden="true">${steps}</g>${points}`;

    const last = outlineSteps.at(-1);
    const status = $("point-fill-status");
    const details = [];
    if (last?.options.length > 1) {
      const type = chosenConnection(last)[0].c ? "曲线" : "直线";
      details.push(`最后一段 ${type} ${last.index + 1}/${last.options.length}`);
    }
    if (closed) details.push("轮廓已闭合。");
    status.textContent = details.join(" · ");
    status.hidden = !details.length;
    $("cycle-point-connection").hidden = !(last?.options.length > 1);
  }

  function renderBoard() {
    const focused = document.activeElement?.dataset;
    const { width, height, stepX, stepY, strokes } = project.draft;
    const pad = padFor(project.draft);
    board.setAttribute("viewBox", `${-pad} ${-pad} ${width + 2 * pad} ${height + 2 * pad}`);
    board.classList.toggle("drawing-cursor", project.mode === "template" && (tool === "line" || tool === "curve"));
    board.classList.toggle("erase-cursor", project.mode === "template" && tool === "erase");
    board.classList.toggle("select-cursor", project.mode === "template" && tool === "select");
    sizeStage();
    const glyphMode = project.mode === "glyph";
    const pointMode = pointFillActive();
    const markRegions = !glyphMode && tool === "exclude";
    const geometry = ready() ? getGeometry(project.draft) : null;
    const selected = new Set(project.glyphs[project.character] ?? []);
    const disabled = new Set(project.disabledRegions);
    if (paint) for (const id of paint.regions) selected.add(id);
    const regions = geometry?.faces.map(face => {
      const excluded = disabled.has(face.id);
      const pickable = markRegions || (glyphMode && !pointMode && !excluded);
      const picked = glyphMode && !excluded && selected.has(face.id);
      const interactive = pickable ? `data-${markRegions ? "exclude-region" : "region"}="${face.id}" tabindex="0" role="button"
        aria-label="${markRegions ? "禁用" : ""}区块 ${face.id + 1}" aria-pressed="${markRegions ? excluded : picked}"` :
        'pointer-events="none"';
      return `<path class="region${pointMode ? " point-guide" : ""}${pickable ? " pickable" : ""}${picked ? " picked" : ""}${excluded ? " excluded" : ""}"
        d="${face.path}" fill="${pointMode ? "#f8fafc" : colors[face.id % colors.length]}" fill-rule="nonzero"
        ${interactive}></path>`;
    }).join("") ?? "";
    const showHit = tool === "select" || tool === "erase";
    const artwork = glyphMode ? "" : strokes.map((stroke, i) => {
      const edge = drag?.index === i && drag.candidate ? drag.candidate : stroke;
      const path = G.strokeParts(edge).map(edgePath).join("");
      return `${showHit ? `<path class="stroke-hit" data-stroke="${i}" d="${path}"/>` : ""}
        <path class="board-line${i === selectedStroke ? " chosen" : ""}" pointer-events="none" d="${path}"/>`;
    }).join("");
    const unused = !glyphMode && geometry && !drag ? geometry.unused.map(edge =>
      `<path class="board-line unused" d="${edgePath(edge)}"/>`).join("") : "";
    const selectedEdge = !glyphMode && tool === "select" && (drag?.candidate ?? strokes[selectedStroke]);
    const curve = selectedEdge?.c ? selectedEdge : null;
    const curveDefinition = $("curve-definition");
    curveDefinition.hidden = !curve;
    let curveSource = "";
    if (curve) {
      for (const key of ["a", "c", "b"]) {
        const [x, y] = curve[key];
        $(`curve-point-${key}`).textContent = `${G.number(x)}, ${G.number(y)}`;
      }
      // Simplification keeps the original quadratic and a list of the parameter ranges still in use.
      const ranges = curve.ranges;
      if (ranges && (ranges.length > 1 || ranges[0][0] > 0 || ranges[0][1] < 1)) {
        curveSource = `<path class="board-line curve-source" d="${edgePath(curve)}"/>`;
      }
    }
    const control = curve ? `<path class="guideline" d="M${xy(curve.a)}L${xy(curve.c)}L${xy(curve.b)}"/>
      ${marker(curve.c, "c", true)}` : "";
    const handles = selectedEdge ? `${control}${marker(selectedEdge.a, "a")}${marker(selectedEdge.b, "b")}` : "";
    const baseline = height * project.baseline / 100;
    const ruler = !workspace && glyphMode && grid ? `<path pointer-events="none" d="M0 ${baseline}H${width}" stroke="#8978a6" stroke-dasharray="5 4" stroke-width=".9" vector-effect="non-scaling-stroke"><title>基线</title></path>` : "";
    const hatch = 7 / stageScale;
    board.innerHTML = `<defs>
      <pattern id="excluded-region-hatch" width="${hatch}" height="${hatch}" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="${hatch}" height="${hatch}" fill="#e5e9ef"/>
        <path d="M${hatch / 2} 0V${hatch}" stroke="#9ca9bc" stroke-width="1.3" vector-effect="non-scaling-stroke"/>
      </pattern>
      <pattern id="work-grid" width="${stepX}" height="${stepY}" patternUnits="userSpaceOnUse">
        <path d="M${stepX} 0H0V${stepY}" fill="none" stroke="#627392" stroke-opacity=".42" stroke-width=".75" vector-effect="non-scaling-stroke"/>
      </pattern><clipPath id="paper"><rect width="${width}" height="${height}"/></clipPath>
      </defs>
      <rect width="${width}" height="${height}" rx="1" fill="#f8fafc"/>
      <g clip-path="url(#paper)">${regions}
        ${grid ? `<rect width="${width}" height="${height}" fill="url(#work-grid)" pointer-events="none"/>` : ""}
        ${ruler}${curveSource}${artwork}${unused}
      </g>
      <rect width="${width}" height="${height}" fill="none" stroke="#9badc6" stroke-width="1.25" vector-effect="non-scaling-stroke" pointer-events="none"/>
      ${handles}
      ${glyphMode ? '<g id="glyph-vertex-overlay" pointer-events="none" aria-hidden="true"></g>' : ""}
      ${pointMode ? '<g id="point-fill-overlay"></g>' : ""}
      <g id="draft-overlay" pointer-events="none"></g>`;
    if (glyphMode) renderGlyphVertices(geometry, selected);
    if (pointMode && geometry) renderPointFill(geometry, selected);
    draftOverlay();
    if (focused?.region !== undefined) board.querySelector(`[data-region="${focused.region}"]`)?.focus({ preventScroll: true });
    if (focused?.excludeRegion !== undefined) board.querySelector(`[data-exclude-region="${focused.excludeRegion}"]`)?.focus({ preventScroll: true });
    if (focused?.outlinePoint !== undefined) board.querySelector(`[data-outline-point="${focused.outlinePoint}"]`)?.focus({ preventScroll: true });
    if (focused?.pointRegion !== undefined) board.querySelector(`[data-point-region="${focused.pointRegion}"]`)?.focus({ preventScroll: true });
  }

  function updateHelp() {
    let help = workspace && tool === "line" ? "" : cursorHelp[tool];
    if (pending?.b) help = "点击或拖动控制点，自动吸附。右键取消终点。";
    else if (pending) help = "起点已选。点击终点，或右键取消起点。";
    $("tool-help").textContent = help;
    $("tool-help").hidden = !help;
  }

  function renderSample() {
    const sample = $("sample-output");
    sample.replaceChildren();
    workspace?.refreshSample();
    const text = workspace?.sampleText(project) ?? project.sample;
    if (workspace) $("sample-text").placeholder = project.autoSample ? text : "";
    if (project.mode !== "glyph" || !text) return;
    const geometry = getGeometry(project.template);
    const { width, height } = project.template;
    const spacing = project.spacing;
    for (const ch of text) {
      if (ch === " ") {
        const space = document.createElement("span");
        space.className = "space";
        space.style.width = `${Math.min(90, 53 * (width + spacing * 2) / height / 2)}px`;
        sample.append(space);
        continue;
      }
      const ids = project.glyphs[ch];
      if (!ids?.length) {
        const empty = document.createElement("span");
        empty.className = "empty";
        empty.textContent = ch;
        empty.title = "字形尚未绘制";
        sample.append(empty);
        continue;
      }
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", `${-spacing} 0 ${width + spacing * 2} ${height}`);
      svg.setAttribute("width", String(53 * (width + spacing * 2) / height));
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", ch);
      const path = document.createElementNS(svg.namespaceURI, "path");
      path.setAttribute("d", G.path(G.trace(geometry, new Set(ids))));
      path.setAttribute("fill", "currentColor");
      svg.append(path);
      sample.append(svg);
    }
  }

  function render() {
    const glyphMode = project.mode === "glyph";
    $("template-controls").hidden = glyphMode;
    $("glyph-controls").hidden = !glyphMode;
    $("template-preview").hidden = glyphMode;
    $("glyph-preview").hidden = !glyphMode;
    $("mode-template").classList.toggle("selected", !glyphMode);
    $("mode-template").setAttribute("aria-pressed", !glyphMode);
    $("mode-glyph").classList.toggle("selected", glyphMode);
    $("mode-glyph").setAttribute("aria-pressed", glyphMode);
    $("drawing-title").textContent = glyphMode ? `字形 ${project.character}` : "模板画布";
    $("canvas-status").textContent = `${project.draft.width} × ${project.draft.height}`;
    $("glyph-vertex-status").hidden = !glyphMode;
    $("undo").disabled = !previous.length;
    $("redo").disabled = !future.length;
    const confirmed = ready();
    if (!glyphMode) {
      if (tool === "exclude" && !confirmed) tool = "line";
      if (!workspace) axes.forEach(id => { $(id).value = project.draft[id]; });
      $("tools").querySelectorAll("button").forEach(button => {
        if (button.dataset.tool === "exclude") button.disabled = !confirmed;
        const active = button.dataset.tool === tool;
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", active);
      });
      const geometry = confirmed ? getGeometry(project.draft) : null;
      $("stroke-count").textContent = project.draft.strokes.length;
      $("region-count").textContent = geometry?.faces.length ?? "—";
      const explanation = $("template-status");
      const unused = geometry ? new Set(geometry.unused.flatMap(edge => [...edge.sources])).size : 0;
      explanation.classList.toggle("warning", unused > 0);
      explanation.textContent = geometry ?
        (unused ? `${unused} 条线有部分未形成分区，以虚线标出。` :
          workspace ? "" : "区块已生成，可进入字形设计。") :
        (project.template ? "线条已修改，重新生成可预览新的分区。" : "绘制分割线后生成区块。");
      if (confirmed && project.disabledRegions.length) explanation.textContent += `已禁用 ${project.disabledRegions.length} 个区块。`;
      explanation.hidden = !explanation.textContent;
      $("use-template").disabled = !confirmed;
      $("generate").disabled = Boolean(confirmed);
      $("clear-template").disabled = !project.draft.strokes.length;
      updateHelp();
    } else {
      $("font-name").value = project.fontName;
      if (!workspace) $("baseline").value = project.baseline;
      $("spacing").value = project.spacing;
      $("sample-text").value = project.autoSample ? "" : project.sample;
      const size = Object.keys(project.glyphs).length;
      $("simplify-template").disabled = !size;
      $("glyph-disabled-help").hidden = !project.disabledRegions.length;
      $("region-fill-help").hidden = pointFillActive();
      $("point-fill-controls").hidden = !pointFillActive();
      $("glyph-tools").querySelectorAll("button").forEach(button => {
        const active = button.dataset.glyphTool === glyphTool;
        button.classList.toggle("selected", active);
        button.setAttribute("aria-pressed", active);
      });
      const characterGroups = project.characterGroups ?? groupNames;
      const capacity = characterGroups.reduce((total, key) => total + groups[key].length, 0);
      $("glyph-count").textContent = `${size} / ${capacity}`;
      const tabs = $("character-tabs");
      if (workspace) tabs.style.gridTemplateColumns = `repeat(${characterGroups.length}, minmax(0, 1fr))`;
      tabs.querySelectorAll("button").forEach(button => {
        button.hidden = !characterGroups.includes(button.dataset.group);
        const active = button.dataset.group === group;
        button.classList.toggle("selected", active);
        button.setAttribute("aria-pressed", active);
      });
      const activeCharacter = document.activeElement?.dataset.char;
      $("characters").innerHTML = [...groups[group]].map(ch =>
        `<button class="character${ch === project.character ? " active" : ""}${project.glyphs[ch]?.length ? " designed" : ""}"
          type="button" aria-pressed="${ch === project.character}" data-char="${ch}">${ch}</button>`).join("");
      if (activeCharacter) $("characters").querySelector(`[data-char="${activeCharacter}"]`)?.focus({ preventScroll: true });
      $("export-ttf").disabled = !size;
      $("export-all-svg").disabled = !size;
      $("export-all-png").disabled = !size || exportingPng;
      $("export-svg").disabled = !project.glyphs[project.character]?.length;
      $("clear-glyph").disabled = $("export-svg").disabled;
      renderSample();
    }
    renderBoard();
  }

  function updatePicks(picks) {
    const disabled = new Set(project.disabledRegions);
    const ids = [...picks].filter(id => !disabled.has(id)).sort((a, b) => a - b);
    const current = project.glyphs[project.character] ?? [];
    if (ids.length === current.length && ids.every((id, i) => id === current[i])) return;
    change(() => {
      if (ids.length) project.glyphs[project.character] = ids;
      else delete project.glyphs[project.character];
    });
  }

  function toggleRegion(id) {
    const picks = new Set(project.glyphs[project.character] ?? []);
    if (picks.has(id)) picks.delete(id);
    else picks.add(id);
    updatePicks(picks);
  }

  function refreshOutline() {
    const geometry = getGeometry(project.template);
    const disabled = new Set(project.disabledRegions);
    pointRegions = outlineSteps.length ? G.partitionByPath(geometry, outlineSteps.flatMap(chosenConnection)).map(ids => ({
      path: G.path(G.trace(geometry, new Set(ids))),
      ids: ids.filter(id => !disabled.has(id))
    })) : [];
    renderBoard();
  }

  function selectOutlinePoint(geometry, node) {
    if (!node || outlineClosed()) return;
    const last = outlinePoints.at(-1);
    if (last) {
      const used = new Set(outlineSteps.flatMap(chosenConnection));
      const options = G.pointConnections(geometry, last, node, used);
      if (!options.length) {
        notify("请选择一个能沿模板直线或曲线连接的点。");
        return;
      }
      outlineSteps.push({ options, index: 0 });
    }
    outlinePoints.push(node);
    refreshOutline();
  }

  function cyclePointConnection(direction) {
    const last = outlineSteps.at(-1);
    if (!last || last.options.length < 2) return;
    last.index = (last.index + direction + last.options.length) % last.options.length;
    refreshOutline();
  }

  function togglePointRegion(index) {
    const region = pointRegions[index];
    if (!region?.ids.length) return;
    const picks = new Set(project.glyphs[project.character] ?? []);
    if (region.ids.every(id => picks.has(id))) {
      for (const id of region.ids) picks.delete(id);
    } else {
      for (const id of region.ids) picks.add(id);
    }
    updatePicks(picks);
  }

  function toggleDisabledRegion(id) {
    const disabled = new Set(project.disabledRegions);
    if (disabled.delete(id)) {
      change(() => { project.disabledRegions = [...disabled]; });
      return;
    }
    disabled.add(id);
    let removed = 0;
    change(() => {
      project.disabledRegions = [...disabled].sort((a, b) => a - b);
      for (const [character, ids] of Object.entries(project.glyphs)) {
        if (!ids.includes(id)) continue;
        const remaining = ids.filter(region => region !== id);
        if (remaining.length) project.glyphs[character] = remaining;
        else delete project.glyphs[character];
        removed++;
      }
    });
    if (removed) notify(`已禁用区块，并清除 ${removed} 个字形中的对应填充。可撤销。`);
  }

  function paintThrough(event) {
    if (paint.regions.size === 0 && Math.hypot(event.clientX - paint.x, event.clientY - paint.y) < 4) return;
    const current = pointerPosition(event);
    const geometry = getGeometry(project.template);
    const touched = G.regionsAlong(geometry, paint.last, current);
    touched.add(paint.start);
    const selected = new Set(project.glyphs[project.character]);
    let changed = false;
    for (const id of touched) {
      if (paint.regions.has(id) || paint.disabled.has(id)) continue;
      paint.regions.add(id);
      if (selected.has(id)) continue;
      changed = true;
      board.querySelector(`[data-region="${id}"]`)?.classList.add("picked");
    }
    if (changed) {
      for (const id of paint.regions) selected.add(id);
      renderGlyphVertices(geometry, selected);
    }
    paint.last = current;
  }

  function addStroke(stroke) {
    pending = null;
    if (project.draft.strokes.length >= MAX_STROKES) {
      notify(`每个模板最多可绘制 ${MAX_STROKES} 条线。`);
      renderBoard();
      updateHelp();
      return;
    }
    change(() => { project.draft.strokes.push(stroke); });
  }

  function eraseStroke(index) {
    if (!project.draft.strokes[index]) return;
    selectedStroke = -1;
    change(() => { project.draft.strokes.splice(index, 1); });
  }

  board.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    if (project.mode === "glyph") {
      if (paint || event.target.dataset.region === undefined) return;
      paint = { pointer: event.pointerId, x: event.clientX, y: event.clientY,
        start: Number(event.target.dataset.region), last: pointerPosition(event),
        regions: new Set(), disabled: new Set(project.disabledRegions) };
      board.setPointerCapture(event.pointerId);
      return;
    }
    rawCursor = pointerPosition(event);
    if (tool === "select") {
      if (event.target.dataset.handle && selectedStroke >= 0) {
        const key = event.target.dataset.handle;
        drag = { index: selectedStroke, key, candidate: copy(project.draft.strokes[selectedStroke]) };
        board.setPointerCapture(event.pointerId);
      } else {
        selectedStroke = event.target.dataset.stroke === undefined ? -1 : Number(event.target.dataset.stroke);
        renderBoard();
      }
    } else if (tool === "curve" && pending?.b) {
      pending.c = snap(rawCursor, project.draft);
      board.setPointerCapture(event.pointerId);
      draftOverlay();
    }
  });

  board.addEventListener("pointermove", event => {
    if (project.mode === "glyph") {
      if (paint?.pointer === event.pointerId) paintThrough(event);
      else if (pointFillActive() && !outlineClosed()) {
        updateOutlineHover(nearestOutlinePoint(getGeometry(project.template), event));
      }
      return;
    }
    rawCursor = pointerPosition(event);
    if (drag) {
      drag.candidate[drag.key] = snap(rawCursor, project.draft);
      renderBoard();
    } else {
      if (pending?.c) pending.c = snap(rawCursor, project.draft);
      draftOverlay();
    }
  });

  board.addEventListener("pointerleave", () => {
    updateOutlineHover(null);
    if (drag || pending?.c) return;
    rawCursor = null;
    draftOverlay();
  });

  board.addEventListener("pointercancel", event => {
    if (project.mode === "glyph") {
      updateOutlineHover(null);
      if (paint?.pointer === event.pointerId) {
        paint = null;
        renderBoard();
      }
      return;
    }
    resetPointer();
    renderBoard();
    updateHelp();
  });

  board.addEventListener("lostpointercapture", event => {
    if (paint?.pointer !== event.pointerId) return;
    paint = null;
    renderBoard();
  });

  board.addEventListener("pointerup", event => {
    if (event.button !== 0) return;
    if (project.mode === "glyph") {
      if (paint?.pointer !== event.pointerId) return;
      paintThrough(event);
      const { regions, start } = paint;
      paint = null;
      if (regions.size) {
        updatePicks(new Set([...(project.glyphs[project.character] ?? []), ...regions]));
      } else toggleRegion(start);
      return;
    }
    rawCursor = pointerPosition(event);
    if (drag) {
      const { candidate, index, key } = drag;
      candidate[key] = snap(rawCursor, project.draft);
      drag = null;
      if (same(candidate.a, candidate.b)) {
        renderBoard();
        notify("起点和终点必须位于不同网格交点。");
      } else if (pack(candidate) !== pack(project.draft.strokes[index])) {
        change(() => { project.draft.strokes[index] = candidate; });
      } else renderBoard();
      return;
    }
    if (tool === "select" || tool === "exclude") return;
    if (tool === "erase") {
      if (event.target.dataset.stroke !== undefined) eraseStroke(Number(event.target.dataset.stroke));
      return;
    }
    if (pending?.b) {
      addStroke({ a: pending.a, b: pending.b, c: snap(rawCursor, project.draft) });
      return;
    }
    if (!onBoard()) return;
    const location = snap(rawCursor, project.draft);
    if (!pending) {
      pending = { a: location };
    } else if (same(pending.a, location)) {
      notify("请选择另一个网格交点作为终点。");
    } else if (tool === "line") {
      addStroke({ a: pending.a, b: location });
      return;
    } else {
      pending.b = location;
      const midpoint = [(pending.a[0] + location[0]) / 2, (pending.a[1] + location[1]) / 2];
      pending.defaultControl = snap(midpoint, project.draft);
      rawCursor = null;
    }
    draftOverlay();
    updateHelp();
  });

  board.addEventListener("contextmenu", event => {
    if (pointFillActive()) {
      event.preventDefault();
      if (!outlinePoints.length) return;
      outlinePoints.pop();
      outlineSteps.pop();
      refreshOutline();
      return;
    }
    if (project.mode !== "template" || (tool !== "line" && tool !== "curve")) return;
    event.preventDefault();
    pending = pending?.b ? { a: pending.a } : null;
    draftOverlay();
    updateHelp();
  });
  board.addEventListener("click", event => {
    const { region, excludeRegion, outlinePoint, pointRegion } = event.target.dataset;
    if (pointFillActive()) {
      const geometry = getGeometry(project.template);
      const node = event.detail === 0
        ? geometry.boundaryPoints.find(point => point.id === Number(outlinePoint))
        : outlineClosed() ? null : nearestOutlinePoint(geometry, event);
      if (node) selectOutlinePoint(geometry, node);
      else if (pointRegion !== undefined) togglePointRegion(Number(pointRegion));
      return;
    }
    if (excludeRegion !== undefined) toggleDisabledRegion(Number(excludeRegion));
    else if (event.detail === 0 && region !== undefined) toggleRegion(Number(region));
  });
  board.addEventListener("keydown", event => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const { region, excludeRegion, outlinePoint, pointRegion } = event.target.dataset;
    if (region === undefined && excludeRegion === undefined && outlinePoint === undefined && pointRegion === undefined) return;
    event.preventDefault();
    if (outlinePoint !== undefined) {
      const geometry = getGeometry(project.template);
      selectOutlinePoint(geometry, geometry.boundaryPoints.find(node => node.id === Number(outlinePoint)));
    } else if (pointRegion !== undefined) togglePointRegion(Number(pointRegion));
    else if (excludeRegion !== undefined) toggleDisabledRegion(Number(excludeRegion));
    else toggleRegion(Number(region));
  });

  $("dimensions").addEventListener("submit", event => {
    event.preventDefault();
    const updated = Object.fromEntries(axes.map(id => [id, $(id).valueAsNumber]));
    if (workspace) {
      workspace.createTemplate(updated);
      return;
    }
    if (axes.every(id => updated[id] === project.draft[id])) return;
    const strokes = project.draft.strokes.map(edge => ({
      a: snap(edge.a, updated), b: snap(edge.b, updated),
      ...(edge.c ? { c: snap(edge.c, updated) } : {}),
      ...(edge.ranges ? { ranges: edge.ranges } : {})
    }))
      .filter(edge => !same(edge.a, edge.b));
    const total = project.draft.strokes.length;
    resetPointer();
    change(() => { project.draft = { ...updated, strokes }; });
    if (total !== strokes.length) notify(`${total - strokes.length} 条线的端点重合，已移除。可撤销恢复。`);
    else if (total) notify("已按新网格重新吸附线条端点和曲线控制点。");
  });

  $("tools").addEventListener("click", event => {
    const button = event.target.closest("[data-tool]");
    if (button) activateTool(button.dataset.tool);
  });
  $("generate").addEventListener("click", () => generate());
  $("use-template").addEventListener("click", () => workspace ? workspace.openFontSetup() : generate(true));
  $("mode-glyph").addEventListener("click", () => switchMode("glyph"));
  $("mode-template").addEventListener("click", () => switchMode("template"));
  $("undo").addEventListener("click", () => travel(previous, future));
  $("redo").addEventListener("click", () => travel(future, previous));
  $("clear-template").addEventListener("click", () => {
    resetPointer();
    change(() => { project.draft.strokes = []; });
  });
  $("load-example").addEventListener("click", () => {
    resetPointer();
    const demo = makeDemo();
    change(() => {
      if (workspace) {
        const original = demo.draft;
        const draft = project.draft;
        const fit = ([x, y]) => snap([x * draft.width / original.width, y * draft.height / original.height], draft);
        draft.strokes = original.strokes.map(({ a, b, c }) => ({
          a: fit(a), b: fit(b), ...(c ? { c: fit(c) } : {})
        })).filter(({ a, b }) => !same(a, b));
        project.disabledRegions = [];
      } else {
        project = demo;
      }
      group = groupFor(project.character);
    });
    notify(workspace ? "已按当前画布和网格载入示例。" : "已载入七段数字。切换到模板编辑可查看分割线。");
  });
  $("show-grid").addEventListener("change", event => {
    grid = event.target.checked;
    renderBoard();
  });

  function zoomTo(value) {
    const nextZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
    if (nextZoom === zoom) return;
    const stage = $("stage");
    const viewport = stage.getBoundingClientRect();
    const before = board.getBoundingClientRect();
    const x = (viewport.left + stage.clientWidth / 2 - before.left) / before.width;
    const y = (viewport.top + stage.clientHeight / 2 - before.top) / before.height;
    zoom = nextZoom;
    renderBoard();
    const after = board.getBoundingClientRect();
    stage.scrollBy(after.left + x * after.width - viewport.left - stage.clientWidth / 2,
      after.top + y * after.height - viewport.top - stage.clientHeight / 2);
  }
  $("zoom-out").addEventListener("click", () => zoomTo(zoom / 1.25));
  $("zoom-in").addEventListener("click", () => zoomTo(zoom * 1.25));
  $("fit").addEventListener("click", () => zoomTo(1));
  new ResizeObserver(() => {
    if (!workspace) renderBoard();
    else if (workspace.editing()) requestAnimationFrame(() => {
      if (workspace.editing()) renderBoard();
    });
  }).observe($("stage"));

  $("glyph-tools").addEventListener("click", event => {
    const button = event.target.closest("[data-glyph-tool]");
    if (!button || glyphTool === button.dataset.glyphTool) return;
    glyphTool = button.dataset.glyphTool;
    resetPointer();
    render();
  });
  $("stage").addEventListener("wheel", event => {
    if (!pointFillActive() || event.ctrlKey || !event.deltaY || !(outlineSteps.at(-1)?.options.length > 1)) return;
    event.preventDefault();
    cyclePointConnection(Math.sign(event.deltaY));
  }, { passive: false });
  $("cycle-point-connection").addEventListener("click", () => cyclePointConnection(1));

  function simplifiedTemplate() {
    const before = getGeometry(project.template);
    const result = G.simplify(project.template, before, project.glyphs);
    const geometry = result?.geometry ?? before;
    const glyphs = result?.glyphs ?? project.glyphs;
    const used = new Set(Object.values(glyphs).flat());
    const disabledRegions = geometry.faces.filter(face => !used.has(face.id)).map(face => face.id);
    if (!result && pack(disabledRegions) === pack(project.disabledRegions)) return null;
    if (result) getGeometry(result.draft, geometry);
    return { spec: result?.draft ?? project.template, glyphs, disabledRegions };
  }

  $("simplify-template").addEventListener("click", () => {
    if (workspace) return workspace.simplifyFont();
    try {
      const before = getGeometry(project.template);
      const result = simplifiedTemplate();
      if (!result) {
        notify("没有可合并或新禁用的区块。");
        return;
      }
      const count = getGeometry(result.spec).faces.length;
      resetPointer();
      change(() => {
        project.draft = result.spec;
        project.template = copy(result.spec);
        project.glyphs = result.glyphs;
        project.disabledRegions = result.disabledRegions;
      });
      const merged = count < before.faces.length ? `区块数由 ${before.faces.length} 减为 ${count}。` : "";
      notify(`${merged}共禁用 ${result.disabledRegions.length} 个未使用区块。可撤销。`);
    } catch (error) {
      notify(error.message);
    }
  });

  $("character-tabs").addEventListener("click", event => {
    const tab = event.target.closest("[data-group]");
    if (!tab || tab.hidden) return;
    group = tab.dataset.group;
    if (!groups[group].includes(project.character)) project.character = groups[group][0];
    resetOutline();
    persist();
    render();
  });
  $("characters").addEventListener("click", event => {
    const button = event.target.closest("[data-char]");
    if (!button) return;
    project.character = button.dataset.char;
    resetOutline();
    persist();
    render();
  });
  $("clear-glyph").addEventListener("click", () => change(() => { delete project.glyphs[project.character]; }));
  $("sample-text").addEventListener("input", event => {
    project.sample = event.target.value;
    if (workspace) project.autoSample = !project.sample;
    persist();
    renderSample();
  });
  $("font-name").addEventListener("change", event => {
    const name = event.target.value.trim() || "Glyph Cut";
    if (name !== project.fontName && (!workspace || workspace.validEditorName(name))) change(() => { project.fontName = name; });
    else if (workspace) event.target.value = project.fontName;
    else event.target.value = name;
  });
  for (const id of workspace ? ["spacing"] : ["spacing", "baseline"]) {
    $(id).addEventListener("change", event => {
      const input = event.target;
      if (!input.value.length || !input.checkValidity()) {
        input.value = project[id];
        return;
      }
      if (input.valueAsNumber !== project[id]) change(() => { project[id] = input.valueAsNumber; });
    });
  }

  function download(data, type, filename) {
    const blob = new Blob([data], { type });
    if (desktop) {
      return blob.arrayBuffer().then(bytes => desktop.saveFile(filename, bytes))
        .catch(() => notify(`无法保存 ${filename}。请检查保存位置后重试。`));
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  const safeName = name => name.trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/^[. ]+|[. ]+$/g, "") || "Glyph Cut";

  $("save").addEventListener("click", () => download(JSON.stringify({ format: "glyph-cut-v1", ...project }, null, 2),
    "application/json", `${safeName(project.fontName)}.glyphs.json`));
  $("export-template").addEventListener("click", () => {
    if (workspace) return workspace.exportTemplate();
    return download(JSON.stringify({
      format: "glyph-cut-v1", draft: project.template, template: project.template,
      disabledRegions: project.disabledRegions, mode: "template"
    }, null, 2), "application/json", `${safeName(project.fontName)}.template.json`);
  });
  $("import").addEventListener("click", () => $("open-file").click());
  $("open-file").addEventListener("change", async event => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    try {
      if (file.size > 8_000_000) throw new Error("文件超过 8 MB。");
      const imported = readProject(JSON.parse(await file.text()));
      resetPointer();
      change(() => {
        project = imported;
        group = groupFor(project.character);
      });
      notify("导入成功。");
    } catch (error) {
      notify(error instanceof SyntaxError ? "文件不是有效的 JSON。" : error.message);
    }
  });

  function glyphOutline(geometry, character) {
    return G.trace(geometry, new Set(project.glyphs[character]));
  }

  function downloadSvg(width, height, paths, filename) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
${paths}
</svg>\n`;
    download(svg, "image/svg+xml;charset=utf-8", filename);
  }

  $("export-svg").addEventListener("click", () => {
    const { width, height } = project.template;
    const outline = glyphOutline(getGeometry(project.template), project.character);
    const path = `  <path fill="#000" fill-rule="nonzero" d="${G.path(outline)}"/>`;
    downloadSvg(width, height, path, `Glyph-${project.character}.svg`);
  });
  function glyphSheet() {
    const characters = [...alphabet].filter(character => project.glyphs[character]?.length);
    if (!characters.length) return null;
    const { width, height } = project.template;
    const geometry = getGeometry(project.template);
    const columns = Math.min(10, characters.length);
    const rows = Math.ceil(characters.length / columns);
    const gap = Math.min(width, height) / 8;
    const glyphs = characters.map((character, index) => {
      const x = G.number(gap + (index % columns) * (width + gap));
      const y = G.number(gap + Math.floor(index / columns) * (height + gap));
      return { character, x, y, path: G.path(glyphOutline(geometry, character)) };
    });
    return { width: columns * (width + gap) + gap, height: rows * (height + gap) + gap, glyphs };
  }

  $("export-all-svg").addEventListener("click", () => {
    const sheet = glyphSheet();
    if (!sheet) return;
    const { width, height, glyphs } = sheet;
    const paths = glyphs.map(({ character, x, y, path }) =>
      `  <path id="glyph-${character}" transform="translate(${x} ${y})" fill="#000" fill-rule="nonzero" d="${path}"/>`);
    downloadSvg(width, height, paths.join("\n"), `${safeName(project.fontName)}.glyphs.svg`);
  });

  $("export-all-png").addEventListener("click", async () => {
    const button = $("export-all-png");
    exportingPng = true;
    button.disabled = true;
    const canvas = document.createElement("canvas");
    try {
      const sheet = glyphSheet();
      if (!sheet) return;
      const filename = `${safeName(project.fontName)}.glyphs.png`;
      const { width, height, glyphs } = sheet;
      const maxSide = 8192;
      const maxPixels = 32 * 1024 * 1024;
      const scale = Math.min(1, maxSide / Math.max(width, height), Math.sqrt(maxPixels / (width * height)));
      canvas.width = Math.min(maxSide, Math.ceil(width * scale));
      canvas.height = Math.min(maxSide, Math.ceil(height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("无法创建 PNG 画布。");
      context.fillStyle = "#000";
      for (const { x, y, path } of glyphs) {
        context.setTransform(scale, 0, 0, scale, x * scale, y * scale);
        context.fill(new Path2D(path), "nonzero");
      }
      const png = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
      if (!png) throw new Error("PNG 编码失败。");
      download(png, "image/png", filename);
      if (scale < 1) notify(`已按比例导出 ${canvas.width} × ${canvas.height} 像素的 PNG。`);
    } catch (error) {
      notify(error.message);
    } finally {
      canvas.width = canvas.height = 0;
      exportingPng = false;
      button.disabled = !Object.keys(project.glyphs).length;
    }
  });
  $("export-ttf").addEventListener("click", () => {
    try {
      const { width, height } = project.template;
      const geometry = getGeometry(project.template);
      const outlines = Object.keys(project.glyphs).sort().map(ch => [ch, glyphOutline(geometry, ch)]);
      // Preserve the saved font metrics when exporting older desktop projects.
      const font = TTF.build({ name: project.fontName, width, height, spacing: project.spacing,
        baseline: height * project.baseline / 100, outlines });
      download(font, "font/ttf", `${safeName(project.fontName)}.ttf`);
    } catch (error) {
      notify(error.message);
    }
  });

  document.addEventListener("keydown", event => {
    if (workspace && !workspace.editing()) return;
    if (event.target.closest?.("input, textarea, [contenteditable]")) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && (key === "z" || key === "y")) {
      event.preventDefault();
      if (key === "y" || event.shiftKey) travel(future, previous);
      else travel(previous, future);
      return;
    }
    if (event.ctrlKey || event.altKey || event.metaKey || project.mode !== "template") return;
    const shortcuts = { l: "line", q: "curve", v: "select", e: "erase", x: "exclude" };
    if (shortcuts[key]) activateTool(shortcuts[key]);
    if (key === "escape") {
      resetPointer();
      renderBoard();
      updateHelp();
    }
    if (key === "delete" && selectedStroke >= 0) eraseStroke(selectedStroke);
  });

  async function start() {
    document.body.inert = true;
    if (workspace) {
      await workspace.start({
        project: () => project, geometry: getGeometry, blankDraft, validateSpec, notify, download, safeName, simplifiedTemplate,
        prepareTemplate: () => { if (!ready()) generate(); },
        open: fields => {
          project = readProject({ ...newProject(), ...fields, format: "glyph-cut-v1" });
          group = groupFor(project.character);
          tool = "line";
          glyphTool = "regions";
          zoom = 1;
          previous.length = 0;
          future.length = 0;
          resetPointer();
          render();
          $("stage").scrollTo(0, 0);
        }
      });
    } else {
      try {
        const saved = localStorage.getItem(storageKey);
        if (saved) project = readProject(JSON.parse(saved));
      } catch {
        // The editor can start with a blank project if browser storage is unavailable.
      }
      group = groupFor(project.character);
      render();
    }
    document.body.inert = false;
  }

  start();
})();
