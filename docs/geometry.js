"use strict";

globalThis.GlyphGeometry = (() => {
  const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
  const mul = (a, n) => [a[0] * n, a[1] * n];
  const mix = (a, b, t) => add(a, mul(sub(b, a), t));
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
  const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
  const length = a => Math.hypot(...a);
  const distance = (a, b) => length(sub(a, b));
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const line = (a, b, source) => ({ a, b, source });
  const evalPolynomial = (p, t) => p.reduceRight((value, coefficient) => value * t + coefficient, 0);
  const paramEps = 2e-10;
  const interpolate = (a, b, t) => a + (b - a) * t;

  function roots(coefficients) {
    const norm = Math.max(...coefficients.map(Math.abs));
    if (!norm) return [];
    const p = coefficients.map(value => value / norm);
    while (p.length > 1 && Math.abs(p.at(-1)) < 2e-15) p.pop();
    if (p.length === 1) return [];
    if (p.length === 2) {
      const t = -p[0] / p[1];
      return t >= -paramEps && t <= 1 + paramEps ? [clamp(t, 0, 1)] : [];
    }
    const cuts = [0, ...roots(p.slice(1).map((v, i) => v * (i + 1))).filter(t => t > 0 && t < 1), 1];
    const values = cuts.map(t => evalPolynomial(p, t));
    const result = cuts.filter((_, i) => Math.abs(values[i]) < 1e-13);
    for (let i = 1; i < cuts.length; i++) {
      let lo = cuts[i - 1];
      let hi = cuts[i];
      const loValue = values[i - 1];
      if (loValue * values[i] >= 0) continue;
      for (let j = 0; j < 52; j++) {
        const mid = (lo + hi) / 2;
        if ((evalPolynomial(p, mid) > 0) === (loValue > 0)) lo = mid;
        else hi = mid;
      }
      result.push((lo + hi) / 2);
    }
    return result.sort((a, b) => a - b).filter((t, i, list) => !i || t - list[i - 1] > paramEps);
  }

  function point(edge, t) {
    if (!edge.c) return mix(edge.a, edge.b, t);
    return mix(mix(edge.a, edge.c, t), mix(edge.c, edge.b, t), t);
  }

  function power(edge) {
    return edge.c
      ? [mul(sub(edge.c, edge.a), 2), add(sub(edge.a, edge.c), sub(edge.b, edge.c))]
      : [sub(edge.b, edge.a), [0, 0]];
  }

  function slice(edge, t0, t1) {
    const a = point(edge, t0);
    const b = point(edge, t1);
    if (!edge.c) return line(a, b, edge.source);
    const halfDerivative = mix(sub(edge.c, edge.a), sub(edge.b, edge.c), t0);
    return { a, b, c: add(a, mul(halfDerivative, t1 - t0)), source: edge.source };
  }

  function strokeParts(stroke) {
    if (!stroke.ranges) return [stroke];
    return stroke.ranges.map(range => ({ ...slice(stroke, ...range), range }));
  }

  function sourceParameter(edge, t) {
    if (edge.linearized && t > 0 && t < 1) {
      // A collinear quadratic is arranged as a straight segment, but its parameter is still quadratic.
      const direction = sub(edge.b, edge.a);
      const control = dot(sub(edge.linearized, edge.a), direction) / dot(direction, direction);
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 45; i++) {
        const mid = (lo + hi) / 2;
        if (2 * (1 - mid) * mid * control + mid * mid < t) lo = mid;
        else hi = mid;
      }
      t = (lo + hi) / 2;
    }
    return edge.range ? interpolate(...edge.range, t) : t;
  }

  function basicEdges(edge, eps) {
    if (!edge.c) return [edge];
    const [d, q] = power(edge);
    const axisVector = [sub(edge.b, edge.a), sub(edge.c, edge.a), sub(edge.b, edge.c)]
      .sort((a, b) => length(b) - length(a))[0];
    if (Math.abs(cross(d, q)) > eps * 2 * length(axisVector)) return [edge];
    const axis = Math.abs(axisVector[0]) >= Math.abs(axisVector[1]) ? 0 : 1;
    const kink = -d[axis] / (2 * q[axis]);
    const cuts = kink > 0 && kink < 1 ? [0, kink, 1] : [0, 1];
    return cuts.slice(1).map((t, i) => {
      const part = slice(edge, cuts[i], t);
      return { ...line(part.a, part.b, edge.source), linearized: part.c,
        range: [sourceParameter(edge, cuts[i]), sourceParameter(edge, t)] };
    });
  }

  function activeRanges(edge, stroke) {
    if (!stroke?.ranges) return [[0, 1]];
    const [start, end] = edge.range ?? [0, 1];
    const direction = sub(edge.b, edge.a);
    const toLocal = t => edge.linearized
      ? clamp(dot(sub(point(stroke, t), edge.a), direction) / dot(direction, direction), 0, 1)
      : (t - start) / (end - start);
    return stroke.ranges.map(([lo, hi]) => [Math.max(lo, start), Math.min(hi, end)])
      .filter(([lo, hi]) => lo < hi).map(([lo, hi]) => [toLocal(lo), toLocal(hi)]);
  }

  function bounds(edge) {
    const points = edge.c ? [edge.a, edge.b, edge.c] : [edge.a, edge.b];
    return [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])),
      Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))];
  }

  function overlap([left, top, right, bottom], [minX, minY, maxX, maxY], eps) {
    return left <= maxX + eps && minX <= right + eps && top <= maxY + eps && minY <= bottom + eps;
  }

  function intersections(first, second, eps, report) {
    const [d, q] = power(first);
    const [e, f] = power(second);
    const delta = sub(second.a, first.a);
    const onLine = (p, start, dir) => dot(sub(p, start), dir) / dot(dir, dir);
    const emit = (s, t) => {
      const sTolerance = eps / Math.max(distance(first.a, first.b), eps);
      const tTolerance = eps / Math.max(distance(second.a, second.b), eps);
      if (s < -sTolerance || s > 1 + sTolerance || t < -tTolerance || t > 1 + tTolerance) return;
      s = clamp(s, 0, 1);
      t = clamp(t, 0, 1);
      if (distance(point(first, s), point(second, t)) <= eps * 2) report(s, t);
    };

    if (!first.c && !second.c) {
      const denominator = cross(d, e);
      if (Math.abs(denominator) > length(d) * length(e) * 1e-14) {
        emit(cross(delta, e) / denominator, cross(delta, d) / denominator);
      } else if (Math.abs(cross(delta, d)) <= eps * length(d)) {
        emit(0, onLine(first.a, second.a, e));
        emit(1, onLine(first.b, second.a, e));
        emit(onLine(second.a, first.a, d), 0);
        emit(onLine(second.b, first.a, d), 1);
      }
      return;
    }

    if (!first.c) {
      for (const t of roots([cross(delta, d), cross(e, d), cross(f, d)])) {
        emit(onLine(point(second, t), first.a, d), t);
      }
      return;
    }

    if (!second.c) {
      intersections(second, first, eps, (t, s) => report(s, t));
      return;
    }

    const determinant = cross(q, d);
    const tOnFirst = [delta, e, f].map(v => cross(q, v) / determinant);
    const tSquared = [delta, e, f].map(v => cross(v, d) / determinant);
    const equation = [0, 0, 0, 0, 0];
    tOnFirst.forEach((a, i) => tOnFirst.forEach((b, j) => { equation[i + j] += a * b; }));
    for (let i = 0; i < 3; i++) equation[i] -= tSquared[i];
    const norm = Math.max(1, ...tOnFirst.map(v => v * v), ...tSquared.map(Math.abs));
    if (equation.every(v => Math.abs(v) <= norm * 2e-13)) {
      emit(evalPolynomial(tOnFirst, 0), 0);
      emit(evalPolynomial(tOnFirst, 1), 1);
      for (const s of [0, 1]) {
        const p = tOnFirst.slice();
        p[0] -= s;
        for (const t of roots(p)) emit(s, t);
      }
    } else {
      for (const t of roots(equation)) emit(evalPolynomial(tOnFirst, t), t);
    }
  }

  function signedArea(edges) {
    return edges.reduce((area, edge) => {
      const [d, q] = power(edge);
      return area + (cross(edge.a, add(d, q)) + cross(d, q) / 3) / 2;
    }, 0);
  }

  function contains(edges, [x, y]) {
    let inside = false;
    for (const edge of edges) {
      const [d, q] = power(edge);
      const turn = -d[1] / (2 * q[1]);
      const cuts = turn > 0 && turn < 1 ? [0, turn, 1] : [0, 1];
      for (let i = 1; i < cuts.length; i++) {
        let lo = cuts[i - 1];
        let hi = cuts[i];
        const lowPoint = point(edge, lo);
        const highPoint = point(edge, hi);
        if ((lowPoint[1] > y) === (highPoint[1] > y)) continue;
        if (Math.max(edge.a[0], edge.b[0], edge.c?.[0] ?? -Infinity) <= x) continue;
        let crossing;
        if (!edge.c) {
          crossing = mix(lowPoint, highPoint, (y - lowPoint[1]) / (highPoint[1] - lowPoint[1]));
        } else {
          for (let j = 0; j < 40; j++) {
            const mid = (lo + hi) / 2;
            if ((point(edge, mid)[1] > y) === (lowPoint[1] > y)) lo = mid;
            else hi = mid;
          }
          crossing = point(edge, (lo + hi) / 2);
        }
        if (crossing[0] > x) inside = !inside;
      }
    }
    return inside;
  }

  function contours(edges, next) {
    const loops = [];
    const seen = new Set();
    for (const edge of edges) {
      if (seen.has(edge)) continue;
      const loop = [];
      let current = edge;
      while (current && !seen.has(current)) {
        loop.push(current);
        seen.add(current);
        current = next(current);
      }
      if (current === edge) loops.push(loop);
    }
    return loops;
  }

  function trace(mesh, selected) {
    const boundary = [...selected].flatMap(id => mesh.faces[id]?.edges.filter(edge => !selected.has(edge.twin.face)) ?? []);
    const keep = new Set(boundary);
    return contours(boundary, edge => {
      const exits = edge.to.exits;
      for (let i = 1; i <= exits.length; i++) {
        const next = exits[(edge.twin.slot + exits.length - i) % exits.length];
        if (keep.has(next)) return next;
      }
      return null;
    });
  }

  function continuousSource(first, second) {
    const firstIntervals = first.intervals ?? first.twin.intervals;
    const secondIntervals = second.intervals ?? second.twin.intervals;
    return firstIntervals.some(({ source, interval }) => {
      const [a, b] = first.intervals ? interval : [interval[1], interval[0]];
      return secondIntervals.some(({ source: nextSource, interval: next }) => {
        const [c, d] = second.intervals ? next : [next[1], next[0]];
        return source === nextSource && Math.abs(b - c) <= paramEps && (b - a) * (d - c) > 0;
      });
    });
  }

  function redundantVertex(first, second, tolerance) {
    if (Boolean(first.c) !== Boolean(second.c)) return false;
    if (!first.c) {
      const incoming = sub(first.b, first.a);
      const outgoing = sub(second.b, second.a);
      return dot(incoming, outgoing) > 0 && (continuousSource(first, second) ||
        Math.abs(cross(incoming, outgoing)) <= tolerance * distance(first.a, second.b));
    }
    if (continuousSource(first, second)) return true;

    const incoming = sub(first.b, first.c);
    const outgoing = sub(second.c, second.a);
    if (dot(incoming, outgoing) <= 0) return false;
    // At a quadratic split the adjoining handles have lengths in the ratio t : (1 - t).
    const firstLength = length(incoming);
    const t = firstLength / (firstLength + length(outgoing));
    const control = t >= 0.5
      ? add(first.a, mul(sub(first.c, first.a), 1 / t))
      : add(second.b, mul(sub(second.c, second.b), 1 / (1 - t)));
    const left = mix(first.a, control, t);
    const right = mix(control, second.b, t);
    return distance(left, first.c) <= tolerance && distance(right, second.c) <= tolerance &&
      distance(mix(left, right, t), second.a) <= tolerance;
  }

  function outlineVertices(mesh, selected) {
    // Compare within rounding error, independently of the wider tolerance used to join mesh nodes.
    const tolerance = mesh.eps * 1e-5;
    const vertices = [];
    for (const loop of trace(mesh, selected)) {
      for (let i = 0; i < loop.length; i++) {
        const edge = loop[i];
        if (!redundantVertex(loop[i - 1] ?? loop.at(-1), edge, tolerance)) vertices.push(edge.a);
      }
    }
    return vertices;
  }

  function pointConnections(mesh, from, to, used) {
    if (from === to) return [];
    const tolerance = mesh.eps * 1e-5;
    const available = edge => edge.face !== edge.twin.face && !used.has(edge) && !used.has(edge.twin);
    const pending = from.exits.filter(available).map(edge => ({ edge, previous: null }));
    const seen = new Set();
    const connections = [];
    while (pending.length) {
      const step = pending.pop();
      const edge = step.edge;
      if (seen.has(edge)) continue;
      seen.add(edge);
      if (edge.to === to) {
        const path = [];
        for (let part = step; part; part = part.previous) path.push(part.edge);
        connections.push(path.reverse());
        continue;
      }
      for (const next of edge.to.exits) {
        if (available(next) && redundantVertex(edge, next, tolerance)) pending.push({ edge: next, previous: step });
      }
    }
    return connections.sort(([a], [b]) => Number(Boolean(a.c)) - Number(Boolean(b.c)));
  }

  function enclosedByPath(mesh, path) {
    const boundary = new Set(path);
    const outside = mesh.boundary.flatMap(edge => edge.face < 0 ? [edge] : edge.twin.face < 0 ? [edge.twin] : []);
    const inside = new Map([[-1, false]]);
    const queue = [-1];
    // Crossing the closed outline toggles the fill, including when it surrounds a hole.
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      for (const edge of id < 0 ? outside : mesh.faces[id].edges) {
        const neighbor = edge.twin.face;
        if (inside.has(neighbor)) continue;
        const crossed = boundary.has(edge) || boundary.has(edge.twin);
        inside.set(neighbor, inside.get(id) !== crossed);
        queue.push(neighbor);
      }
    }
    return [...inside].filter(([, filled]) => filled).map(([id]) => id);
  }

  const number = n => Number(n.toFixed(7));
  const xy = p => p.map(number).join(" ");
  const path = loops => loops.map(loop => {
    const commands = loop.map(edge => edge.c ? `Q${xy(edge.c)} ${xy(edge.b)}` : `L${xy(edge.b)}`);
    if (!loop.at(-1).c) commands.pop();
    return `M${xy(loop[0].a)}${commands.join("")}Z`;
  }).join("");

  function faceKey(loops) {
    return loops.map(loop => {
      const parts = loop.map(edge => `${xy(edge.a)}:${edge.c ? xy(edge.c) : ""}`);
      const candidates = parts.map((part, i) => [part, i]).sort(([a], [b]) => a.localeCompare(b));
      const first = candidates[0][0];
      return candidates.filter(([part]) => part === first).map(([, i]) =>
        parts.slice(i).concat(parts.slice(0, i)).join("|")).sort()[0];
    }).sort().join(";");
  }

  function arrange({ width, height, strokes }) {
    const eps = Math.max(width, height) * 1e-8;
    const corners = [[0, 0], [width, 0], [width, height], [0, height]];
    const frame = corners.map((p, i) => line(p, corners[(i + 1) % 4], -i - 1));
    // Split the original primitives first so retained intersections keep the same numerical solution.
    const all = frame.concat(strokes.flatMap((stroke, i) => basicEdges({ ...stroke, source: i }, eps)))
      .filter(edge => distance(edge.a, edge.b) > eps);
    const boxes = all.map(bounds);
    const active = all.map(edge => activeRanges(edge, strokes[edge.source]));
    const breaks = active.map(ranges => [0, 1, ...ranges.flat()]);
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        if (!overlap(boxes[i], boxes[j], eps)) continue;
        intersections(all[i], all[j], eps, (s, t) => {
          breaks[i].push(s);
          breaks[j].push(t);
        });
      }
    }

    const edges = [];
    const nodes = [];
    const cells = new Map();
    const pairs = new Map();
    function getNode(p) {
      const x = Math.floor(p[0] / eps);
      const y = Math.floor(p[1] / eps);
      for (let i = x - 1; i <= x + 1; i++) {
        for (let j = y - 1; j <= y + 1; j++) {
          const match = cells.get(`${i},${j}`)?.find(node => distance(node.p, p) <= eps);
          if (match) return match;
        }
      }
      const node = { p, id: nodes.length, exits: [], component: -1 };
      const key = `${x},${y}`;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(node);
      nodes.push(node);
      return node;
    }

    all.forEach((edge, index) => {
      const cuts = breaks[index].sort((a, b) => a - b)
        .filter((t, i, list) => !i || t - list[i - 1] > paramEps);
      const ranges = active[index];
      let range = 0;
      for (let i = 1; i < cuts.length; i++) {
        const midpoint = (cuts[i - 1] + cuts[i]) / 2;
        while (range < ranges.length && midpoint > ranges[range][1]) range++;
        if (range === ranges.length) break;
        if (midpoint < ranges[range][0]) continue;
        const mid = point(edge, midpoint);
        if (mid[0] < -eps || mid[1] < -eps || mid[0] > width + eps || mid[1] > height + eps) continue;
        const piece = slice(edge, cuts[i - 1], cuts[i]);
        if (distance(piece.a, piece.b) <= eps) continue;
        const from = getNode(piece.a);
        const to = getNode(piece.b);
        if (from === to) continue;
        const pair = [from.id, to.id].sort((a, b) => a - b).join(",");
        const matches = pairs.get(pair) ?? [];
        const duplicate = matches.find(item => (!item.c && !piece.c) ||
          (item.c && piece.c && distance(item.c, piece.c) <= eps * 3));
        const source = Math.max(-1, edge.source);
        const interval = [sourceParameter(edge, cuts[i - 1]), sourceParameter(edge, cuts[i])];
        if (duplicate) {
          duplicate.sources.add(source);
          if (duplicate.from !== from) interval.reverse();
          duplicate.intervals.push({ source: edge.source, interval });
          continue;
        }
        const sources = new Set([source]);
        const intervals = [{ source: edge.source, interval }];
        const forward = { a: from.p, b: to.p, c: piece.c, from, to, sources, intervals, face: -1 };
        const reverse = { a: to.p, b: from.p, c: piece.c, from: to, to: from, sources, face: -1 };
        forward.twin = reverse;
        reverse.twin = forward;
        from.exits.push(forward);
        to.exits.push(reverse);
        edges.push(forward, reverse);
        matches.push(forward);
        pairs.set(pair, matches);
      }
    });

    for (const node of nodes) {
      for (const edge of node.exits) {
        const [d, q] = power(edge);
        const tangent = length(d) > eps ? d : sub(edge.b, edge.a);
        edge.angle = Math.atan2(tangent[1], tangent[0]);
        // Give the two representations of the negative X direction the same rotation slot.
        if (edge.angle > Math.PI - 1e-8) edge.angle -= Math.PI * 2;
        edge.bend = cross(d, q) / Math.max(eps, length(d)) ** 3;
      }
      node.exits.sort((a, b) => Math.abs(a.angle - b.angle) > 1e-8 ? a.angle - b.angle : a.bend - b.bend);
      node.exits.forEach((edge, i) => { edge.slot = i; });
    }

    let component = 0;
    for (const node of nodes) {
      if (node.component >= 0) continue;
      node.component = component;
      const stack = [node];
      while (stack.length) {
        for (const edge of stack.pop().exits) {
          if (edge.to.component >= 0) continue;
          edge.to.component = component;
          stack.push(edge.to);
        }
      }
      component++;
    }

    const walks = contours(edges, edge => {
      const exits = edge.to.exits;
      return exits[(edge.twin.slot + exits.length - 1) % exits.length];
    }).map(loop => ({ loop, area: signedArea(loop), component: loop[0].from.component }));
    const minArea = eps * eps * 10;
    const faces = walks.filter(walk => walk.area > minArea).map((walk, id) => ({ ...walk, id, edges: [] }));
    faces.forEach(face => face.loop.forEach(edge => { edge.face = face.id; }));
    const smallestFirst = faces.slice().sort((a, b) => a.area - b.area);
    for (const walk of walks) {
      if (walk.area > minArea) continue;
      const sample = point(walk.loop[0], 0.5);
      const face = smallestFirst.find(candidate =>
        candidate.component !== walk.component && contains(candidate.loop, sample));
      if (face) walk.loop.forEach(edge => { edge.face = face.id; });
    }
    for (const edge of edges) faces[edge.face]?.edges.push(edge);
    const boundary = edges.filter((edge, i) => i % 2 === 0 && edge.face !== edge.twin.face);
    const boundaryPoints = nodes.filter(node => node.exits.some(edge => edge.face !== edge.twin.face));
    const mesh = { faces, edges, boundary, boundaryPoints, eps };
    for (const face of faces) {
      face.loops = trace(mesh, new Set([face.id]));
      face.path = path(face.loops);
      face.key = faceKey(face.loops);
    }
    for (const edge of boundary) edge.bounds = bounds(edge);
    mesh.unused = edges.filter((edge, i) => i % 2 === 0 && !edge.sources.has(-1) && edge.face === edge.twin.face);
    return mesh;
  }

  function regionAt(mesh, p) {
    return mesh.faces.find(face => face.loops.reduce((inside, loop) => inside !== contains(loop, p), false))?.id;
  }

  function regionsAlong(mesh, a, b) {
    const segment = line(a, b);
    const box = bounds(segment);
    const cuts = [0, 1];
    if (distance(a, b) > mesh.eps) {
      for (const edge of mesh.boundary) {
        if (overlap(box, edge.bounds, mesh.eps)) intersections(segment, edge, mesh.eps, t => cuts.push(t));
      }
    }
    cuts.sort((s, t) => s - t);
    const regions = new Set();
    for (let i = 1; i < cuts.length; i++) {
      if (cuts[i] - cuts[i - 1] <= paramEps) continue;
      const id = regionAt(mesh, point(segment, (cuts[i - 1] + cuts[i]) / 2));
      if (id !== undefined) regions.add(id);
    }
    return regions;
  }

  function components(size) {
    const parent = Array.from({ length: size }, (_, i) => i);
    const root = id => {
      while (id !== parent[id]) {
        parent[id] = parent[parent[id]];
        id = parent[id];
      }
      return id;
    };
    const join = (a, b) => { parent[root(a)] = root(b); };
    return { root, join };
  }

  function sourceFaceSpans(edges) {
    const spans = new Map();
    for (const edge of edges) {
      for (const { source, interval: [a, b] } of edge.intervals) {
        if (!spans.has(source)) spans.set(source, []);
        const faces = [edge.face, edge.twin.face];
        spans.get(source).push({ lo: Math.min(a, b), hi: Math.max(a, b), faces: a < b ? faces : faces.reverse() });
      }
    }
    for (const entries of spans.values()) entries.sort((a, b) => a.lo - b.lo);
    return spans;
  }

  function facesNearParameter(spans, source, t) {
    const intervals = spans.get(source);
    if (!intervals) return null;
    let lo = 0;
    let hi = intervals.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (intervals[mid].hi < t - paramEps) lo = mid + 1;
      else hi = mid;
    }
    const match = intervals[lo];
    return match && match.lo <= t + paramEps ? match.faces : null;
  }

  // Reconnect regions across the boundaries absent from the original template.
  // The surviving source intervals identify the original face on each side.
  function originalFaces(original, refinement, sourceIds, sharedFrame = true) {
    const spans = sourceFaceSpans(original.boundary);
    const { root, join } = components(refinement.faces.length);
    const anchors = [];
    for (const edge of refinement.boundary) {
      const sides = [edge.face, edge.twin.face];
      let matched = false;
      for (const { source, interval: [a, b] } of edge.intervals) {
        if (source < 0 && !sharedFrame) continue;
        const old = facesNearParameter(spans, source < 0 ? source : sourceIds[source], (a + b) / 2);
        if (!old) continue;
        matched = true;
        sides.forEach((id, i) => {
          if (id >= 0) anchors.push([id, old[a < b ? i : 1 - i]]);
        });
      }
      if (!matched && sides.every(id => id >= 0)) join(...sides);
    }
    const parents = new Map();
    for (const [id, old] of anchors) {
      const component = root(id);
      if (!parents.has(component)) parents.set(component, old);
      else if (parents.get(component) !== old) parents.set(component, -2);
    }
    return refinement.faces.map(({ id }) => parents.get(root(id)) ?? -2);
  }

  function adaptGlyphs(oldTemplate, newTemplate, glyphs) {
    if (!Object.keys(glyphs).length) return {};
    const oldSpec = oldTemplate.spec;
    const newSpec = newTemplate.spec;
    const oldMesh = arrange(oldSpec);
    const newMesh = arrange(newSpec);
    const framed = ({ width, height, strokes }) => {
      const corners = [[0, 0], [width, 0], [width, height], [0, height]];
      return strokes.concat(corners.map((p, i) => line(p, corners[(i + 1) % 4])));
    };
    const oldStrokes = framed(oldSpec);
    const newStrokes = framed(newSpec);
    const overlay = arrange({
      width: Math.max(oldSpec.width, newSpec.width),
      height: Math.max(oldSpec.height, newSpec.height),
      strokes: oldStrokes.concat(newStrokes)
    });
    const source = (index, count) => index < count ? index : count - index - 1;
    const oldSources = oldStrokes.map((_, i) => source(i, oldSpec.strokes.length));
    const newSources = Array(oldStrokes.length).concat(newStrokes.map((_, i) => source(i, newSpec.strokes.length)));
    const oldParents = originalFaces(oldMesh, overlay, oldSources, false);
    const newParents = originalFaces(newMesh, overlay, newSources, false);
    const area = face => face.loops.reduce((total, loop) => total + signedArea(loop), 0);
    const overlaps = newMesh.faces.map(() => new Map());
    for (const face of overlay.faces) {
      const target = newParents[face.id];
      const origin = oldParents[face.id];
      if (target === -1) continue;
      if (target < -1 || origin < -1) throw new Error("无法准确比较两个模板的分区。");
      if (origin === -1) continue;
      const coverage = overlaps[target];
      coverage.set(origin, (coverage.get(origin) ?? 0) + area(face));
    }
    const oldDisabled = new Set(oldTemplate.disabledRegions);
    const newDisabled = new Set(newTemplate.disabledRegions);
    const regions = newMesh.faces.filter(face => !newDisabled.has(face.id)).map(face => ({
      id: face.id, halfArea: area(face) / 2, coverage: overlaps[face.id]
    }));
    return Object.fromEntries(Object.entries(glyphs).flatMap(([character, ids]) => {
      const filled = new Set(ids.filter(id => !oldDisabled.has(id)));
      const selected = regions.filter(({ halfArea, coverage }) => {
        let overlapArea = 0;
        for (const [origin, size] of coverage) if (filled.has(origin)) overlapArea += size;
        return overlapArea - halfArea > 1e-10 * halfArea;
      }).map(({ id }) => id);
      return selected.length ? [[character, selected]] : [];
    }));
  }

  function inheritedFaces(oldSpec, oldMesh, newSpec, newMesh) {
    if (oldSpec.width !== newSpec.width || oldSpec.height !== newSpec.height) return null;
    const key = stroke => JSON.stringify([stroke.a, stroke.b, stroke.c, stroke.ranges]);
    const oldSources = new Map(oldSpec.strokes.map((stroke, id) => [key(stroke), id]));
    const newSources = new Map(newSpec.strokes.map((stroke, id) => [key(stroke), id]));
    if (newSpec.strokes.every(stroke => oldSources.has(key(stroke)))) return null;

    // In most edits the new template is already a refinement. For a mix of edits,
    // overlay both sets of strokes to distinguish full subdivisions from partial overlaps.
    const missing = oldSpec.strokes.filter(stroke => !newSources.has(key(stroke)));
    const strokes = newSpec.strokes.concat(missing);
    const refinement = missing.length ? arrange({ ...newSpec, strokes }) : newMesh;
    const oldParents = originalFaces(oldMesh, refinement, strokes.map(stroke => oldSources.get(key(stroke))));
    const newParents = missing.length
      ? originalFaces(newMesh, refinement, strokes.map(stroke => newSources.get(key(stroke))))
      : refinement.faces.map(face => face.id);
    if (oldParents.some(id => id < 0) || newParents.some(id => id < 0)) return null;

    const descendants = oldMesh.faces.map(() => new Set());
    const owners = newMesh.faces.map(() => new Set());
    oldParents.forEach((old, i) => {
      const next = newParents[i];
      descendants[old].add(next);
      owners[next].add(old);
    });
    return descendants.map(children =>
      [...children].every(id => owners[id].size === 1) ? [...children] : []);
  }

  function combineRanges(intervals) {
    const ranges = intervals.map(([a, b]) => [Math.min(a, b), Math.max(a, b)]).sort(([a], [b]) => a - b);
    const combined = [];
    for (const [lo, hi] of ranges) {
      const last = combined.at(-1);
      if (last && lo <= last[1] + paramEps) last[1] = Math.max(last[1], hi);
      else combined.push([lo, hi]);
    }
    return combined;
  }

  function simplify(spec, mesh, glyphs) {
    const usage = mesh.faces.map(() => "");
    for (const [character, ids] of Object.entries(glyphs)) {
      for (const id of ids) usage[id] += character;
    }
    const { root, join } = components(mesh.faces.length);
    const removed = new Set();
    const changedSources = new Set();
    for (const edge of mesh.boundary) {
      const a = edge.face;
      const b = edge.twin.face;
      if (a < 0 || b < 0 || usage[a] !== usage[b]) continue;
      join(a, b);
      removed.add(edge);
      for (const source of edge.sources) changedSources.add(source);
    }
    if (!removed.size) return null;

    const kept = sourceFaceSpans(mesh.edges.filter((edge, i) => i % 2 === 0 && !removed.has(edge)));
    const strokes = [];
    const sourceIds = [];
    spec.strokes.forEach((stroke, id) => {
      if (!changedSources.has(id)) strokes.push(stroke);
      else {
        const ranges = combineRanges((kept.get(id) ?? []).map(({ lo, hi }) => [lo, hi]));
        if (!ranges.length) return;
        strokes.push({ ...stroke, ranges });
      }
      sourceIds.push(id);
    });

    const draft = { ...spec, strokes };
    const next = arrange(draft);
    const newIds = new Map();
    const oldIds = new Map();
    const error = "有些合并边无法精确接回原字形，已保留原模板。";
    for (const edge of next.boundary) {
      for (const { source, interval: [a, b] } of edge.intervals) {
        const faces = facesNearParameter(kept, source < 0 ? source : sourceIds[source], (a + b) / 2);
        if (!faces) throw new Error(error);
        const aligned = a < b ? faces : [faces[1], faces[0]];
        [edge.face, edge.twin.face].forEach((id, i) => {
          const old = aligned[i];
          if (old < 0 && id < 0) return;
          if (old < 0 || id < 0) throw new Error(error);
          const component = root(old);
          if ((newIds.has(component) && newIds.get(component) !== id) ||
            (oldIds.has(id) && oldIds.get(id) !== component)) throw new Error(error);
          newIds.set(component, id);
          oldIds.set(id, component);
        });
      }
    }
    const groups = new Set(mesh.faces.map(face => root(face.id)));
    if (next.faces.length !== groups.size || newIds.size !== groups.size) throw new Error(error);
    const nextGlyphs = Object.fromEntries(Object.entries(glyphs).map(([character, ids]) =>
      [character, [...new Set(ids.map(id => newIds.get(root(id))))].sort((a, b) => a - b)]));
    return { draft, geometry: next, glyphs: nextGlyphs };
  }

  return { arrange, trace, outlineVertices, path, pointConnections, enclosedByPath, regionAt, regionsAlong, inheritedFaces, adaptGlyphs,
    simplify, strokeParts, point, number, signedArea };
})();
