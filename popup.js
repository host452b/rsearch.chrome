// RSearch popup.
const Core = window.RSearchCore;
const $ = id => document.getElementById(id);

const ui = {
  autoToggle: $('autoToggle'),
  accessBanner: $('accessBanner'),
  grantBtn: $('grantBtn'),
  pageNotice: $('pageNotice'),
  keywordMode: $('keywordMode'),
  regexMode: $('regexMode'),
  presetRow: $('presetRow'),
  presetSelect: $('presetSelect'),
  editBtn: $('editBtn'),
  editor: $('editor'),
  presetName: $('presetName'),
  csvText: $('csvText'),
  saveCsvBtn: $('saveCsvBtn'),
  resetCsvBtn: $('resetCsvBtn'),
  pattern: $('pattern'),
  ignoreCase: $('ignoreCase'),
  smartMatch: $('smartMatch'),
  smartLabel: $('smartLabel'),
  findAll: $('findAll'),
  minimapToggle: $('minimapToggle'),
  findAllLabel: $('findAllLabel'),
  searchBtn: $('searchBtn'),
  clearBtn: $('clearBtn'),
  status: $('status'),
  results: $('results'),
  count: $('count'),
  meta: $('meta'),
  chips: $('chips'),
  navPos: $('navPos'),
  prevBtn: $('prevBtn'),
  nextBtn: $('nextBtn'),
  hotspotsBlock: $('hotspotsBlock'),
  partialNotice: $('partialNotice'),
  patternsBlock: $('patternsBlock'),
  patternsTitle: $('patternsTitle'),
  patterns: $('patterns'),
  patternsMore: $('patternsMore'),
  hotspots: $('hotspots'),
  copyBtn: $('copyBtn'),
  footer: $('footer'),
  siteName: $('siteName'),
  siteToggle: $('siteToggle')
};

const PAGE_SCRIPTS = ['shared.js', 'content.js'];

let settings = null;
let tab = null;
let host = '';
let pageState = 'ok';     // 'ok' | 'restricted' | 'file-blocked' | 'none'
let hasAccess = false;
let busy = false;
let statusTimer = null;
let searchToken = 0;

// ============================================================
// STATUS
// ============================================================

function showStatus(message, type) {
  clearTimeout(statusTimer);
  ui.status.textContent = message;
  ui.status.className = type || '';
  ui.status.hidden = false;
  if (type === 'success') {
    statusTimer = setTimeout(() => { ui.status.hidden = true; }, 4000);
  }
}

function hideStatus() {
  clearTimeout(statusTimer);
  ui.status.hidden = true;
}

function setBusy(value) {
  busy = value;
  ui.searchBtn.disabled = value;
  ui.searchBtn.textContent = value ? 'Searching…' : 'Search';
}

function fmt(n) {
  return Number(n || 0).toLocaleString('en-US');
}

// dot that mirrors how a level is painted on the page (solid / tint / underline)
function levelDot(level) {
  const meta = Core.LEVELS[level];
  const dot = document.createElement('span');
  dot.className = 'dot';
  if (meta.style === 'solid') {
    dot.style.background = meta.bg;
  } else if (meta.style === 'tint') {
    const n = parseInt(meta.bg.slice(1), 16);
    dot.style.background = `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, 0.35)`;
    dot.style.boxShadow = `inset 0 0 0 1px ${meta.bg}`;
  } else {
    dot.style.borderRadius = '0';
    dot.style.height = '6px';
    dot.style.borderBottom = `2px ${meta.style === 'dotted' ? 'dotted' : 'solid'} ${meta.bg}`;
  }
  return dot;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function eyeIcon(open) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  const eye = document.createElementNS(SVG_NS, 'path');
  eye.setAttribute('d', 'M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z');
  const pupil = document.createElementNS(SVG_NS, 'circle');
  pupil.setAttribute('cx', '8');
  pupil.setAttribute('cy', '8');
  pupil.setAttribute('r', '2');
  svg.append(eye, pupil);
  if (!open) {
    const slash = document.createElementNS(SVG_NS, 'path');
    slash.setAttribute('d', 'M2.5 13.5l11-11');
    svg.append(slash);
  }
  return svg;
}

