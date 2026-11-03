// End-to-end checks of the demo in Chromium (Playwright). Run: node test/e2e.mjs
// The Safari/Firefox path is emulated with LiquidGlassConfig = { native: false }.
import { createRequire } from 'node:module';
import path from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }

const url = 'file://' + path.resolve('demo/index.html');
const cases = [
  { name: 'chromium (native)', cfg: null, expect: { native: true } },
  { name: 'emulated safari/firefox (mirror + fallback)', cfg: { native: false }, expect: { mirror: true, fallback: true } },
  { name: 'forced fallback', cfg: { forceMode: 'fallback' }, expect: { fallback: true } }
];
const browser = await chromium.launch();
let failed = 0;
for (const c of cases) {
  for (const vp of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport: vp });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error' && !/fonts\.g/.test(m.text())) errors.push(m.text()); });
    if (c.cfg) await page.addInitScript(cfg => { window.LiquidGlassConfig = cfg; }, c.cfg);
    await page.goto(url);
    await page.waitForFunction(() => {
      const all = [...document.querySelectorAll('.lg')];
      return all.length && all.every(e => e.hasAttribute('data-lg-mode') && e.style.getPropertyValue('--lg-specular-image'));
    }, null, { timeout: 15000 }).catch(() => {});
    const r = await page.evaluate(() => {
      const modes = {};
      document.querySelectorAll('.lg').forEach(e => { const m = e.getAttribute('data-lg-mode') || 'none'; modes[m] = (modes[m] || 0) + 1; });
      const nativeEl = document.querySelector('[data-lg-mode="native"]');
      const mirrorCanvas = document.querySelector('.lg-refraction');
      let mirrorPainted = null;
      if (mirrorCanvas && mirrorCanvas.width > 2) {
        const d = mirrorCanvas.getContext('2d').getImageData(0, 0, mirrorCanvas.width, mirrorCanvas.height).data;
        let sum = 0; for (let i = 3; i < d.length; i += 4) sum += d[i];
        mirrorPainted = sum > 0;
      }
      return {
        modes,
        overflow: document.documentElement.scrollWidth - innerWidth,
        filterOk: nativeEl ? !!document.querySelector(nativeEl.style.backdropFilter.replace(/url\("?(#[^")]+)"?\)/, '$1') + ' feDisplacementMap') : null,
        specular: [...document.querySelectorAll('.lg')].filter(e => e.style.getPropertyValue('--lg-specular-image')).length,
        mirrorPainted
      };
    });
    const label = `${c.name} @${vp.width}px`;
    try {
      assert.deepEqual(errors, [], 'page errors');
      assert.ok(r.overflow <= 0, 'horizontal overflow ' + r.overflow);
      assert.equal(r.modes.none || 0, 0, 'every .lg element upgraded');
      for (const m of Object.keys(c.expect)) assert.ok(r.modes[m] > 0, `expected some ${m} elements`);
      if (c.expect.native) assert.equal(r.filterOk, true, 'native element references an SVG displacement filter');
      if (c.expect.mirror) assert.equal(r.mirrorPainted, true, 'mirror canvas has pixels');
      assert.ok(r.specular > 0, 'specular images applied');
      console.log('ok  ', label, JSON.stringify(r.modes));
    } catch (e) {
      failed++;
      console.log('FAIL', label, e.message, JSON.stringify(r));
    }
    await page.close();
  }
}
// interactions
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url);
  await page.waitForTimeout(800);
  try {
    await page.click('#mode [data-value="rest"]');
    await page.waitForTimeout(700);
    const idx = await page.evaluate(() => getComputedStyle(document.getElementById('mode')).getPropertyValue('--lg-index').trim());
    assert.equal(idx, '1', 'segmented index');
    const fire = await page.evaluate(() => document.getElementById('ch-fire-on').checked);
    assert.equal(fire, true, 'rest preset enables the fire channel');
    await page.evaluate(() => { window.scrollTo({ top: 0, left: 0, behavior: 'instant' }); });
    await page.waitForTimeout(200);
    const lens = await page.locator('#lens').boundingBox();
    await page.mouse.move(lens.x + 80, lens.y + 80);
    await page.mouse.down();
    await page.mouse.move(lens.x + 180, lens.y + 140, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(600);
    const after = await page.locator('#lens').boundingBox();
    const hit = await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e && (e.id || e.className); }, [lens.x + 80, lens.y + 80]);
    assert.ok(after.x - lens.x > 80, 'lens dragged ' + (after.x - lens.x) + ' hit=' + hit + ' ' + JSON.stringify(lens));
    await page.click('#theme-toggle');
    const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    assert.ok(theme === 'dark' || theme === 'light', 'theme attribute set');
    await page.click('#play');
    await page.waitForTimeout(2200);
    const t = await page.textContent('#t-now');
    assert.notEqual(t, '12:04', 'player advances');
    assert.deepEqual(errors, []);
    console.log('ok   interactions (segmented, drag, theme, player)');
  } catch (e) { failed++; console.log('FAIL interactions', e.message); }
  await page.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
