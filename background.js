// RSearch service worker.
// - migrates settings and seeds defaults (auto-highlight ON by default)
// - keeps the always-on content script registered while auto-highlight is
//   on AND the user granted the optional all-sites host permission
// - shows the per-tab match count on the toolbar badge
importScripts('shared.js');

const Core = self.RSearchCore;
const AUTO_SCRIPT_ID = 'rsearch-auto';
const PAGE_SCRIPTS = ['shared.js', 'content.js'];
const PAGE_STYLES = ['styles.css'];

// ============================================================
// SETTINGS MIGRATION
// ============================================================

async function migrateStorage() {
  const raw = await chrome.storage.local.get(Core.STORAGE_KEYS);
  const updates = {};

  const presets = raw[Core.STORAGE.presets];
  if (!Array.isArray(presets) || presets.length === 0) {
    updates[Core.STORAGE.presets] = Core.getDefaultPresets();
  } else if (presets[0] && Core.isLegacyDefaultCsv(presets[0].csv)) {
    // default list never edited by the user: upgrade it to the new keywords
    const next = presets.slice();
    next[0] = Object.assign({}, presets[0], { csv: Core.DEFAULT_PRESET_CSV });
    updates[Core.STORAGE.presets] = next;
  }

  // auto-highlight defaults to ON; an explicit OFF from the user is kept
  if (typeof raw[Core.STORAGE.autoEnabled] !== 'boolean') {
    updates[Core.STORAGE.autoEnabled] = true;
  }
  if (!raw[Core.STORAGE.options] || typeof raw[Core.STORAGE.options] !== 'object') {
    updates[Core.STORAGE.options] = Object.assign({}, Core.DEFAULT_OPTIONS);
  }
  if (raw[Core.STORAGE.defaultsVersion] !== Core.DEFAULTS_VERSION) {
    updates[Core.STORAGE.defaultsVersion] = Core.DEFAULTS_VERSION;
  }

  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }
}

// ============================================================
// ALWAYS-ON REGISTRATION
// ============================================================

async function hasHostAccess() {
  try {
    return await chrome.permissions.contains(Core.HOST_PERMISSION);
  } catch (e) {
    return false;
  }
}

async function applyAutoRegistration(forceRefresh) {
  const settings = await Core.loadSettings();
  const wanted = settings.autoEnabled && await hasHostAccess();
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [AUTO_SCRIPT_ID] });

  if (existing.length > 0 && (!wanted || forceRefresh)) {
    await chrome.scripting.unregisterContentScripts({ ids: [AUTO_SCRIPT_ID] });
  }
  if (wanted && (existing.length === 0 || forceRefresh)) {
    await chrome.scripting.registerContentScripts([{
      id: AUTO_SCRIPT_ID,
      matches: ['<all_urls>'],
      js: PAGE_SCRIPTS,
      css: PAGE_STYLES,
      runAt: 'document_idle',
      allFrames: false,
      persistAcrossSessions: true
    }]);
  }
  return wanted;
}

// serialize: storage + permission events can fire together
let syncChain = Promise.resolve(false);
function syncAutoRegistration(forceRefresh) {
  syncChain = syncChain
    .catch(() => false)
    .then(() => applyAutoRegistration(forceRefresh))
    .catch(error => {
      console.warn('RSearch: could not update auto-highlight registration', error);
      return false;
    });
  return syncChain;
}

// pages loaded before access was granted (or before an extension update)
// have no live content script; give one to the tabs the user is looking at
async function ensureInjected(tabId) {
  const alive = await chrome.tabs.sendMessage(tabId, { action: 'ping' })
    .then(response => !!(response && response.ok))
    .catch(() => false);
  if (alive) return;
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: PAGE_STYLES });
    await chrome.scripting.executeScript({ target: { tabId }, files: PAGE_SCRIPTS });
  } catch (e) {
    // restricted page, file:// without access, or tab closed
  }
}

async function injectIntoActiveTabs() {
  const tabs = await chrome.tabs.query({ active: true });
  await Promise.all(tabs
    .filter(tab => !Core.isRestrictedUrl(tab.url))
    .map(tab => ensureInjected(tab.id)));
}

async function autoReady() {
  const settings = await Core.loadSettings();
  return settings.autoEnabled && await hasHostAccess();
}

// ============================================================
// BADGE
// ============================================================

function updateBadge(tabId, summary) {
  const count = summary && summary.active ? summary.count : 0;
  const levels = (summary && summary.levels) || [];
  const worst = levels.findIndex(c => c > 0);
  const severe = worst >= 0 && worst <= 3;
  const background = severe ? Core.LEVELS[worst].bg : '#475569';
  const foreground = (!severe || worst === 0) ? '#FFFFFF' : '#0F172A';

  chrome.action.setBadgeText({ tabId, text: count > 0 ? Core.formatCount(count) : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: background }).catch(() => {});
  if (chrome.action.setBadgeTextColor) {
    chrome.action.setBadgeTextColor({ tabId, color: foreground }).catch(() => {});
  }
}

// ============================================================
// EVENTS
// ============================================================

chrome.runtime.onInstalled.addListener(async () => {
  await migrateStorage();
  // refresh so an update never keeps a stale registration
  await syncAutoRegistration(true);
  if (await autoReady()) await injectIntoActiveTabs();
});

chrome.runtime.onStartup.addListener(() => {
  syncAutoRegistration(false);
});

chrome.permissions.onAdded.addListener(async () => {
  if (await syncAutoRegistration(false)) await injectIntoActiveTabs();
});

chrome.permissions.onRemoved.addListener(() => {
  syncAutoRegistration(false);
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !(Core.STORAGE.autoEnabled in changes)) return;
  if (await syncAutoRegistration(false)) await injectIntoActiveTabs();
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    if (!await autoReady()) return;
    const tab = await chrome.tabs.get(tabId);
    if (Core.isRestrictedUrl(tab.url)) return;
    await ensureInjected(tabId);
  } catch (e) {
    // tab closed while switching
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // new page: drop the old count until the content script reports again
  if (changeInfo.status === 'loading') {
    chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message && message.action === 'resultsUpdated' && sender.tab && sender.tab.id !== undefined) {
    updateBadge(sender.tab.id, message.summary);
  }
  return false;
});
