// Unit tests for the pure optics functions. Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const LG = require('../dist/liquidglass.js');

const px = (m, x, y) => Array.from(m.data.slice((y * m.width + x) * 4, (y * m.width + x) * 4 + 4));

test('exports the pure API in Node (no DOM)', () => {
  assert.equal(typeof LG.computeLensMap, 'function');
  assert.equal(typeof LG.computeSpecularMap, 'function');
  assert.equal(LG.init, undefined);
});

test('Snell: no displacement when ior = 1 (air)', () => {
  const t = LG.buildProfileTable(30, 40, 1.0, 'squircle');
  assert.ok(t.maxDisp < 1e-9, `maxDisp=${t.maxDisp}`);
});

test('displacement grows with ior and thickness', () => {
  const a = LG.buildProfileTable(30, 20, 1.5, 'squircle').maxDisp;
  const b = LG.buildProfileTable(30, 20, 2.0, 'squircle').maxDisp;
  const c = LG.buildProfileTable(30, 40, 1.5, 'squircle').maxDisp;
  assert.ok(b > a && c > a, `${a} ${b} ${c}`);
});

test('flat top and rim edge do not displace', () => {
  for (const p of ['squircle', 'circle', 'parabolic']) {
    const t = LG.buildProfileTable(30, 30, 1.5, p);
    assert.equal(t.disp[t.disp.length - 1], 0, p);
  }
});

test('lens map: centre is neutral, rims sample inward', () => {
  const m = LG.computeLensMap(240, 120, { radius: 30, thickness: 30 });
  assert.equal(m.width, 240);
  const c = px(m, 120, 60);
  assert.deepEqual(c.slice(0, 2), [128, 128]);
  const left = px(m, 4, 60), right = px(m, 235, 60), top = px(m, 120, 4), bottom = px(m, 120, 115);
  assert.ok(left[0] > 128, 'left rim samples to the right');
  assert.ok(right[0] < 128, 'right rim samples to the left');
  assert.ok(top[1] > 128, 'top rim samples downward');
  assert.ok(bottom[1] < 128, 'bottom rim samples upward');
});

test('lens map is mirror-symmetric', () => {
  const m = LG.computeLensMap(200, 100, { radius: 24, thickness: 24 });
  for (const [x, y] of [[3, 50], [10, 10], [40, 5], [99, 2]]) {
    const a = px(m, x, y), b = px(m, m.width - 1 - x, y);
    assert.ok(Math.abs((a[0] - 128) + (b[0] - 128)) <= 1, `x-sym at ${x},${y}: ${a} vs ${b}`);
    assert.ok(Math.abs(a[1] - b[1]) <= 1, `y equal at ${x},${y}`);
  }
});

test('scale encodes maxDisp for feDisplacementMap', () => {
  const m = LG.computeLensMap(160, 160, { radius: 80, thickness: 50 });
  assert.ok(Math.abs(m.scale - m.maxDisp * 255 / 127) < 1e-9);
  assert.ok(m.maxDisp > 1);
});

test('large elements are capped in map resolution', () => {
  const m = LG.computeLensMap(2000, 1000, { radius: 40, maxResolution: 500 });
  assert.equal(m.width, 500);
  assert.equal(m.height, 250);
});

test('specular: lit rim faces the light, interior stays clear', () => {
  const s = LG.computeSpecularMap(200, 100, { radius: 30, thickness: 30, lightAngle: -90 }, 1); // light from the top
  const topRim = px(s, 100, 1)[3], bottomRim = px(s, 100, 98)[3], centre = px(s, 100, 50)[3];
  assert.equal(centre, 0);
  assert.ok(topRim > bottomRim, `top ${topRim} > bottom ${bottomRim}`);
  assert.ok(bottomRim > 0, 'far rim has a weaker internal reflection');
});

test('specular respects pixel ratio', () => {
  const s = LG.computeSpecularMap(50, 20, { radius: 10 }, 2);
  assert.equal(s.width, 100);
  assert.equal(s.height, 40);
});