// ============================================================
// SETTINGS
// ============================================================

async function saveSettings(partial) {
  await chrome.storage.local.set(partial);
}

function activePreset() {
  return settings.presets[settings.activePresetIndex];
}

function siteDisabled() {
  return settings.disabledHosts.includes(host);
}

function renderPresetSelect() {
  ui.presetSelect.textContent = '';
  settings.presets.forEach((preset, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    const counts = Core.countRules(Core.parseCsvToKeywords(preset.csv));
    option.textContent = preset.name + ' · ' + counts.keywords + (counts.keywords === 1 ? ' keyword' : ' keywords') +
      (counts.ignores ? ' · ' + counts.ignores + ' ignored' : '');
    ui.presetSelect.appendChild(option);
  });
  ui.presetSelect.value = String(settings.activePresetIndex);
}

function renderPlaceholder() {
  if (ui.regexMode.checked) {
    ui.pattern.placeholder = 'Regular expression, e.g. \\b(ERROR|FATAL)\\b';
  } else {
    ui.pattern.placeholder = 'Leave empty for preset, or type: oom, xid';
  }
}

function renderModeUI() {
  const regex = ui.regexMode.checked;
  ui.presetRow.hidden = regex;
  ui.editor.hidden = regex || ui.editor.hidden;
  ui.smartLabel.hidden = regex;
  ui.findAllLabel.hidden = !regex;
  ui.editBtn.textContent = ui.editor.hidden ? 'Edit' : 'Done';
  renderPlaceholder();
}

function renderAccessUI() {
  ui.autoToggle.checked = settings.autoEnabled;
  ui.accessBanner.hidden = !(settings.autoEnabled && !hasAccess);

  const showFooter = pageState === 'ok' && settings.autoEnabled && !!host;
  ui.footer.hidden = !showFooter;
  if (showFooter) {
    ui.siteName.textContent = host === 'file://' ? 'Local files' : host;
    ui.siteName.title = host;
    ui.siteToggle.checked = !siteDisabled();
  }
}

function renderPageNotice() {
  ui.pageNotice.textContent = '';
  if (pageState === 'ok') {
    ui.pageNotice.hidden = true;
    return;
  }
  ui.pageNotice.hidden = false;
  if (pageState === 'file-blocked') {
    ui.pageNotice.append('To search local files, turn on "Allow access to file URLs" for RSearch.');
    const button = document.createElement('button');
    button.className = 'btn-secondary';
    button.textContent = 'Open extension settings';
    button.addEventListener('click', () => {
      chrome.tabs.create({ url: 'chrome://extensions/?id=' + chrome.runtime.id });
    });
    ui.pageNotice.append(document.createElement('br'), button);
  } else {
    ui.pageNotice.textContent = 'RSearch can\'t run on this page. Chrome blocks extensions on its own pages and the Web Store.';
  }
  ui.searchBtn.disabled = true;
  ui.clearBtn.disabled = true;
}

// ============================================================
// RESULTS
// ============================================================

const CHIP_GROUPS = [
  { level: 0, label: 'Critical' },
  { level: 1, label: 'Error' },
  { level: 2, label: 'Problem' },
  { level: 3, label: 'Warning' },
  { level: 'other', label: 'Other' }
];

