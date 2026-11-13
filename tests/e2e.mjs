// End-to-end tests: load the extension into Chrome for Testing and drive real pages.
//
//   npm install                        (puppeteer-core)
//   npx @puppeteer/browsers install chrome@stable   (once, if not cached)
//   npm run test:e2e                   (CHROME_PATH=... to pick a binary)
//
// Branded Google Chrome ignores --load-extension; use Chrome for Testing.
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { sampleLines as makeSampleLines } from './fixtures/sample-log.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');

function loadPuppeteer() {
  try {
    return require('puppeteer-core');
  } catch (e) {
    if (process.env.PUPPETEER_CORE) return require(process.env.PUPPETEER_CORE);
    console.error('puppeteer-core not found: run `npm install` (or set PUPPETEER_CORE=/path/to/puppeteer-core)');
    process.exit(2);
  }
}

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome');
  if (fs.existsSync(base)) {
    for (const version of fs.readdirSync(base).sort().reverse()) {
      for (const candidate of [
        path.join(base, version, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
        path.join(base, version, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
        path.join(base, version, 'chrome-linux64', 'chrome'),
        path.join(base, version, 'chrome-win64', 'chrome.exe')
      ]) {
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  console.error('Chrome for Testing not found: run `npx @puppeteer/browsers install chrome@stable` or set CHROME_PATH');
  process.exit(2);
}

const puppeteer = loadPuppeteer();
const CHROME = findChrome();
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rsearch-e2e-'));
const out = path.join(work, 'screenshots');
fs.mkdirSync(out, { recursive: true });
const PAGE_FILES = ['manifest.json', 'shared.js', 'content.js', 'background.js', 'popup.html', 'popup.js', 'styles.css', 'icon16.png', 'icon48.png', 'icon128.png'];

// test copy of the extension with host access already granted ("Allow")
const extDir = path.join(work, 'ext-granted');
fs.mkdirSync(extDir);
for (const f of PAGE_FILES) fs.copyFileSync(path.join(repo, f), path.join(extDir, f));
const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['<all_urls>'];
fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

// ---------- test pages ----------
const sampleLines = makeSampleLines(4000);
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function logHtml(n) {
  let rows = '';
  for (let i = 0; i < n; i++) {
    const line = sampleLines[i % sampleLines.length];
    rows += `<div class="line"><span class="no">${i + 1}</span> <span class="msg">${esc(line)}</span></div>\n`;
  }
  return rows;
}
const pages = {
  '/log.html': `<!doctype html><html><head><title>log</title><style>body{font:12px monospace;margin:0;padding:8px}.no{color:#999}</style></head><body>
<p id="words">zoom room default pleasant deadline banana TypeError</p>
<textarea id="ta">error in textarea fatal</textarea>
<div contenteditable="true" id="ce">error inside editable crash</div>
<div style="display:none" id="hidden">fatal hidden error</div>
<div id="scroller" style="height:120px;overflow:auto;border:1px solid #ccc"><div style="height:1500px"></div><div id="deep">Segmentation fault (core dumped) deep inside scroller</div></div>
<div id="log">${logHtml(3000)}</div></body></html>`,
  '/words.html': `<!doctype html><html><body><p>zoom into the room; use the default; a pleasant peasant met the deadline; banana maintenance; xfail; stackoverflow</p><p>TypeError: boom</p></body></html>`,
  '/stream.html': `<!doctype html><html><body><div id="log"></div><p id="mut">Request error A</p><script>
const log = document.getElementById('log');
for (let i = 0; i < 20; i++) { const d = document.createElement('div'); d.textContent = 'line ' + i + ' info ok'; log.appendChild(d); }
let n = 0;
window.__streamDone = false;
const timer = setInterval(() => {
  const d = document.createElement('div');
  d.textContent = 'line ' + (100 + n) + (n % 2 ? ' fatal: worker crashed' : ' info ok');
  log.appendChild(d);
  if (++n >= 10) { clearInterval(timer); window.__streamDone = true; }
}, 150);
</script></body></html>`,
  '/react.html': `<!doctype html><html><body><div id="root"></div><script>
window.__errors = [];
window.addEventListener('error', e => window.__errors.push(e.message));
const root = document.getElementById('root');
const p = document.createElement('p');
const t = document.createTextNode('Request failed with error 500');
p.appendChild(t); root.appendChild(p);
window.__htmlBefore = null;
setTimeout(() => {
  window.__htmlBefore = document.body.innerHTML;
}, 900);
setTimeout(() => {
  try { t.data = 'Request error again, then fatal'; p.removeChild(t); p.appendChild(t); window.__reactOk = true; }
  catch (e) { window.__errors.push(e.message); }
}, 1500);
</script></body></html>`,
  '/plain.txt': sampleLines.slice(0, 4000).join('\n'),
  '/big.html': `<!doctype html><html><body><pre>${(() => { let s = ''; for (let i = 0; i < 50000; i++) s += '<span>' + esc(sampleLines[i % sampleLines.length]) + '</span>\n'; return s; })()}</pre></body></html>`,
  '/paused.html': `<!doctype html><html><body><p>fatal error everywhere</p></body></html>`,
  '/csp.html': `<!doctype html><html><head><title>csp</title></head><body><div>${logHtml(1500)}</div></body></html>`,
  '/passing.html': `<!doctype html><html><body><pre>Tests run: 128, Failures: 0, Errors: 0, Skipped: 2
========== 412 passed, 0 failed, 3 skipped in 81.2s ==========
Build succeeded.    0 Warning(s)    0 Error(s)
Warning: Permanently added 'github.com' (ED25519) to the list of known hosts.
BUILD SUCCESSFUL in 42s</pre></body></html>`,
  '/jenkins.html': `<!doctype html><html><body><div id="skip">Skipping 13,527 KB.. <a href="/job/x/42/consoleFull">Full Log</a></div><pre>${sampleLines.slice(0, 200).map(esc).join('\n')}</pre></body></html>`,
  '/notpartial.html': `<!doctype html><html><body><pre>Skipping 5 MB of cache restore
fatal: worker crashed</pre></body></html>`
};
const server = http.createServer((req, res) => {
  const p = req.url.split('?')[0];
  const body = pages[p];
  if (body === undefined) { res.writeHead(404); res.end('nf'); return; }
  const headers = { 'content-type': p.endsWith('.txt') ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8' };
  if (p === '/csp.html') headers['content-security-policy'] = "default-src 'self'; style-src 'self'; script-src 'none'; require-trusted-types-for 'script'";
  res.writeHead(200, headers);
  res.end(body);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;

// ---------- harness ----------
let failures = 0;
const results = [];
async function check(name, fn) {
  try {
    const info = await fn();
    results.push('ok   ' + name + (info ? '  ' + info : ''));
  } catch (e) {
    failures++;
    results.push('FAIL ' + name + '\n     ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n     ') : e));
  }
  console.log(results[results.length - 1]);
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log('Chrome: ' + CHROME + '\nartifacts: ' + work + '\n');
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  pipe: true,
  enableExtensions: [extDir],
  args: ['--no-first-run', '--no-default-browser-check', '--window-size=1280,900'],
  defaultViewport: { width: 1280, height: 900 }
});

try {
  const swTarget = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().endsWith('/background.js'), { timeout: 15000 });
  const sw = await swTarget.worker();
  const extId = new URL(swTarget.url()).host;
  await sleep(500);

  async function tabIdFor(urlPart) {
    return sw.evaluate(async part => {
      const tabs = await chrome.tabs.query({});
      const t = tabs.find(x => x.url && x.url.includes(part));
      return t ? t.id : null;
    }, urlPart);
  }
  async function msg(tabId, message) {
    return sw.evaluate((id, m) => chrome.tabs.sendMessage(id, m), tabId, message);
  }
  async function waitState(tabId, pred, timeout = 15000) {
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < timeout) {
      last = await msg(tabId, { action: 'getState' }).catch(() => null);
      if (last && pred(last)) return last;
      await sleep(100);
    }
    throw new Error('timeout waiting for state; last=' + JSON.stringify(last && { active: last.active, running: last.running, count: last.count }));
  }
  async function registrySizes(page) {
    return page.evaluate(() => {
      const o = {};
      if (!CSS.highlights) return null;
      for (const [k, v] of CSS.highlights) o[k] = v.size;
      return o;
    });
  }

  await check('install seeds defaults: auto ON, presets, options', async () => {
    const s = await sw.evaluate(() => chrome.storage.local.get(null));
    assert(s.autoSearchEnabled === true, 'autoSearchEnabled ' + s.autoSearchEnabled);
    assert(Array.isArray(s.rsearch_presets_v2) && s.rsearch_presets_v2.length === 3, 'presets');
    assert(s.rsearch_options && s.rsearch_options.smartMatch === true, 'options');
    return 'keywords=' + RSearchCoreCount(s.rsearch_presets_v2[0].csv);
  });
  function RSearchCoreCount(csv) { return csv.trim().split('\n').length - 1; }

  await check('always-on content script registered', async () => {
    const regs = await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts());
    assert(regs.length === 1 && regs[0].id === 'rsearch-auto', JSON.stringify(regs));
    return JSON.stringify(regs[0].js);
  });

  // ---------- auto-highlight on page load ----------
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('  [pageerror]', e.message));
  await page.goto(base + '/log.html', { waitUntil: 'load' });
  const logTab = await tabIdFor('/log.html');
  let state;

  await check('auto-highlight runs on page load without opening the popup', async () => {
    state = await waitState(logTab, s => s.active && !s.running);
    assert(state.count > 1000, 'count ' + state.count);
    assert(state.source === 'auto', 'source ' + state.source);
    return `count=${state.count} visible=${state.visibleCount} levels=${JSON.stringify(state.levels)}`;
  });

  await check('highlights live in the document registry (paintable), no DOM changes', async () => {
    const sizes = await registrySizes(page);
    assert(sizes && Object.keys(sizes).length > 0, 'registry empty from main world: ' + JSON.stringify(sizes));
    const total = Object.entries(sizes).filter(([k]) => k.startsWith('rsearch-l')).reduce((a, [, v]) => a + v, 0);
    // > 3,000 matches: only ranges near the viewport are registered (virtualized)
    assert(total > 0 && total < state.highlighted && total <= 3000, 'registry ' + total + ' vs highlighted ' + state.highlighted);
    const spans = await page.evaluate(() => document.querySelectorAll('body span[class*=rsearch], body .regex-search-highlight').length);
    assert(spans === 0, 'injected spans: ' + spans);
    return JSON.stringify(sizes);
  });

  await check('virtualized highlights follow the viewport and inner scroll panes', async () => {
    const lastLine = async () => page.evaluate(() => {
      const lines = document.querySelectorAll('#log .line');
      const target = lines[lines.length - 3];
      for (const [name, h] of CSS.highlights) {
        if (!name.startsWith('rsearch-l')) continue;
        for (const r of h) if (target.contains(r.startContainer)) return true;
      }
      return false;
    });
    const before = await lastLine();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await sleep(250);
    const after = await lastLine();
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(150);
    const deep = async () => page.evaluate(() => {
      for (const [name, h] of CSS.highlights) {
        if (!name.startsWith('rsearch-l')) continue;
        for (const r of h) if (r.startContainer.parentElement && r.startContainer.parentElement.id === 'deep') return true;
      }
      return false;
    });
    await page.evaluate(() => { document.getElementById('scroller').scrollTop = 1400; });
    await sleep(250);
    const deepAfter = await deep();
    await page.evaluate(() => { document.getElementById('scroller').scrollTop = 0; });
    assert(!before && after, 'bottom lines registered only when near: before=' + before + ' after=' + after);
    assert(deepAfter, 'inner scroll pane match not registered after scrolling the pane');
    const sizes = await registrySizes(page);
    return 'registered now ' + Object.entries(sizes).filter(([k]) => k.startsWith('rsearch-l')).reduce((a, [, v]) => a + v, 0) + ' of ' + state.highlighted;
  });

  await check('textarea / contenteditable untouched, hidden match counted but not navigable', async () => {
    const bad = await page.evaluate(() => {
      const hits = [];
      for (const [name, h] of CSS.highlights) {
        if (!name.startsWith('rsearch-l')) continue;
        for (const r of h) {
          const el = r.startContainer.parentElement;
          if (el.closest('#ta, #ce')) hits.push(el.id || el.tagName);
        }
      }
      return hits;
    });
    assert(bad.length === 0, 'highlighted inside editable: ' + bad.join(','));
    assert(state.highlighted - state.visibleCount >= 1, 'hidden matches not detected');
  });

  await check('smart match: zoom/room/default/pleasant/deadline/banana not highlighted, TypeError is', async () => {
    const words = await page.evaluate(() => {
      const hits = [];
      for (const [name, h] of CSS.highlights) {
        if (!name.startsWith('rsearch-l')) continue;
        for (const r of h) if (r.startContainer.parentElement && r.startContainer.parentElement.id === 'words') hits.push(r.startContainer.data.slice(r.startOffset, r.endOffset));
      }
      return hits;
    });
    assert(JSON.stringify(words) === '["TypeError"]', JSON.stringify(words));
  });

  async function minimapRect(pg) {
    return pg.evaluate(() => {
      const host = document.getElementById('rsearch-minimap');
      if (!host) return null;
      const r = host.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height, parent: host.parentElement.tagName };
    });
  }
  async function markerCount(pg) {
    return pg.evaluate(() => document.querySelectorAll('#rsearch-overlay .rsearch-marker').length);
  }

  await check('floating minimap shown on a long log page, replaces the marker strip', async () => {
    const r = await minimapRect(page);
    assert(r && r.w > 70 && r.w < 100 && r.h > 150, 'minimap rect ' + JSON.stringify(r));
    assert(r.parent === 'HTML', 'parent ' + r.parent);
    assert(r.x + r.w <= 1280 - 10, 'not on the right edge: ' + JSON.stringify(r));
    const markers = await markerCount(page);
    assert(markers === 0, 'markers while minimap expanded: ' + markers);
    return JSON.stringify(r);
  });

  await page.screenshot({ path: path.join(out, '1b-minimap.png') });

  await check('clicking the minimap scrolls the page there', async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    const r = await minimapRect(page);
    await page.mouse.click(r.x + r.w / 2, r.y + r.h * 0.75);
    await sleep(150);
    const y = await page.evaluate(() => ({ y: window.scrollY, max: document.documentElement.scrollHeight - innerHeight }));
    assert(y.y > y.max * 0.4, 'scrollY ' + JSON.stringify(y));
    return JSON.stringify(y);
  });

  await check('collapsing the minimap (global pref) brings the marker strip back', async () => {
    await sw.evaluate(() => chrome.storage.local.set({ rsearch_ui: { minimap: 'collapsed' } }));
    await sleep(300);
    const r = await minimapRect(page);
    const markers = await markerCount(page);
    await page.screenshot({ path: path.join(out, '1c-collapsed.png') });
    await sw.evaluate(() => chrome.storage.local.set({ rsearch_ui: { minimap: 'off' } }));
    await sleep(300);
    const off = await minimapRect(page);
    const markersOff = await markerCount(page);
    await sw.evaluate(() => chrome.storage.local.set({ rsearch_ui: { minimap: 'expanded' } }));
    await sleep(300);
    const back = await minimapRect(page);
    assert(r && r.h < 40 && markers > 10, 'collapsed ' + JSON.stringify(r) + ' markers ' + markers);
    assert(off === null && markersOff > 10, 'off ' + JSON.stringify(off) + ' markers ' + markersOff);
    assert(back && back.h > 150, 'expanded again ' + JSON.stringify(back));
    return `pill=${Math.round(r.w)}x${Math.round(r.h)} markers=${markers}`;
  });

  await check('severity layers: hide critical, jump to critical shows it again', async () => {
    const hid = await msg(logTab, { action: 'toggleLayer', level: 0, visible: false });
    const reg = await page.evaluate(() => ({ l0: CSS.highlights.has('rsearch-l0'), l1: CSS.highlights.has('rsearch-l1') }));
    assert(hid.success && hid.hiddenLevels.includes(0) && !reg.l0 && reg.l1, JSON.stringify({ h: hid.hiddenLevels, reg }));
    const nav = await msg(logTab, { action: 'navigate', direction: 1, level: null });
    const cur = await page.evaluate(() => { for (const r of CSS.highlights.get('rsearch-current')) return r.startContainer.data.slice(r.startOffset, r.endOffset); return null; });
    const back = await msg(logTab, { action: 'navigate', direction: 1, level: 0 });
    const reg2 = await page.evaluate(() => CSS.highlights.has('rsearch-l0'));
    assert(nav.success && back.success && !back.hiddenLevels.includes(0) && reg2, JSON.stringify({ nav: nav.success, back: back.hiddenLevels, reg2 }));
    return 'nav skipped hidden layer, landed on "' + cur + '"';
  });

  await check('minimap renders under a strict page CSP (style-src self, trusted types)', async () => {
    const p = await browser.newPage();
    const errors = [];
    p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await p.goto(base + '/csp.html');
    const id = await tabIdFor('/csp.html');
    await waitState(id, x => x.active && !x.running);
    await sleep(200);
    const r = await minimapRect(p);
    await p.screenshot({ path: path.join(out, '5-csp.png') });
    await p.close();
    assert(r && r.w > 70 && r.w < 100 && r.h > 150, 'minimap under CSP ' + JSON.stringify(r) + ' errors ' + errors.join(' | '));
    return JSON.stringify(r) + (errors.length ? ' console errors: ' + errors.length : '');
  });

  await check('top 3 hotspots are distinct regions', async () => {
    const hs = state.hotspots;
    assert(hs.length === 3, 'hotspots ' + hs.length);
    const pos = hs.map(h => parseInt(h.position, 10));
    assert(new Set(pos).size === 3 || hs.every(h => h.preview), 'positions ' + pos);
    return hs.map(h => `#${h.rank} ${h.position} n=${h.count} L${h.level} "${h.preview.slice(0, 40)}"`).join(' | ');
  });

  await page.screenshot({ path: path.join(out, '1-log-auto.png') });

  await check('navigate next/prev moves current highlight and scrolls', async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    const a = await msg(logTab, { action: 'navigate', direction: 1, level: null });
    assert(a.success && a.cursor >= 0, 'nav1 ' + JSON.stringify({ s: a.success, c: a.cursor }));
    const cur = await page.evaluate(() => CSS.highlights.get('rsearch-current').size);
    assert(cur === 1, 'current size ' + cur);
    const b = await msg(logTab, { action: 'navigate', direction: 1, level: 0 });
    assert(b.success, 'nav critical');
    const y1 = await page.evaluate(() => window.scrollY);
    const c = await msg(logTab, { action: 'navigate', direction: -1, level: null });
    assert(c.cursor === b.cursor - 1 || c.cursor >= 0, 'prev');
    for (let i = 0; i < 30; i++) await msg(logTab, { action: 'navigate', direction: 1, level: 0 });
    const y2 = await page.evaluate(() => window.scrollY);
    assert(y2 > y1, 'did not scroll: ' + y1 + ' -> ' + y2);
    return `cursor=${b.cursor} scrollY ${y1}->${y2}`;
  });

  await check('hotspot jump scrolls inner scroll container to a nested match', async () => {
    // the Segmentation fault line lives inside #scroller (overflow:auto)
    // fresh search resets the cursor so navigation starts from the top of the viewport
    await msg(logTab, { action: 'search', source: 'auto', request: { mode: 'keywords', keywords: await sw.evaluate(() => RSearchCore.DEFAULT_KEYWORDS), ignoreCase: true, smartMatch: true, label: 'Error Keywords' } });
    await page.evaluate(() => { window.scrollTo(0, 0); document.getElementById('scroller').scrollTop = 0; });
    let found = false;
    for (let i = 0; i < 200 && !found; i++) {
      await msg(logTab, { action: 'navigate', direction: 1, level: 0 });
      found = await page.evaluate(() => {
        const r = CSS.highlights.get('rsearch-current');
        for (const range of r) return range.startContainer.parentElement.id === 'deep';
        return false;
      });
    }
    assert(found, 'never reached #deep');
    const st = await page.evaluate(() => document.getElementById('scroller').scrollTop);
    assert(st > 1000, 'inner scroller not scrolled: ' + st);
    return 'scroller.scrollTop=' + st;
  });

  await page.evaluate(() => window.scrollTo(0, 0));
  await check('unique problems: grouped by shape, most severe first, jump to first occurrence', async () => {
    const r = await msg(logTab, { action: 'patterns', maxLevel: 2, limit: 30 });
    assert(r.total > 5 && r.total < 200, 'groups ' + r.total);
    assert(r.patterns[0].level === 0, 'first group level ' + r.patterns[0].level);
    const levels = r.patterns.map(p => p.level);
    assert(levels.every((l, i) => i === 0 || l >= levels[i - 1]), 'not sorted by severity ' + levels);
    const jump = await msg(logTab, { action: 'jumpToPattern', index: 0 });
    assert(jump.success && jump.cursor >= 0, 'jump failed');
    return r.total + ' groups from ' + state.count + ' matches; #1 ' + r.patterns[0].count + 'x "' + r.patterns[0].sample.slice(0, 50) + '"';
  });

  await check('copy error lines returns deduped log lines', async () => {
    const r = await msg(logTab, { action: 'collectLines', maxLevel: 2, limit: 500 });
    assert(r.lines.length > 5, 'lines ' + r.lines.length);
    assert(new Set(r.lines).size === r.lines.length, 'dupes');
    return r.lines.length + ' lines, e.g. "' + r.lines[0].slice(0, 60) + '"';
  });

  await check('badge shows count on the tab', async () => {
    const text = await sw.evaluate(id => chrome.action.getBadgeText({ tabId: id }), logTab);
    assert(text && text.length > 0, 'badge "' + text + '"');
    return 'badge=' + text;
  });

  await check('re-injecting content script does not create a second instance', async () => {
    await sw.evaluate(id => chrome.scripting.executeScript({ target: { tabId: id }, files: ['shared.js', 'content.js'] }), logTab);
    const s = await msg(logTab, { action: 'getState' });
    assert(s.active && s.count === state.count, 'state changed ' + s.count);
  });

  await check('manual custom search then clear removes everything and suppresses auto', async () => {
    const r = await msg(logTab, { action: 'search', source: 'manual', request: { mode: 'keywords', keywords: ['NCCL', 'Xid'], ignoreCase: true, smartMatch: true, label: 'custom' } });
    assert(r.success && r.count > 0 && r.source === 'manual', 'manual ' + JSON.stringify({ c: r.count, s: r.source }));
    await msg(logTab, { action: 'clear' });
    const sizes = await registrySizes(page);
    const total = Object.values(sizes || {}).reduce((a, b) => a + b, 0);
    const markers = await page.evaluate(() => document.querySelectorAll('#rsearch-overlay .rsearch-marker').length);
    const s = await msg(logTab, { action: 'getState' });
    assert(total === 0 && markers === 0 && !s.active && s.autoSuppressed, JSON.stringify({ total, markers, s: s.active, sup: s.autoSuppressed }));
    const badge = await sw.evaluate(id => chrome.action.getBadgeText({ tabId: id }), logTab);
    assert(badge === '', 'badge after clear "' + badge + '"');
  });

  await check('regex search colors by classification', async () => {
    const r = await msg(logTab, { action: 'search', source: 'manual', request: { mode: 'regex', pattern: 'segmentation fault|step=\\d+', flags: 'gi', label: 'Regex' } });
    assert(r.success && r.levels[0] > 0 && r.levels[5] > 0, JSON.stringify(r.levels));
    return JSON.stringify(r.levels);
  });

  // ---------- ignore rules ----------
  await check('passing build summary: nothing highlighted, no badge', async () => {
    const p = await browser.newPage();
    await p.goto(base + '/passing.html');
    const id = await tabIdFor('/passing.html');
    await sleep(800);
    const s = await msg(id, { action: 'getState' });
    const badge = await sw.evaluate(id => chrome.action.getBadgeText({ tabId: id }), id);
    await p.close();
    assert(s.count === 0 && badge === '', 'count ' + s.count + ' badge "' + badge + '" levels ' + JSON.stringify(s.levels));
  });

  // ---------- partial logs ----------
  await check('partial log: Jenkins "Skipping N KB.. Full Log" detected with link; plain mention is not', async () => {
    const p = await browser.newPage();
    await p.goto(base + '/jenkins.html');
    const id = await tabIdFor('/jenkins.html');
    const s = await waitState(id, x => x.active && !x.running);
    const p2 = await browser.newPage();
    await p2.goto(base + '/notpartial.html');
    const id2 = await tabIdFor('/notpartial.html');
    const s2 = await waitState(id2, x => x.active && !x.running);
    await p2.close();
    assert(s.partial && s.partial.source === 'Jenkins' && /\/consoleFull$/.test(s.partial.href), 'partial ' + JSON.stringify(s.partial));
    assert(!s2.partial, 'false positive ' + JSON.stringify(s2.partial));
    // popup shows the notice
    const popup = await browser.newPage();
    await popup.setViewport({ width: 360, height: 900, deviceScaleFactor: 2 });
    await popup.evaluateOnNewDocument(tabId => {
      const orig = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = async q => (q && q.active && q.currentWindow) ? [await chrome.tabs.get(tabId)] : orig(q);
    }, id);
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.waitForFunction(() => !document.getElementById('partialNotice').hidden, { timeout: 8000 });
    await popup.waitForFunction(() => !document.getElementById('patternsBlock').hidden, { timeout: 8000 });
    await sleep(200);
    await popup.screenshot({ path: path.join(out, '7-popup-partial.png'), fullPage: true });
    const text = await popup.evaluate(() => document.getElementById('partialNotice').textContent);
    await popup.close();
    await p.close();
    return text.slice(0, 80);
  });

  // ---------- smart match page ----------
  await check('words page: only TypeError matches', async () => {
    const p = await browser.newPage();
    await p.goto(base + '/words.html');
    const id = await tabIdFor('/words.html');
    const s = await waitState(id, x => x.active && !x.running);
    await p.close();
    assert(s.count === 1, 'count ' + s.count + ' levels ' + JSON.stringify(s.levels));
  });

  // ---------- streaming / live updates ----------
  await check('live: streamed lines and in-place text edits update highlights', async () => {
    const p = await browser.newPage();
    await p.goto(base + '/stream.html');
    const id = await tabIdFor('/stream.html');
    const first = await waitState(id, x => x.active && !x.running);
    await p.waitForFunction(() => window.__streamDone === true, { timeout: 10000 });
    // 5 streamed 'fatal: worker crashed' lines = 10 matches on top of the initial ones
    const after = await waitState(id, x => x.count === first.count + 10, 8000);
    // characterData edit removes a match
    await p.evaluate(() => { document.getElementById('mut').firstChild.data = 'Request ok A'; });
    const edited = await waitState(id, x => x.count === after.count - 1, 5000);
    await p.close();
    return `initial=${first.count} streamed=${after.count} edited=${edited.count}`;
  });

  // ---------- framework safety ----------
  await check('React-style text node reuse keeps working (no DOM breakage)', async () => {
    const p = await browser.newPage();
    await p.goto(base + '/react.html');
    const id = await tabIdFor('/react.html');
    await waitState(id, x => x.active && !x.running && x.count > 0);
    await p.waitForFunction(() => window.__reactOk === true || window.__errors.length > 0, { timeout: 5000 });
    const res = await p.evaluate(() => ({ ok: window.__reactOk, errors: window.__errors, sameHtml: window.__htmlBefore === null || !window.__htmlBefore.includes('rsearch') }));
    const s = await waitState(id, x => x.count >= 2, 5000);
    await p.close();
    assert(res.ok && res.errors.length === 0 && res.sameHtml, JSON.stringify(res));
    return 'count after update=' + s.count;
  });

  // ---------- plain text ----------
  await check('text/plain log file gets highlighted', async () => {
    const p = await browser.newPage();
    await p.goto(base + '/plain.txt');
    const id = await tabIdFor('/plain.txt');
    const s = await waitState(id, x => x.active && !x.running);
    await p.screenshot({ path: path.join(out, '2-plain.png') });
    await p.close();
    assert(s.count > 500, 'count ' + s.count);
    return `count=${s.count} hotspots=${s.hotspots.length}`;
  });

  // ---------- performance ----------
  await check('performance: 50k-line page search latency and long-task measurements', async () => {
    const p = await browser.newPage();
    await p.evaluateOnNewDocument(() => {
      window.__long = [];
      new PerformanceObserver(list => { for (const e of list.getEntries()) window.__long.push(Math.round(e.duration)); }).observe({ type: 'longtask', buffered: true });
    });
    const t0 = Date.now();
    await p.goto(base + '/big.html', { waitUntil: 'load' });
    const loadMs = Date.now() - t0;
    const id = await tabIdFor('/big.html');
    await p.evaluate(() => { window.__long = []; });
    const t1 = Date.now();
    const r = await msg(id, { action: 'search', source: 'manual', request: { mode: 'keywords', keywords: (await sw.evaluate(() => RSearchCore.DEFAULT_KEYWORDS)), ignoreCase: true, smartMatch: true, label: 'perf' } });
    const searchMs = Date.now() - t1;
    const longs = await p.evaluate(() => window.__long.slice());
    await p.close();
    const maxLong = longs.length ? Math.max(...longs) : 0;
    assert(r.success, 'search failed');
    return `page load ${loadMs}ms, search ${searchMs}ms, count=${r.count}, highlighted=${r.highlighted}, truncated=${r.truncated}, long tasks=${longs.length} max=${maxLong}ms`;
  });

  // ---------- per-site pause ----------
  await check('per-site pause: disabled host is not auto-highlighted', async () => {
    await sw.evaluate(() => chrome.storage.local.set({ rsearch_disabled_hosts: ['127.0.0.1'] }));
    const p = await browser.newPage();
    await p.goto(base + '/paused.html');
    const id = await tabIdFor('/paused.html');
    await sleep(1200);
    const s = await msg(id, { action: 'getState' });
    await sw.evaluate(() => chrome.storage.local.set({ rsearch_disabled_hosts: [] }));
    const s2 = await waitState(id, x => x.active && x.count > 0, 5000);
    await p.close();
    assert(!s.active, 'was highlighted while paused');
    return 'resumed count=' + s2.count;
  });

  // ---------- popup UI with live results ----------
  await check('popup renders results for the active tab', async () => {
    const p = await browser.newPage();
    await p.goto(base + '/log.html?popup');
    const id = await tabIdFor('/log.html?popup');
    await waitState(id, x => x.active && !x.running);
    const popup = await browser.newPage();
    await popup.setViewport({ width: 360, height: 760, deviceScaleFactor: 2 });
    await popup.evaluateOnNewDocument(tabId => {
      const orig = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = async q => (q && q.active && q.currentWindow) ? [await chrome.tabs.get(tabId)] : orig(q);
    }, id);
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.waitForFunction(() => !document.getElementById('results').hidden, { timeout: 8000 });
    await sleep(300);
    const info = await popup.evaluate(() => ({
      count: document.getElementById('count').textContent,
      chips: Array.from(document.querySelectorAll('.chip')).map(c => c.textContent),
      hotspots: document.querySelectorAll('.hotspot').length,
      banner: !document.getElementById('accessBanner').hidden,
      footer: document.getElementById('siteName').textContent
    }));
    await popup.click('#nextBtn');
    await sleep(200);
    const pos = await popup.evaluate(() => document.getElementById('navPos').textContent);
    await popup.screenshot({ path: path.join(out, '3-popup.png'), fullPage: true });
    await popup.close();
    await p.close();
    assert(info.hotspots === 3 && info.chips.length >= 3 && !info.banner, JSON.stringify(info));
    return JSON.stringify(info) + ' nav=' + pos;
  });

  await check('popup eye buttons hide layers; navigation skips them and chip clicks restore them', async () => {
    const p = await browser.newPage();
    let popup;
    try {
      await p.goto(base + '/log.html?layers');
      const id = await tabIdFor('/log.html?layers');
      const initial = await waitState(id, x => x.active && !x.running);
      popup = await browser.newPage();
      await popup.setViewport({ width: 360, height: 760, deviceScaleFactor: 2 });
      await popup.evaluateOnNewDocument(tabId => {
        const orig = chrome.tabs.query.bind(chrome.tabs);
        chrome.tabs.query = async q => (q && q.active && q.currentWindow) ? [await chrome.tabs.get(tabId)] : orig(q);
      }, id);
      await popup.goto(`chrome-extension://${extId}/popup.html`);
      await popup.waitForSelector('.chip-eye[aria-label="Hide critical on the page"]');
      await popup.click('.chip-main');
      await popup.waitForFunction(() => !document.getElementById('navPos').textContent.startsWith('–'));
      await popup.click('.chip-eye[aria-label="Hide critical on the page"]');
      await popup.waitForSelector('.chip.off .chip-eye[aria-label="Show critical on the page"]');
      const hidden = await msg(id, { action: 'getState' });
      const registry = await registrySizes(p);
      const currentSize = await p.evaluate(() => CSS.highlights.get('rsearch-current').size);
      assert(hidden.hiddenLevels.includes(0) && !('rsearch-l0' in registry), 'critical is still painted');
      assert(currentSize === 0 && hidden.cursor === -1, 'current highlight survived hiding its layer');
      assert(hidden.count === initial.count, 'hiding a layer changed the match count');
      await popup.click('#nextBtn');
      await popup.waitForFunction(() => !document.getElementById('navPos').textContent.startsWith('–'));
      const current = await p.evaluate(() => {
        const [r] = CSS.highlights.get('rsearch-current');
        return r.startContainer.data.slice(r.startOffset, r.endOffset);
      });
      const level = await sw.evaluate(text => RSearchCore.classifyKeyword(text, 0), current);
      assert(level !== 0, 'next navigated to the hidden critical layer: ' + current);
      await popup.screenshot({ path: path.join(out, '6-popup-layer-hidden.png'), fullPage: true });
      await popup.click('.chip.off .chip-main');
      await popup.waitForSelector('.chip-eye[aria-label="Hide critical on the page"]');
      const restored = await msg(id, { action: 'getState' });
      assert(!restored.hiddenLevels.includes(0), 'chip navigation did not restore critical');
      const painted = await p.evaluate(() => CSS.highlights.has('rsearch-l0'));
      assert(painted, 'restored critical layer is absent from registry');
      // the grouped Other eye must switch notice and all custom colors together
      await popup.click('.chip-eye[aria-label="Hide other on the page"]');
      await popup.waitForSelector('.chip.off .chip-eye[aria-label="Show other on the page"]');
      const otherHidden = await msg(id, { action: 'getState' });
      assert([4, 5, 6, 7].every(l => otherHidden.hiddenLevels.includes(l)), 'Other did not hide every grouped layer');
      // verify keyboard activation as well as mouse clicks
      await popup.focus('.chip-eye[aria-label="Show other on the page"]');
      await popup.keyboard.press('Enter');
      await popup.waitForSelector('.chip-eye[aria-label="Hide other on the page"]');
      const otherShown = await msg(id, { action: 'getState' });
      assert([4, 5, 6, 7].every(l => !otherShown.hiddenLevels.includes(l)), 'Other did not restore every grouped layer');
      await popup.screenshot({ path: path.join(out, '6-popup-layers-restored.png'), fullPage: true });
      return 'critical + Other toggles, hidden navigation, restore by chip, keyboard activation';
    } finally {
      if (popup) await popup.close();
      await p.close();
    }
  });

  // ---------- auto toggle off ----------
  await check('turning auto OFF unregisters and clears auto results', async () => {
    const p = await browser.newPage();
    await p.goto(base + '/words.html');
    const id = await tabIdFor('/words.html');
    await waitState(id, x => x.active && !x.running);
    await sw.evaluate(() => chrome.storage.local.set({ autoSearchEnabled: false }));
    const s = await waitState(id, x => !x.active, 5000);
    await sleep(300);
    const regs = await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts());
    await sw.evaluate(() => chrome.storage.local.set({ autoSearchEnabled: true }));
    await sleep(500);
    const regs2 = await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts());
    await p.close();
    assert(!s.active && regs.length === 0 && regs2.length === 1, JSON.stringify({ a: s.active, r: regs.length, r2: regs2.length }));
  });

  // ---------- migration ----------
  await check('migration upgrades an untouched 3.4.0 default preset only', async () => {
    const oldKw = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'keywords-v3.4.0.json'), 'utf8'));
    const lines = ['rank,key_word']; oldKw.forEach((k, i) => lines.push((i + 1) + ',' + k));
    const r = await sw.evaluate(async (legacy) => {
      await chrome.storage.local.clear();
      await chrome.storage.local.set({ rsearch_presets_v2: [{ name: 'My Errors', csv: legacy }, { name: 'B', csv: 'rank,key_word\n1,foo' }, { name: 'C', csv: 'rank,key_word' }], autoSearchEnabled: false });
      await migrateStorage();
      const s = await chrome.storage.local.get(null);
      return { upgraded: s.rsearch_presets_v2[0].csv === RSearchCore.DEFAULT_PRESET_CSV, name: s.rsearch_presets_v2[0].name, other: s.rsearch_presets_v2[1].csv, auto: s.autoSearchEnabled };
    }, lines.join('\n'));
    assert(r.upgraded && r.name === 'My Errors' && r.other === 'rank,key_word\n1,foo' && r.auto === false, JSON.stringify(r));
  });
} finally {
  await browser.close();
}

