// Screenshot demo sections. usage: node test/demo-shots.mjs <outDir> [forceMode] [scheme] [width] [height]
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }
const [outDir, force = '', scheme = 'light', w = '1280', h = '800'] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: +w, height: +h }, colorScheme: scheme, deviceScaleFactor: 1 });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('requestfailed', r => { if (!/fonts\.(googleapis|gstatic)/.test(r.url())) errors.push('requestfailed: ' + r.url()); });
if (force) await page.addInitScript(f => { window.LiquidGlassConfig = f === 'safari' ? { native: false } : { forceMode: f }; }, force);
await page.goto('file://' + path.resolve('demo/index.html'));
await page.waitForTimeout(1800);
const tag = (force || 'auto') + '-' + scheme + '-' + w;
for (const id of ['top', 'mixer', 'features', 'physics', 'pricing', 'beta']) {
  await page.evaluate(i => { document.documentElement.style.scrollBehavior = 'auto'; const el = document.getElementById(i); window.scrollTo(0, i === 'top' ? 0 : el.getBoundingClientRect().top + scrollY - 90); }, id);
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(outDir, `${tag}-${id}.png`) });
}
const info = await page.evaluate(() => {
  const modes = {};
  document.querySelectorAll('.lg').forEach(e => { const m = e.getAttribute('data-lg-mode') || 'none'; modes[m] = (modes[m] || 0) + 1; });
  return { modes, docW: document.documentElement.scrollWidth, vw: innerWidth };
});
console.log(tag, JSON.stringify(info), errors.length ? '\n  ERRORS: ' + errors.join('\n  ') : '');
await browser.close();