function renderResults(summary) {
  if (!summary || !summary.active) {
    ui.results.hidden = true;
    lastPatternsAt = 0;
    return;
  }
  ui.results.hidden = false;
  ui.count.textContent = fmt(summary.count);

  const meta = [];
  if (summary.label) meta.push(summary.mode === 'keywords' && summary.source === 'auto' ? 'Preset: ' + summary.label : summary.label);
  if (summary.truncated) meta.push('first ' + fmt(summary.maxHighlights) + ' highlighted');
  const hidden = summary.highlighted - summary.visibleCount;
  if (hidden > 0) meta.push(fmt(hidden) + ' hidden on page');
  if (summary.running) meta.push('scanning…');
  ui.meta.textContent = meta.join(' · ');

  renderPartial(summary.partial);
  requestPatterns(false);

  ui.navPos.textContent = (summary.cursor >= 0 ? fmt(summary.cursor + 1) : '–') + ' / ' + fmt(summary.visibleCount);
  ui.prevBtn.disabled = summary.visibleCount === 0;
  ui.nextBtn.disabled = summary.visibleCount === 0;
  ui.copyBtn.disabled = summary.visibleCount === 0;

  // severity chips: click jumps to the next match of that severity,
  // the eye shows / hides that layer on the page
  ui.chips.textContent = '';
  const levels = summary.levels || [];
  const hiddenLayers = new Set(summary.hiddenLevels || []);
  for (const group of CHIP_GROUPS) {
    const groupLevels = group.level === 'other' ? [4, 5, 6, 7] : [group.level];
    const count = groupLevels.reduce((a, l) => a + (levels[l] || 0), 0);
    if (count === 0) continue;
    const off = groupLevels.every(l => hiddenLayers.has(l));
    const firstLevel = groupLevels.find(l => (levels[l] || 0) > 0);

    const chip = document.createElement('span');
    chip.className = 'chip' + (off ? ' off' : '');
    const main = document.createElement('button');
    main.className = 'chip-main';
    main.title = off ? 'Hidden on the page. Click to show and jump to the next match' : 'Jump to next ' + group.label.toLowerCase() + ' match';
    const num = document.createElement('b');
    num.textContent = fmt(count);
    main.append(levelDot(firstLevel), num, document.createTextNode(group.label));
    main.addEventListener('click', () => navigate(1, group.level));

    const eye = document.createElement('button');
    eye.className = 'chip-eye';
    eye.title = off ? 'Show ' + group.label.toLowerCase() + ' on the page' : 'Hide ' + group.label.toLowerCase() + ' on the page';
    eye.setAttribute('aria-label', eye.title);
    eye.append(eyeIcon(!off));
    eye.addEventListener('click', () => toggleLayer(group.level, off));

    chip.append(main, eye);
    ui.chips.appendChild(chip);
  }

  ui.hotspots.textContent = '';
  const hotspots = summary.hotspots || [];
  ui.hotspotsBlock.hidden = hotspots.length === 0;
  for (const spot of hotspots) {
    const item = document.createElement('button');
    item.className = 'hotspot';
    item.title = 'Jump to this area';

    const top = document.createElement('div');
    top.className = 'hotspot-top';
    const rank = document.createElement('span');
    rank.className = 'hotspot-rank';
    rank.textContent = '#' + spot.rank;
    const dot = levelDot(spot.level);
    const info = document.createElement('span');
    info.textContent = spot.position + ' down · ' + fmt(spot.count) + (spot.count === 1 ? ' match' : ' matches');
    top.append(rank, dot, info);

    const preview = document.createElement('div');
    preview.className = 'hotspot-preview';
    preview.textContent = spot.preview || '…';

    item.append(top, preview);
    item.addEventListener('click', () => sendToTab({ action: 'scrollToHotspot', areaIndex: spot.areaIndex }).then(renderResults).catch(() => {}));
    ui.hotspots.appendChild(item);
  }
}

// ============================================================
// TAB MESSAGING
// ============================================================

function sendToTab(message) {
  return chrome.tabs.sendMessage(tab.id, message);
}

async function contentState() {
  try {
    return await sendToTab({ action: 'getState' });
  } catch (e) {
    return null; // no content script yet
  }
}

async function ensureContent() {
  const alive = await sendToTab({ action: 'ping' }).then(r => !!(r && r.ok)).catch(() => false);
  if (alive) return;
  await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['styles.css'] });
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: PAGE_SCRIPTS });
}

function friendlyError(error) {
  const message = (error && error.message) || String(error);
  if (/Cannot access|chrome:\/\/|cannot be scripted|extensions gallery/i.test(message)) {
    return 'RSearch can\'t run on this page.';
  }
  if (/file:\/\//i.test(message)) {
    return 'Allow access to file URLs for RSearch to search local files.';
  }
  if (/Receiving end does not exist|Could not establish connection/i.test(message)) {
    return 'The page is still loading. Try again in a moment.';
  }
  return message;
}