// ---------- real manifest: optional permission not granted ----------
await check('without "Allow": no registration, defaults ON, banner shown, page untouched', async () => {
  const plain = await puppeteer.launch({ executablePath: CHROME, headless: true, pipe: true, enableExtensions: [repo] });
  try {
    const swT = await plain.waitForTarget(t => t.type() === 'service_worker' && t.url().endsWith('/background.js'), { timeout: 15000 });
    const sw2 = await swT.worker();
    const id2 = new URL(swT.url()).host;
    await sleep(800);
    const p = await plain.newPage();
    await p.goto(base + '/words.html');
    await sleep(800);
    const r = await sw2.evaluate(async () => ({
      access: await chrome.permissions.contains({ origins: ['<all_urls>'] }),
      regs: (await chrome.scripting.getRegisteredContentScripts()).length,
      auto: (await chrome.storage.local.get('autoSearchEnabled')).autoSearchEnabled
    }));
    const painted = await p.evaluate(() => CSS.highlights.size);
    const tabId = await sw2.evaluate(async () => (await chrome.tabs.query({})).find(t => t.url.includes('/words.html')).id);
    const popup = await plain.newPage();
    await popup.evaluateOnNewDocument(t => {
      const orig = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = async q => (q && q.active && q.currentWindow) ? [await chrome.tabs.get(t)] : orig(q);
    }, tabId);
    await popup.goto(`chrome-extension://${id2}/popup.html`);
    await sleep(600);
    const banner = await popup.evaluate(() => !document.getElementById('accessBanner').hidden);
    assert(!r.access && r.regs === 0 && r.auto === true && painted === 0 && banner, JSON.stringify({ ...r, painted, banner }));
  } finally {
    await plain.close();
  }
});

server.close();

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'ALL PASSED'));
process.exit(failures ? 1 : 0);
