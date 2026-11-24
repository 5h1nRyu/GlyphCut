"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { mkdir, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { Readable } = require("node:stream");
const { test } = require("node:test");
const { createProjects } = require("../projects.cjs");
const { createUpdater, createUpdateRequest, fetchArchive, findUpdate } = require("../updates.cjs");
require("../../docs/geometry.js");
const geometry = globalThis.GlyphGeometry;

async function temporary(t) {
  const folder = await mkdtemp(join(tmpdir(), "glyphcut-test-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return folder;
}

test("deleting a template preserves every linked font and its editable snapshot", async t => {
  const root = await temporary(t);
  const projects = createProjects(root);
  const create = name => projects.saveTemplate({
    name, spec: { width: 480, height: 600, stepX: 60, stepY: 60, strokes: [] }, disabledRegions: []
  });
  const template = await create("Linked");
  const other = await create("Other");
  const first = await projects.createFont(template.id);
  const second = await projects.createFont(template.id);
  const saved = (await projects.saveFont(first.id, { ...first, glyphs: { A: [0] } })).font;
  await projects.saveTemplate({ ...template, spec: { ...template.spec, stepX: 30 } });
  await assert.rejects(projects.saveFont(first.id, saved), /模板已更改/);

  await projects.deleteTemplate(template.id);
  const reopened = createProjects(root);
  let data = await reopened.load();
  assert.deepEqual(data.templates, [other]);
  assert.equal(data.fonts.length, 2);
  assert.deepEqual(data.fonts.find(font => font.id === first.id), saved);
  assert.deepEqual(data.fonts.find(font => font.id === second.id).template, template);

  const edited = await reopened.saveFont(first.id, { ...saved, glyphs: { A: [0], B: [0] } });
  assert.deepEqual(edited.font.template, template);
  assert.deepEqual(edited.font.glyphs, { A: [0], B: [0] });
  await reopened.deleteFont(first.id);
  data = await reopened.load();
  assert.deepEqual(data.fonts, [second]);
  assert.deepEqual(data.templates, [other]);
  await assert.rejects(reopened.deleteFont("../example"), /项目标识无效/);
});

test("deleting a template with its linked fonts leaves unrelated projects intact", async t => {
  const projects = createProjects(await temporary(t));
  const spec = { width: 480, height: 600, stepX: 60, stepY: 60, strokes: [] };
  const template = await projects.saveTemplate({ name: "Template", spec, disabledRegions: [] });
  const other = await projects.saveTemplate({ name: "Other template", spec, disabledRegions: [] });
  await projects.createFont(template.id);
  await projects.createFont(template.id);
  const unrelated = await projects.createFont(other.id);
  await projects.saveTemplate({ ...template, spec: { ...spec, stepX: 30 } });

  await projects.deleteTemplate(template.id, true);
  assert.deepEqual(await projects.load(), { templates: [other], fonts: [unrelated], warnings: [] });
});

test("font autosaves preserve the draft across reopening until explicit confirmation", async t => {
  const root = await temporary(t);
  const projects = createProjects(root);
  const spec = { width: 480, height: 600, stepX: 60, stepY: 60, strokes: [] };
  const template = await projects.saveTemplate({ name: "Grid", spec, disabledRegions: [] });
  const font = await projects.createFont(template.id);
  assert.equal(font.unconfirmed, true);
  await projects.saveFont(font.id, { ...font, sample: "AB", autoSample: false, unconfirmed: false });

  const reopened = createProjects(root);
  const [draft] = (await reopened.load()).fonts;
  assert.equal(draft.unconfirmed, true);
  assert.equal(draft.sample, "AB");
  const confirmed = await reopened.confirmFont(font.id);
  assert.equal(confirmed.unconfirmed, undefined);
  const { font: saved } = await reopened.saveFont(font.id, { ...draft, glyphs: { A: [0] } });
  assert.equal(saved.unconfirmed, undefined);
  assert.deepEqual(saved.glyphs, { A: [0] });
});

test("new fonts and the legacy default use automatic samples while custom text survives reload", async t => {
  const root = await temporary(t);
  const projects = createProjects(root);
  const spec = { width: 480, height: 600, stepX: 60, stepY: 60, strokes: [] };
  const template = await projects.saveTemplate({ name: "Grid", spec, disabledRegions: [] });
  const font = await projects.createFont(template.id);
  assert.equal(font.autoSample, true);
  assert.equal(font.sample, "");

  const file = join(root, "fonts", font.id + ".json");
  const legacy = { ...font, sample: "ABC 123" };
  delete legacy.autoSample;
  await writeFile(file, JSON.stringify(legacy));
  assert.equal((await projects.load()).fonts[0].autoSample, true);
  await writeFile(file, JSON.stringify({ ...legacy, sample: "A CB" }));
  assert.equal((await projects.load()).fonts[0].autoSample, false);

  await projects.saveFont(font.id, { ...legacy, autoSample: false });
  const [custom] = (await createProjects(root).load()).fonts;
  assert.equal(custom.autoSample, false);
  assert.equal(custom.sample, "ABC 123");
});

test("template and font menu order is saved separately and survives project changes", async t => {
  const root = await temporary(t);
  const projects = createProjects(root);
  const spec = { width: 480, height: 600, stepX: 60, stepY: 60, strokes: [] };
  const first = await projects.saveTemplate({ name: "Template A", spec, disabledRegions: [] });
  const second = await projects.saveTemplate({ name: "Template B", spec, disabledRegions: [] });
  const firstFont = await projects.createFont(first.id, { name: "Font A" });
  const secondFont = await projects.createFont(second.id, { name: "Font B" });
  await projects.reorderProjects("templates", [second.id, first.id]);
  await assert.rejects(projects.reorderProjects("templates", [second.id, second.id]), /项目排序/);
  await assert.rejects(projects.reorderProjects("fonts", [first.id]), /项目已变更/);
  const ids = records => records.map(record => record.id);
  const initial = await createProjects(root).load();
  assert.deepEqual(ids(initial.templates), [second.id, first.id]);
  assert.deepEqual(ids(initial.fonts), [firstFont.id, secondFont.id]);
  await projects.reorderProjects("fonts", [secondFont.id, firstFont.id]);
  await projects.deleteTemplate(second.id);
  const added = await projects.saveTemplate({ name: "Template 0", spec, disabledRegions: [] });
  const updated = await createProjects(root).load();
  assert.deepEqual(ids(updated.templates), [first.id, added.id]);
  assert.deepEqual(ids(updated.fonts), [secondFont.id, firstFont.id]);
});

test("font creation and scope edits enforce the active groups while keeping hidden glyphs", async t => {
  const root = await temporary(t);
  const projects = createProjects(root);
  const spec = { width: 480, height: 600, stepX: 60, stepY: 60, strokes: [] };
  const template = await projects.saveTemplate({ name: "Grid", spec, disabledRegions: [] });
  await assert.rejects(projects.createFont(template.id, { characterGroups: [] }), /字形范围/);
  await assert.rejects(projects.createFont(template.id, { characterGroups: ["invalid"] }), /字形范围/);
  const font = await projects.createFont(template.id, { name: "Digits", characterGroups: ["digits"] });
  assert.equal(font.name, "Digits");
  assert.equal(font.character, "0");
  await assert.rejects(projects.saveFont(font.id, { ...font, glyphs: { A: [0] }, characterGroups: ["upper"] }), /字体数据/);
  await projects.saveFont(font.id, { ...font, glyphs: { "9": [0] }, character: "9" });
  const [saved] = (await createProjects(root).load()).fonts;
  assert.deepEqual(saved.characterGroups, ["digits"]);
  assert.equal(saved.character, "9");

  const expanded = await projects.saveFont(saved.id, { ...saved, characterGroups: ["digits", "upper"],
    glyphs: { ...saved.glyphs, A: [0] }, character: "A" });
  assert.deepEqual(expanded.font.characterGroups, ["upper", "digits"]);
  await assert.rejects(projects.saveFont(saved.id, { ...expanded.font, characterGroups: [] }), /字形范围/);
  await projects.saveFont(saved.id, { ...expanded.font, characterGroups: ["digits"], character: "9" });
  const narrowed = (await createProjects(root).load()).fonts.find(record => record.id === saved.id);
  assert.deepEqual(narrowed.characterGroups, ["digits"]);
  assert.deepEqual(narrowed.glyphs, { "9": [0], A: [0] });
  const restored = await projects.saveFont(saved.id, { ...narrowed, characterGroups: ["upper"], character: "A" });
  assert.deepEqual(restored.font.glyphs.A, [0]);

  const legacy = await projects.createFont(template.id);
  delete legacy.characterGroups;
  await writeFile(join(root, "fonts", legacy.id + ".json"), JSON.stringify(legacy));
  assert.deepEqual((await projects.load()).fonts.find(record => record.id === legacy.id).characterGroups,
    ["upper", "lower", "digits"]);
});

test("copying a project creates an independent record and preserves the font's scope and template", async t => {
  const projects = createProjects(await temporary(t));
  const spec = { width: 480, height: 600, stepX: 60, stepY: 60, strokes: [] };
  const template = await projects.saveTemplate({ name: "Grid", spec, disabledRegions: [] });
  const templateCopy = await projects.copyProject("template", template.id, "Grid（副本）");
  assert.notEqual(templateCopy.id, template.id);
  assert.equal(templateCopy.name, "Grid（副本）");
  assert.deepEqual(templateCopy.spec, spec);

  const font = await projects.createFont(template.id, { name: "Digits", characterGroups: ["digits"] });
  await projects.saveFont(font.id, { ...font, glyphs: { "0": [0] }, spacing: 30 });
  const [copy, second] = await Promise.all([
    projects.copyProject("font", font.id, "Digits（副本）"),
    projects.copyProject("font", font.id, "Digits（副本 2）")
  ]);
  assert.notEqual(copy.id, font.id);
  assert.equal(copy.name, "Digits（副本）");
  assert.equal(second.name, "Digits（副本 2）");
  assert.deepEqual(copy.template, template);
  assert.deepEqual(copy.characterGroups, ["digits"]);
  assert.deepEqual(copy.glyphs, { "0": [0] });
  assert.equal(copy.spacing, 30);
  assert.equal(copy.unconfirmed, undefined);
  await projects.deleteFont(font.id);
  assert.equal((await projects.load()).fonts.length, 2);
});

test("new project names are unique across templates and fonts, including simultaneous copies", async t => {
  const projects = createProjects(await temporary(t));
  const draft = { name: "Grid", spec: { width: 480, height: 600, stepX: 60, stepY: 60, strokes: [] }, disabledRegions: [] };
  const template = await projects.saveTemplate(draft);
  await assert.rejects(projects.createFont(template.id, { name: "  GRID  " }), /同名/);
  const font = await projects.createFont(template.id, { name: "Digits" });
  await assert.rejects(projects.saveTemplate({ ...draft, name: "digits" }), /同名/);
  await assert.rejects(projects.saveTemplate({ ...template, name: "Digits" }), /同名/);
  await assert.rejects(projects.saveFont(font.id, { ...font, name: "Grid" }), /同名/);
  const copies = await Promise.allSettled([
    projects.copyProject("template", template.id, "副本"),
    projects.copyProject("font", font.id, "副本")
  ]);
  assert.equal(copies.filter(result => result.status === "fulfilled").length, 1);
  assert.match(copies.find(result => result.status === "rejected").reason.message, /同名/);
});

test("simplifying the linked template preserves other font snapshots and a named fork leaves the source intact", async t => {
  const root = await temporary(t);
  const projects = createProjects(root);
  const spec = { width: 480, height: 600, stepX: 60, stepY: 60, strokes: [{ a: [240, 0], b: [240, 600] }] };
  const template = await projects.saveTemplate({ name: "Grid", spec, disabledRegions: [] });
  const first = await projects.createFont(template.id, { name: "First" });
  const second = await projects.createFont(template.id, { name: "Second" });
  const simplified = { spec: { ...spec, strokes: [] }, disabledRegions: [], glyphs: { A: [0] } };
  await assert.rejects(projects.simplifyFont(first.id, { ...simplified, destination: "independent", name: "Second" }), /同名/);
  const fork = await projects.simplifyFont(first.id, { ...simplified, destination: "independent", name: "Separate grid" });
  assert.notEqual(fork.template.id, template.id);
  assert.deepEqual(fork.font.glyphs, { A: [0] });
  assert.deepEqual((await projects.load()).templates.find(record => record.id === template.id), template);

  const third = await projects.createFont(template.id, { name: "Third" });
  const blockedWrite = join(root, "fonts", third.id + ".json.tmp");
  await mkdir(blockedWrite);
  await assert.rejects(projects.simplifyFont(third.id, { ...simplified, destination: "original" }));
  assert.deepEqual((await projects.load()).templates.find(record => record.id === template.id), template);
  await rm(blockedWrite, { recursive: true });
  const inPlace = await projects.simplifyFont(third.id, { ...simplified, destination: "original" });
  assert.equal(inPlace.template.id, template.id);
  assert.deepEqual(inPlace.template.spec, simplified.spec);
  assert.deepEqual(inPlace.font.template, inPlace.template);
  const reloaded = await createProjects(root).load();
  assert.deepEqual(reloaded.fonts.find(record => record.id === second.id), second);
  await assert.rejects(projects.saveFont(second.id, second), /模板已更改/);
  await assert.rejects(projects.keepTemplate(second.id, "First"), /同名/);
  const kept = await projects.keepTemplate(second.id, "Kept original");
  assert.equal(kept.template.name, "Kept original");
  assert.deepEqual(kept.template.spec, spec);
  assert.deepEqual(kept.font.template, kept.template);
  await projects.deleteTemplate(template.id);
  await assert.rejects(projects.simplifyFont(third.id, { ...simplified, destination: "original" }), /原模板已删除/);
});

test("font import gives the font and snapshot new IDs and optionally saves the linked template", async t => {
  const projects = createProjects(await temporary(t));
  const template = await projects.saveTemplate({
    name: "Source template", spec: { width: 120, height: 120, stepX: 30, stepY: 30, strokes: [] }, disabledRegions: []
  });
  const source = await projects.createFont(template.id, { name: "Source font", characterGroups: ["digits"] });
  const { font } = await projects.saveFont(source.id, { ...source, glyphs: { 0: [0] } });
  await assert.rejects(projects.importFont(font), /同名/);
  await assert.rejects(projects.importFont({ ...font, name: "Imported" }, "Source template"), /同名/);
  await assert.rejects(projects.importFont({ ...font, name: "Imported" }, " imported "), /名称不能相同/);
  assert.deepEqual((await projects.load()).templates, [template]);
  assert.equal((await projects.load()).fonts.length, 1);

  const embedded = await projects.importFont({ ...font, name: "Embedded" });
  assert.notEqual(embedded.id, font.id);
  assert.notEqual(embedded.template.id, template.id);
  assert.equal(embedded.unconfirmed, undefined);
  assert.deepEqual(embedded.glyphs, font.glyphs);
  assert.deepEqual(embedded.characterGroups, font.characterGroups);
  assert.deepEqual((await projects.load()).templates, [template]);

  const linked = await projects.importFont({ ...font, name: "Linked import" }, "Imported template");
  const saved = (await projects.load()).templates.find(record => record.name === "Imported template");
  assert.deepEqual(linked.template, saved);
  assert.notEqual(saved.id, template.id);
  assert.deepEqual(saved.spec, template.spec);
});

test("point fill ignores template edges unless the selected lines cut across the frame or close a loop", () => {
  const strokes = [30, 60, 90].flatMap(value => [
    { a: [value, 0], b: [value, 120] }, { a: [0, value], b: [120, value] }
  ]);
  const mesh = geometry.arrange({ width: 120, height: 120, strokes });
  const partitions = (...points) => {
    const nodes = points.map(([x, y]) => mesh.boundaryPoints.find(({ p }) => p[0] === x && p[1] === y));
    const cuts = [];
    for (let i = 1; i < nodes.length; i++) {
      const [connection] = geometry.pointConnections(mesh, nodes[i - 1], nodes[i], new Set(cuts));
      assert.ok(connection);
      cuts.push(...connection);
    }
    return geometry.partitionByPath(mesh, cuts);
  };
  assert.deepEqual(partitions([60, 30], [60, 90]), [mesh.faces.map(({ id }) => id)]);
  assert.deepEqual(partitions([60, 0], [60, 120]).map(ids => ids.length), [8, 8]);
  assert.deepEqual(partitions([60, 0], [60, 120], [90, 120], [90, 0]).map(ids => ids.length).sort(), [4, 4, 8]);
  const closed = partitions([30, 30], [90, 30], [90, 90], [30, 90], [30, 30]);
  assert.deepEqual(closed.map(ids => ids.length).sort((a, b) => a - b), [4, 12]);
  const containing = point => closed.find(ids => ids.includes(geometry.regionAt(mesh, point)));
  assert.equal(containing([15, 15]), containing([105, 105]));
  assert.notEqual(containing([15, 15]), containing([45, 45]));
});

test("switching between straight and curved point connections changes which faces form a partition", () => {
  const a = [60, 0];
  const b = [60, 120];
  const mesh = geometry.arrange({ width: 120, height: 120, strokes: [{ a, b }, { a, b, c: [100, 60] }] });
  const from = mesh.boundaryPoints.find(node => node.p[0] === a[0] && node.p[1] === a[1]);
  const to = mesh.boundaryPoints.find(node => node.p[0] === b[0] && node.p[1] === b[1]);
  const [straight, curved] = geometry.pointConnections(mesh, from, to, new Set());
  assert.equal(straight[0].c, undefined);
  assert.ok(curved[0].c);
  const left = geometry.regionAt(mesh, [30, 60]);
  const between = geometry.regionAt(mesh, [70, 60]);
  assert.ok(!geometry.partitionByPath(mesh, straight).find(ids => ids.includes(left)).includes(between));
  assert.ok(geometry.partitionByPath(mesh, curved).find(ids => ids.includes(left)).includes(between));
});

test("only a newer stable release with a verifiable Windows archive is eligible", () => {
  const asset = { name: "GlyphCut-Windows-x64.zip", state: "uploaded", size: 100, digest: "sha256:" + "a".repeat(64) };
  const release = { tag_name: "v1.10.0", assets: [asset] };
  assert.equal(findUpdate(release, "1.9.9").version, "1.10.0");
  assert.equal(findUpdate(release, "1.10.0"), null);
  assert.equal(findUpdate(release, "2.0.0"), null);
  assert.equal(findUpdate({ ...release, prerelease: true }, "1.9.9"), null);
  assert.equal(findUpdate({ ...release, tag_name: "v1.10.0-beta.1" }, "1.9.9"), null);
  assert.throws(() => findUpdate({ ...release, assets: [{ ...asset, digest: "" }] }, "1.9.9"), /缺少可验证/);
});

test("update downloads verify size and digest and refuse redirects outside GitHub", async t => {
  const directory = await temporary(t);
  const payload = Buffer.from("verified Windows archive");
  const release = {
    size: payload.length, digest: createHash("sha256").update(payload).digest("hex"),
    url: "https://github.com/5h1nRyu/GlyphCut/releases/download/v1.2.0/GlyphCut-Windows-x64.zip"
  };
  const signal = new AbortController().signal;
  const request = async url => url.hostname === "github.com"
    ? Response.redirect("https://release-assets.githubusercontent.com/example")
    : new Response(payload);
  const target = join(directory, "valid.zip");
  await fetchArchive(request, release, target, signal, () => {});
  assert.deepEqual(await readFile(target), payload);
  await assert.rejects(fetchArchive(request, { ...release, digest: "0".repeat(64) }, join(directory, "bad.zip"),
    signal, () => {}), /校验失败/);
  await assert.rejects(fetchArchive(request, { ...release, size: 2 }, join(directory, "long.zip"),
    signal, () => {}), /大小与发布信息不一致/);
  await assert.rejects(fetchArchive(async () => Response.redirect("https://example.com/archive.zip"), release,
    join(directory, "external.zip"), signal, () => {}), /下载地址无效/);
});


test("Electron transport returns each redirect to the updater and streams the verified archive", async t => {
  const directory = await temporary(t);
  const start = "https://github.com/5h1nRyu/GlyphCut/releases/download/v1.1.2/GlyphCut-Windows-x64.zip";
  const target = "https://release-assets.githubusercontent.com/test";
  const requests = [];
  const payload = Buffer.from("release archive fixture");
  let canceledRedirect = false;
  const request = createUpdateRequest({
    request(options) {
      const connection = new EventEmitter();
      requests.push(options);
      connection.abort = () => { canceledRedirect = true; };
      connection.end = () => {
        if (options.url === start) connection.emit("redirect", 302, "GET", target);
        else connection.emit("response", Object.assign(Readable.from([payload]), { statusCode: 200 }));
      };
      return connection;
    }
  });
  const archive = join(directory, "update.zip");
  await fetchArchive(request, {
    url: start, size: payload.length, digest: createHash("sha256").update(payload).digest("hex")
  }, archive, AbortSignal.timeout(1000), () => {});
  assert.ok(canceledRedirect);
  assert.deepEqual(requests.map(options => options.url), [start, target]);
  assert.ok(requests.every(options =>
    options.redirect === "manual" && options.cache === "no-store" && options.credentials === "omit"));
  assert.deepEqual(await readFile(archive), payload);
});


test("the release manifest supplies updates when GitHub's API is blocked", async () => {
  const requests = [];
  const manifest = { tag_name: "v1.1.9", body: "版本说明", assets: [{
    name: "GlyphCut-Windows-x64.zip", state: "uploaded", size: 100, digest: "sha256:" + "a".repeat(64)
  }] };
  const asset = "https://release-assets.githubusercontent.com/test";
  const updater = createUpdater({
    version: "1.1.8", executable: "GlyphCut.exe", notify() {}, supported: true,
    request: async target => {
      const url = new URL(target);
      requests.push(url.href);
      if (url.hostname === "api.github.com") return new Response(null, { status: 403 });
      if (url.href === asset) return Response.json(manifest);
      return Response.redirect(asset);
    }
  });
  assert.deepEqual(await updater.check(), {
    phase: "available", currentVersion: "1.1.8", version: "1.1.9", notes: "版本说明"
  });
  assert.deepEqual(requests, [
    "https://github.com/5h1nRyu/GlyphCut/releases/latest/download/GlyphCut-update.json", asset
  ]);
});

test("missing or invalid manifests fall back to GitHub's REST API", async () => {
  const api = "https://api.github.com/repos/5h1nRyu/GlyphCut/releases/latest";
  const data = { tag_name: "v1.1.9", assets: [{
    name: "GlyphCut-Windows-x64.zip", state: "uploaded", size: 100, digest: "sha256:" + "a".repeat(64)
  }] };
  for (const manifest of [
    () => new Response(null, { status: 404 }),
    () => new Response("<html>proxy page</html>"),
    () => Response.json({ tag_name: "v1.1.9", assets: [] }),
    () => new Response("x".repeat(33 * 1024)),
    () => Response.redirect("https://example.com/untrusted")
  ]) {
    const requests = [];
    const updater = createUpdater({
      version: "1.1.8", executable: "GlyphCut.exe", notify() {}, supported: true,
      request: async target => {
        const url = new URL(target);
        requests.push(url.href);
        assert.ok(["github.com", "api.github.com"].includes(url.hostname));
        return url.href === api ? Response.json(data) : manifest();
      }
    });
    assert.equal((await updater.check()).phase, "available");
    assert.equal(requests.length, 2);
    assert.equal(requests[1], api);
  }
});

test("update checking reports proxy errors, timeouts and HTTP status codes", async () => {
  const check = request => createUpdater({
    version: "1.1.3", executable: "GlyphCut.exe", notify() {}, request, supported: true
  }).check();
  for (const [request, detail] of [
    [async () => new Response(null, { status: 403 }), "HTTP 403"],
    [async () => { throw new DOMException("The operation timed out.", "TimeoutError"); }, "连接超时"],
    [async () => { throw new Error("net::ERR_PROXY_CONNECTION_FAILED"); }, "ERR_PROXY_CONNECTION_FAILED"]
  ]) {
    const result = await check(request);
    assert.equal(result.phase, "checkFailed");
    assert.ok(result.message.includes(detail));
  }
});