// ============================================================
// SEARCH
// ============================================================

function buildRequest() {
  const text = ui.pattern.value.trim();
  if (ui.regexMode.checked) {
    if (!text) return { error: 'Enter a regular expression.' };
    const flags = (ui.ignoreCase.checked ? 'i' : '') + (ui.findAll.checked ? 'g' : '');
    try {
      new RegExp(text, flags);
    } catch (e) {
      return { error: 'Invalid regex: ' + e.message };
    }
    return { source: 'manual', request: { mode: 'regex', pattern: text, flags, label: 'Regex' } };
  }

  const options = { ignoreCase: ui.ignoreCase.checked, smartMatch: ui.smartMatch.checked };
  if (text) {
    const keywords = Core.parseKeywordInput(text);
    return {
      source: 'manual',
      request: Object.assign({ mode: 'keywords', keywords, label: keywords.length + ' custom keyword' + (keywords.length === 1 ? '' : 's') }, options)
    };
  }

  const keywords = Core.getActiveKeywords(settings);
  if (keywords.length === 0) {
    return { error: 'Preset "' + activePreset().name + '" is empty. Click Edit to add keywords.' };
  }
  // preset searches follow the auto settings (preset / option changes re-run them)
  return { source: 'auto', request: Object.assign({ mode: 'keywords', keywords, label: activePreset().name }, options) };
}

async function runSearch() {
  if (pageState !== 'ok') return;
  const built = buildRequest();
  if (built.error) {
    showStatus(built.error, 'error');
    return;
  }

  const token = ++searchToken;
  setBusy(true);
  showStatus('Searching…', 'progress');
  try {
    await ensureContent();
    const response = await sendToTab({ action: 'search', request: built.request, source: built.source });
    if (token !== searchToken) return;
    if (!response || response.aborted) {
      // replaced by a newer search; its results arrive via resultsUpdated
      return;
    }
    if (response.success) {
      renderResults(response);
      requestPatterns(true);
      if (response.count === 0) {
        showStatus('No matches on this page.', 'info');
      } else {
        showStatus('Found ' + fmt(response.count) + (response.count === 1 ? ' match' : ' matches'), 'success');
      }
    } else {
      renderResults(null);
      showStatus(response.error || 'Search failed.', 'error');
    }
  } catch (error) {
    if (token === searchToken) showStatus(friendlyError(error), 'error');
  } finally {
    if (token === searchToken) setBusy(false);
  }
}

async function clearPage(silent) {
  if (pageState !== 'ok') return;
  searchToken++;
  setBusy(false);
  try {
    const state = await contentState();
    if (state) await sendToTab({ action: 'clear' });
    renderResults(null);
    if (!silent) {
      showStatus(settings.autoEnabled
        ? 'Cleared. Search or reload the page to highlight again.'
        : 'Highlights cleared.', 'success');
    }
  } catch (error) {
    showStatus(friendlyError(error), 'error');
  }
}

async function navigate(direction, level) {
  try {
    const response = await sendToTab({ action: 'navigate', direction, level: level === undefined ? null : level });
    renderResults(response);
    if (response && !response.success && level !== null && level !== undefined) {
      showStatus('No visible matches of that severity.', 'info');
    }
  } catch (error) {
    showStatus(friendlyError(error), 'error');
  }
}

// CI pages that show only the tail of a long log
function renderPartial(partial) {
  ui.partialNotice.textContent = '';
  ui.partialNotice.hidden = !partial;
  if (!partial) return;
  const title = document.createElement('strong');
  title.textContent = 'Partial log. ';
  const where = partial.source ? partial.source + ' shows only part of this log' : 'This page shows only part of the log';
  ui.partialNotice.append(title, document.createTextNode(where + ': earlier errors, often the root cause, are not on the page.'));
  if (partial.href) {
    const open = document.createElement('button');
    open.className = 'btn-secondary';
    open.textContent = 'Open full log';
    open.addEventListener('click', () => chrome.tabs.create({ url: partial.href, index: tab.index + 1 }));
    ui.partialNotice.append(document.createElement('br'), open);
  } else {
    ui.partialNotice.append(' Download the full log from the page menu.');
  }
}

