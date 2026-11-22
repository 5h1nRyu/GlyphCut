"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");
const { createProjects } = require("../projects.cjs");
const { fetchArchive, findUpdate } = require("../updates.cjs");

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
