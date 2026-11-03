// Zoomed screenshot of an element. usage: node test/zoom.mjs <selector> <out.png> [forceMode] [scheme]
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }
const [sel, out, force = '', scheme = 'light'] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: scheme, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
if (force) await page.addInitScript(f => { window.LiquidGlassConfig = f === 'safari' ? { native: false } : { forceMode: f }; }, force);
await page.goto('file://' + path.resolve('demo/index.html'));
await page.evaluate(s => { document.documentElement.style.scrollBehavior = 'auto'; const m = document.getElementById('motion-toggle'); m.checked = false; document.querySelector(s).scrollIntoView({ block: 'center' }); }, sel);
await page.waitForTimeout(2000);
const box = await page.locator(sel).boundingBox();
const pad = 30;
await page.screenshot({ path: out, clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + pad * 2, height: box.height + pad * 2 } });
console.log(await page.evaluate(s => document.querySelector(s).getAttribute('data-lg-mode'), sel), errors.join('\n'));
await browser.close();