// unique problems: grouped by shape, most severe and earliest first
let lastPatternsAt = 0;
let patternsExpanded = false;
let patternsPending = false;

async function requestPatterns(force) {
  const now = Date.now();
  if (patternsPending || (!force && now - lastPatternsAt < 3000)) return;
  patternsPending = true;
  lastPatternsAt = now;
  try {
    const response = await sendToTab({ action: 'patterns', maxLevel: 2, limit: 30 });
    renderPatterns(response);
  } catch (error) {
    ui.patternsBlock.hidden = true;
  } finally {
    patternsPending = false;
  }
}

function renderPatterns(response) {
  const list = (response && response.patterns) || [];
  ui.patterns.textContent = '';
  ui.patternsBlock.hidden = list.length === 0;
  if (list.length === 0) return;
  const total = response.total || list.length;
  ui.patternsTitle.textContent = 'Unique problems · ' + fmt(total);
  const shown = patternsExpanded ? list : list.slice(0, 5);
  for (const p of shown) {
    const item = document.createElement('button');
    item.className = 'pattern';
    item.title = 'Jump to the first occurrence (' + p.position + ' down)\n' + p.sample;
    const count = document.createElement('span');
    count.className = 'pattern-count';
    count.textContent = Core.formatCount(p.count) + '\u00d7';
    const text = document.createElement('span');
    text.className = 'pattern-text';
    text.textContent = p.sample;
    item.append(levelDot(p.level), count, text);
    item.addEventListener('click', () => sendToTab({ action: 'jumpToPattern', index: p.index }).then(renderResults).catch(() => {}));
    ui.patterns.appendChild(item);
  }
  const hiddenCount = Math.min(total, list.length) - shown.length;
  ui.patternsMore.hidden = !patternsExpanded && hiddenCount <= 0;
  ui.patternsMore.textContent = patternsExpanded ? 'Show fewer' : 'Show ' + hiddenCount + ' more';
}

ui.patternsMore.addEventListener('click', () => {
  patternsExpanded = !patternsExpanded;
  requestPatterns(true);
});

async function toggleLayer(level, visible) {
  try {
    renderResults(await sendToTab({ action: 'toggleLayer', level, visible }));
  } catch (error) {
    showStatus(friendlyError(error), 'error');
  }
}

async function copyErrorLines() {
  try {
    const response = await sendToTab({ action: 'patterns', maxLevel: 2, limit: 200 });
    const list = (response && response.patterns) || [];
    if (list.length === 0) {
      showStatus('No critical, error or problem lines to copy.', 'info');
      return;
    }
    const total = response.total || list.length;
    const lines = ['RSearch \u00b7 ' + total + ' unique problem' + (total === 1 ? '' : 's') + ' \u00b7 ' + tab.url];
    for (const p of list) {
      lines.push('[' + Core.LEVELS[p.level].id + '] ' + p.count + '\u00d7  ' + p.sample);
    }
    if (total > list.length) lines.push('\u2026 ' + (total - list.length) + ' more');
    await navigator.clipboard.writeText(lines.join('\n'));
    showStatus('Copied ' + fmt(list.length) + ' unique problem' + (list.length === 1 ? '' : 's') + ' to the clipboard.', 'success');
  } catch (error) {
    showStatus('Copy failed: ' + friendlyError(error), 'error');
  }
}

// a preset change should refresh what the page shows (custom keyword
// searches typed into the input are left alone)
function rerunIfPresetSearch() {
  if (pageState !== 'ok' || ui.regexMode.checked || ui.pattern.value.trim()) return;
  runSearch();
}

// ============================================================
// EVENTS
// ============================================================

