"use strict";

globalThis.GlyphTrueType = (() => {
  const unitsPerEm = 2048;
  const round = Math.round;
  const aligned = size => (size + 3) & ~3;

  class Writer {
    constructor(size) {
      this.bytes = new Uint8Array(size);
      this.view = new DataView(this.bytes.buffer);
      this.offset = 0;
    }
    u8(value) { this.view.setUint8(this.offset++, value); return this; }
    u16(value) { this.view.setUint16(this.offset, value); this.offset += 2; return this; }
    i16(value) { this.view.setInt16(this.offset, value); this.offset += 2; return this; }
    u32(value) { this.view.setUint32(this.offset, value); this.offset += 4; return this; }
    tag(name) { for (const ch of name) this.u8(ch.charCodeAt(0)); return this; }
    append(data) { this.bytes.set(data, this.offset); this.offset += data.length; return this; }
    bounds([x0, y0, x1, y1]) { return this.i16(x0).i16(y0).i16(x1).i16(y1); }
  }

  const glyphPoint = (x, y, on = true) => ({ x, y, on });

  function bounds(contours) {
    const points = contours.flat();
    return points.length ? points.reduce(([x0, y0, x1, y1], { x, y }) =>
      [Math.min(x, x0), Math.min(y, y0), Math.max(x, x1), Math.max(y, y1)],
    [Infinity, Infinity, -Infinity, -Infinity]) : [0, 0, 0, 0];
  }

  function makeGlyph(contours, advance) {
    const box = bounds(contours);
    const points = contours.flat();
    if (!points.length) return { bytes: new Uint8Array(), box, points: 0, contours: 0, advance };
    if (points.length > 65535 || contours.length > 32767) {
      throw new Error("字形轮廓过于复杂，超出 TrueType 单字的点数或轮廓数限制。");
    }
    const table = new Writer(12 + contours.length * 2 + points.length * 5);
    table.i16(contours.length).bounds(box);
    let lastIndex = -1;
    for (const contour of contours) {
      lastIndex += contour.length;
      table.u16(lastIndex);
    }
    table.u16(0);
    for (const p of points) table.u8(p.on ? 1 : 0);
    for (const key of ["x", "y"]) {
      let previous = 0;
      for (const p of points) {
        table.i16(p[key] - previous);
        previous = p[key];
      }
    }
    return { bytes: table.bytes, box, points: points.length, contours: contours.length, advance };
  }

  function cmaps(codes) {
    const segments = codes.map((code, i) => [code, i + 1 - code]).concat([[0xffff, 1]]);
    const count = segments.length;
    const exponent = Math.floor(Math.log2(count));
    const searchRange = 2 * 2 ** exponent;
    const formatSize = 16 + 8 * count;
    const out = new Writer(20 + formatSize);
    out.u16(0).u16(2).u16(0).u16(3).u32(20).u16(3).u16(1).u32(20);
    out.u16(4).u16(formatSize).u16(0).u16(count * 2).u16(searchRange).u16(exponent).u16(count * 2 - searchRange);
    for (const [code] of segments) out.u16(code);
    out.u16(0);
    for (const [code] of segments) out.u16(code);
    for (const [, delta] of segments) out.u16(delta);
    for (const _ of segments) out.u16(0);
    return out.bytes;
  }

  function names(family) {
    let hash = 0;
    for (const ch of family) hash = (Math.imul(31, hash) + ch.codePointAt(0)) >>> 0;
    const postscript = family.replace(/[^A-Za-z0-9-]/g, "").slice(0, 45) || `GlyphCut-${hash.toString(36)}`;
    const pairs = [[1, family], [2, "Regular"], [3, `${postscript}-Regular;1.000`],
      [4, `${family} Regular`], [5, "Version 1.000"], [6, `${postscript}-Regular`]];
    const headerLength = 6 + pairs.length * 12;
    const stringLength = pairs.reduce((sum, [, value]) => sum + value.length * 2, 0);
    const out = new Writer(headerLength + stringLength);
    out.u16(0).u16(pairs.length).u16(headerLength);
    let offset = 0;
    for (const [id, value] of pairs) {
      out.u16(3).u16(1).u16(0x0409).u16(id).u16(value.length * 2).u16(offset);
      offset += value.length * 2;
    }
    for (const [, value] of pairs) {
      for (let i = 0; i < value.length; i++) out.u16(value.charCodeAt(i));
    }
    return out.bytes;
  }

  function checksum(bytes) {
    let sum = 0;
    for (let i = 0; i < bytes.length; i += 4) {
      const word = (bytes[i] << 24) | ((bytes[i + 1] ?? 0) << 16) | ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0);
      sum = (sum + word) >>> 0;
    }
    return sum;
  }

  function assemble(tables) {
    const entries = Object.entries(tables).sort(([a], [b]) => a < b ? -1 : 1);
    const count = entries.length;
    const exponent = Math.floor(Math.log2(count));
    const searchRange = 16 * 2 ** exponent;
    let offset = 12 + 16 * count;
    let headOffset;
    const out = new Writer(offset + entries.reduce((sum, [, data]) => sum + aligned(data.length), 0));
    out.u32(0x00010000).u16(count).u16(searchRange).u16(exponent).u16(count * 16 - searchRange);
    for (const [name, data] of entries) {
      if (name === "head") headOffset = offset;
      out.tag(name).u32(checksum(data)).u32(offset).u32(data.length);
      out.bytes.set(data, offset);
      offset += aligned(data.length);
    }
    out.view.setUint32(headOffset + 8, (0xb1b0afba - checksum(out.bytes)) >>> 0);
    return out.bytes;
  }

  function build({ name, width, height, baseline, spacing, outlines }) {
    const scale = Math.min(1680 / height, 9000 / (width + spacing * 2));
    const ascent = Math.max(1, round(baseline * scale));
    const descent = Math.min(0, round((baseline - height) * scale));
    const gap = round(unitsPerEm * 0.12);
    const advance = Math.max(1, round((width + spacing * 2) * scale));
    const convert = (p, on) => glyphPoint(round((p[0] + spacing) * scale), round((baseline - p[1]) * scale), on);
    const boxLoop = (left, bottom, right, top) =>
      [glyphPoint(left, bottom), glyphPoint(left, top), glyphPoint(right, top), glyphPoint(right, bottom)];
    const missing = [boxLoop(76, 0, 720, 1020), boxLoop(155, 82, 641, 938).reverse()];
    const glyphs = [makeGlyph(missing, 800), makeGlyph([], Math.max(advance / 2, 128) | 0)];
    const codes = [32];
    for (const [ch, loops] of outlines) {
      if (!loops.length) continue;
      const contours = loops.map(loop => {
        const points = [convert(loop[0].a, true)];
        loop.forEach((edge, i) => {
          if (edge.c) points.push(convert(edge.c, false));
          if (i + 1 < loop.length) points.push(convert(edge.b, true));
        });
        return points;
      });
      codes.push(ch.charCodeAt(0));
      glyphs.push(makeGlyph(contours, advance));
    }

    const sizes = glyphs.map(glyph => aligned(glyph.bytes.length));
    const glyf = new Uint8Array(sizes.reduce((total, size) => total + size, 0));
    const loca = new Writer((glyphs.length + 1) * 4);
    const hmtx = new Writer(glyphs.length * 4);
    let glyfOffset = 0;
    const totalBounds = [Infinity, Infinity, -Infinity, -Infinity];
    glyphs.forEach((glyph, i) => {
      loca.u32(glyfOffset);
      glyf.set(glyph.bytes, glyfOffset);
      glyfOffset += sizes[i];
      hmtx.u16(glyph.advance).i16(glyph.box[0]);
      if (glyph.points) glyph.box.forEach((v, j) => {
        totalBounds[j] = j < 2 ? Math.min(totalBounds[j], v) : Math.max(totalBounds[j], v);
      });
    });
    loca.u32(glyfOffset);
    const head = new Writer(54);
    const timestamp = Math.floor(Date.now() / 1000) + 2082844800;
    head.u32(0x00010000).u32(0x00010000).u32(0).u32(0x5f0f3cf5).u16(3).u16(unitsPerEm);
    head.u32(0).u32(timestamp).u32(0).u32(timestamp).bounds(totalBounds);
    head.u16(0).u16(8).i16(2).i16(1).i16(0);
    const hhea = new Writer(36);
    hhea.u32(0x00010000).i16(ascent).i16(descent).i16(gap).u16(Math.max(...glyphs.map(g => g.advance)));
    const visible = glyphs.filter(g => g.points);
    hhea.i16(Math.min(...visible.map(g => g.box[0]))).i16(Math.min(...visible.map(g => g.advance - g.box[2])));
    hhea.i16(totalBounds[2]).i16(1).i16(0).i16(0);
    for (let i = 0; i < 5; i++) hhea.i16(0);
    hhea.u16(glyphs.length);
    const maxp = new Writer(32);
    maxp.u32(0x00010000).u16(glyphs.length).u16(Math.max(...glyphs.map(g => g.points)));
    maxp.u16(Math.max(...glyphs.map(g => g.contours))).u16(0).u16(0).u16(1);
    const os2 = new Writer(96);
    os2.u16(4).i16(round(glyphs.slice(1).reduce((sum, g) => sum + g.advance, 0) / (glyphs.length - 1)));
    os2.u16(400).u16(5).u16(0);
    for (const value of [1331, 1433, 0, 286, 1331, 1433, 0, 983, 102, 530, 0]) os2.i16(value);
    for (const value of [2, 0, 5, 0, 0, 0, 0, 0, 0, 0]) os2.u8(value);
    os2.u32(1).u32(0).u32(0).u32(0).tag("NONE").u16(0x00c0).u16(codes[0]).u16(codes.at(-1));
    os2.i16(ascent).i16(descent).i16(gap).u16(Math.max(ascent, totalBounds[3])).u16(Math.max(-descent, -totalBounds[1]));
    os2.u32(1).u32(0).i16(round(ascent * 0.7)).i16(ascent).u16(0).u16(32).u16(0);
    const post = new Writer(32);
    post.u32(0x00030000).u32(0).i16(-155).i16(90).u32(0);
    return assemble({ "OS/2": os2.bytes, cmap: cmaps(codes), glyf, head: head.bytes, hhea: hhea.bytes,
      hmtx: hmtx.bytes, loca: loca.bytes, maxp: maxp.bytes, name: names(name), post: post.bytes });
  }

  return { build };
})();
