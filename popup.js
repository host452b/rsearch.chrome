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
    const count = Core.parseCsvToKeywords(preset.csv).length;
    option.textContent = preset.name + ' · ' + count + (count === 1 ? ' keyword' : ' keywords');
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

  ui.navPos.textContent = (summary.cursor >= 0 ? fmt(summary.cursor + 1) : '–') + ' / ' + fmt(summary.visibleCount);
  ui.prevBtn.disabled = summary.visibleCount === 0;
  ui.nextBtn.disabled = summary.visibleCount === 0;
  ui.copyBtn.disabled = summary.visibleCount === 0;

  // severity chips: click jumps to the next match of that severity
  ui.chips.textContent = '';
  const levels = summary.levels || [];
  for (const group of CHIP_GROUPS) {
    const count = group.level === 'other'
      ? levels.slice(4).reduce((a, b) => a + b, 0)
      : (levels[group.level] || 0);
    if (count === 0) continue;
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.title = 'Jump to next ' + group.label.toLowerCase() + ' match';
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = Core.LEVELS[group.level === 'other' ? 4 : group.level].bg;
    const num = document.createElement('b');
    num.textContent = fmt(count);
    chip.append(dot, num, document.createTextNode(group.label));
    chip.addEventListener('click', () => navigate(1, group.level));
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
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = Core.LEVELS[spot.level].bg;
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

async function copyErrorLines() {
  try {
    const response = await sendToTab({ action: 'collectLines', maxLevel: 2, limit: 500 });
    const lines = (response && response.lines) || [];
    if (lines.length === 0) {
      showStatus('Nothing to copy.', 'info');
      return;
    }
    await navigator.clipboard.writeText(lines.join('\n'));
    showStatus('Copied ' + fmt(lines.length) + (lines.length === 1 ? ' line' : ' lines') + ' to the clipboard.', 'success');
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