ui.autoToggle.addEventListener('change', async () => {
  const on = ui.autoToggle.checked;
  settings.autoEnabled = on;
  // start the write before the permission prompt: the prompt can close the popup
  const saving = saveSettings({ [Core.STORAGE.autoEnabled]: on });
  let accessRequest = null;
  if (on && !hasAccess) {
    // must be called synchronously inside the click gesture
    accessRequest = chrome.permissions.request(Core.HOST_PERMISSION).catch(() => false);
  }
  await saving;
  if (accessRequest) hasAccess = await accessRequest;
  renderAccessUI();

  if (on) {
    showStatus(hasAccess ? 'Auto-highlight is on for every page.' : 'Auto-highlight is on. Allow access to all sites to run it without opening RSearch.', hasAccess ? 'success' : 'info');
    if (!siteDisabled()) runSearch();
  } else {
    await clearPage(true);
    showStatus('Auto-highlight is off. Use Search to highlight on demand.', 'info');
  }
});

ui.grantBtn.addEventListener('click', async () => {
  hasAccess = await chrome.permissions.request(Core.HOST_PERMISSION).catch(() => false);
  renderAccessUI();
  showStatus(hasAccess ? 'Done. Every page you open will be highlighted.' : 'Access not granted. Auto-highlight runs when you open RSearch.', hasAccess ? 'success' : 'info');
});

ui.siteToggle.addEventListener('change', async () => {
  const enabled = ui.siteToggle.checked;
  const set = new Set(settings.disabledHosts);
  if (enabled) set.delete(host);
  else set.add(host);
  settings.disabledHosts = Array.from(set);
  await saveSettings({ [Core.STORAGE.disabledHosts]: settings.disabledHosts });
  if (enabled) {
    runSearch();
  } else {
    await clearPage(true);
    showStatus('Auto-highlight paused on ' + host + '. Search still works here.', 'info');
  }
});

ui.keywordMode.addEventListener('change', renderModeUI);
ui.regexMode.addEventListener('change', () => {
  renderModeUI();
  ui.pattern.focus();
});

ui.presetSelect.addEventListener('change', async () => {
  settings.activePresetIndex = parseInt(ui.presetSelect.value, 10);
  await saveSettings({ [Core.STORAGE.activePreset]: settings.activePresetIndex });
  if (!ui.editor.hidden) loadEditor();
  renderPlaceholder();
  rerunIfPresetSearch();
});

function loadEditor() {
  const preset = activePreset();
  ui.presetName.value = preset.name;
  ui.csvText.value = preset.csv;
}

ui.editBtn.addEventListener('click', () => {
  const opening = ui.editor.hidden;
  if (opening) loadEditor();
  ui.editor.hidden = !opening;
  ui.editBtn.textContent = opening ? 'Done' : 'Edit';
  if (opening) ui.csvText.focus();
});

ui.saveCsvBtn.addEventListener('click', async () => {
  const csv = ui.csvText.value;
  const keywords = Core.parseCsvToKeywords(csv);
  if (keywords.length === 0 && csv.trim() !== Core.EMPTY_CSV) {
    showStatus('No keywords found. Use one "rank,keyword" per line.', 'error');
    return;
  }
  const lines = csv.trim().split('\n').filter(l => /^\s*\d+\s*,/.test(l)).length;
  const name = ui.presetName.value.trim() || activePreset().name;
  settings.presets[settings.activePresetIndex] = { name, csv };
  await saveSettings({ [Core.STORAGE.presets]: settings.presets });
  renderPresetSelect();
  renderPlaceholder();
  const capped = lines > Core.MAX_KEYWORDS ? ' (only the first ' + Core.MAX_KEYWORDS + ' by rank are used)' : '';
  showStatus('Saved ' + keywords.length + ' keywords' + capped + '.', capped ? 'info' : 'success');
  rerunIfPresetSearch();
});

ui.resetCsvBtn.addEventListener('click', async () => {
  const defaults = Core.getDefaultPresets();
  const fallback = defaults[settings.activePresetIndex] || { name: 'Custom', csv: Core.EMPTY_CSV };
  settings.presets[settings.activePresetIndex] = Object.assign({}, fallback);
  await saveSettings({ [Core.STORAGE.presets]: settings.presets });
  loadEditor();
  renderPresetSelect();
  renderPlaceholder();
  showStatus('Restored the default keywords.', 'success');
  rerunIfPresetSearch();
});

async function onOptionChange() {
  settings.options = { ignoreCase: ui.ignoreCase.checked, smartMatch: ui.smartMatch.checked };
  await saveSettings({ [Core.STORAGE.options]: settings.options });
  if (!ui.results.hidden) runSearch();
}
ui.ignoreCase.addEventListener('change', onOptionChange);
ui.smartMatch.addEventListener('change', onOptionChange);
ui.findAll.addEventListener('change', () => { if (!ui.results.hidden && ui.regexMode.checked) runSearch(); });
ui.minimapToggle.addEventListener('change', async () => {
  settings.ui = Object.assign({}, settings.ui, { minimap: ui.minimapToggle.checked ? 'expanded' : 'off' });
  await saveSettings({ [Core.STORAGE.ui]: settings.ui });
});

ui.searchBtn.addEventListener('click', runSearch);
ui.clearBtn.addEventListener('click', () => clearPage(false));
ui.prevBtn.addEventListener('click', () => navigate(-1));
ui.nextBtn.addEventListener('click', () => navigate(1));
ui.copyBtn.addEventListener('click', copyErrorLines);

ui.pattern.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    runSearch();
  }
});

// j/k or arrow keys step through matches when not typing
document.addEventListener('keydown', event => {
  const target = event.target;
  const typing = target && (target.tagName === 'INPUT' && target.type === 'text' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');
  if (typing || ui.results.hidden || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === 'ArrowDown' || event.key === 'j') {
    event.preventDefault();
    navigate(1);
  } else if (event.key === 'ArrowUp' || event.key === 'k') {
    event.preventDefault();
    navigate(-1);
  }
});

// progress + live updates from the content script of this tab
chrome.runtime.onMessage.addListener((message, sender) => {
  if (!tab || !sender.tab || sender.tab.id !== tab.id) return false;
  if (message.action === 'searchProgress') {
    let text = 'Searching… ' + message.percent + '% · ' + fmt(message.matches) + ' matches';
    if (message.estimatedSeconds > 0 && message.estimatedSeconds < 999) text += ' · ~' + message.estimatedSeconds + 's left';
    showStatus(text, 'progress');
  } else if (message.action === 'resultsUpdated') {
    renderResults(message.summary);
    if (!busy && message.summary && message.summary.active && !message.summary.running && ui.status.className === 'progress') {
      hideStatus();
    }
  }
  return false;
});

// ============================================================
// INIT
// ============================================================

async function detectPageState() {
  if (!tab || !tab.url) return 'none';
  if (Core.isRestrictedUrl(tab.url)) return 'restricted';
  if (tab.url.startsWith('file:')) {
    const allowed = await chrome.extension.isAllowedFileSchemeAccess().catch(() => true);
    if (!allowed) return 'file-blocked';
  }
  return 'ok';
}

async function init() {
  settings = await Core.loadSettings();
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  host = tab && tab.url ? Core.hostFromUrl(tab.url) : '';
  pageState = await detectPageState();
  hasAccess = await chrome.permissions.contains(Core.HOST_PERMISSION).catch(() => false);

  ui.ignoreCase.checked = settings.options.ignoreCase;
  ui.smartMatch.checked = settings.options.smartMatch;
  ui.minimapToggle.checked = settings.ui.minimap !== 'off';
  renderPresetSelect();
  renderModeUI();
  renderAccessUI();
  renderPageNotice();
  if (pageState !== 'ok') return;

  const state = await contentState();
  if (state && state.active) {
    // auto-highlight already ran on this page: show results instantly
    renderResults(state);
    if (state.running) showStatus('Searching…', 'progress');
    return;
  }
  if (state && state.autoSuppressed) {
    showStatus('Highlights were cleared on this page. Press Search to show them again.', 'info');
    return;
  }
  if (settings.autoEnabled && !siteDisabled()) {
    // no host access yet, or the page loaded before RSearch was enabled
    runSearch();
  }
}

init().catch(error => showStatus(friendlyError(error), 'error'));
