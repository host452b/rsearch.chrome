// RSearch content script.
//
// Matches are painted with the CSS Custom Highlight API: the page DOM is
// never modified, so always-on highlighting cannot break React/Vue apps,
// code editors or contenteditable fields, and clearing is instant.
// Requires shared.js (RSearchCore) to be injected first.
(function () {
  'use strict';

  const Core = globalThis.RSearchCore;
  if (!Core || typeof chrome === 'undefined' || !chrome.runtime) return;

  // one live instance per page. after an extension reload/update the old
  // instance is orphaned (its chrome.runtime is gone) and gets replaced.
  const previous = globalThis.__rsearchContent;
  if (previous) {
    if (previous.isAlive()) return;
    try { previous.destroy(); } catch (e) { /* orphaned instance */ }
  }

  const chromeRef = chrome;
  const LEVELS = Core.LEVELS;
  const LEVEL_COUNT = LEVELS.length;
  const LEVEL_WEIGHTS = [5, 4, 3, 2, 1, 1, 1, 1];
  const HIGHLIGHT_NAMES = LEVELS.map((_, i) => 'rsearch-l' + i);
  const CURRENT_HIGHLIGHT = 'rsearch-current';
  const OVERLAY_ID = 'rsearch-overlay';

  const MAX_HIGHLIGHTS = 20000;
  const SLICE_MS = 12;            // work budget before yielding to the page
  const HOTSPOT_WINDOW = 300;     // px
  const LIVE_DEBOUNCE_MS = 200;
  const LIVE_MAX_WAIT_MS = 600;
  const LAYOUT_THROTTLE_MS = 800;
  const BROADCAST_THROTTLE_MS = 1000;
  const MARKER_BUCKET_PX = 3;

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION',
    'IFRAME', 'OBJECT', 'EMBED', 'CANVAS', 'VIDEO', 'AUDIO', 'HEAD', 'TITLE',
    'svg', 'SVG', 'math', 'MATH'
  ]);
  const SKIP_SELECTOR = 'script,style,noscript,template,textarea,input,select,option,svg,math,head,' +
    '[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"],#' + OVERLAY_ID;
  const NON_WS = /\S/;

  const supported = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function';

  const highlights = supported ? HIGHLIGHT_NAMES.map((_, i) => {
    const h = new Highlight();
    h.priority = LEVEL_COUNT - i; // more severe paints on top
    return h;
  }) : [];
  const currentHighlight = supported ? new Highlight() : null;
  if (currentHighlight) currentHighlight.priority = 100;

  const state = {
    seq: 0,                 // bumps on every search/clear; stale async work bails out
    running: false,
    request: null,
    source: null,           // 'auto' (follows settings) | 'manual' | null
    matcher: null,
    matches: [],            // { node, start, end, level, range, top, left, visible, dead }
    total: 0,               // every match found, including ones past MAX_HIGHLIGHTS
    levelCounts: new Array(LEVEL_COUNT).fill(0),
    truncated: false,
    visible: [],            // laid-out matches sorted by page position
    cursor: -1,
    current: null,
    hotspots: [],
    autoSuppressed: false,  // user hit Clear: keep the page clean until reload
    lastError: null
  };

  let nodeMatches = new WeakMap(); // Text -> match[]
  let scannedNodes = new WeakSet();

  const live = {
    observer: null,
    resizeObserver: null,
    added: new Set(),
    changed: new Set(),
    debounceTimer: null,
    maxWaitTimer: null,
    flushing: false,
    layoutTimer: null,
    lastLayoutAt: 0,
    layoutDirty: false
  };

  let overlay = null;
  let tooltip = null;
  let lastBroadcastAt = 0;
  let broadcastTimer = null;
  let lastProgressAt = 0;
  let rerunTimer = null;
  let visibilityHandler = null;
  let destroyed = false;

  function isAlive() {
    try {
      return !destroyed && !!(chromeRef.runtime && chromeRef.runtime.id);
    } catch (e) {
      return false;
    }
  }

  function safeSend(message) {
    if (!isAlive()) return;
    try {
      chromeRef.runtime.sendMessage(message).catch(() => {});
    } catch (e) {
      // extension context invalidated
    }
  }

  function yieldToMain() {
    if (globalThis.scheduler && typeof globalThis.scheduler.yield === 'function') {
      return globalThis.scheduler.yield();
    }
    return new Promise(resolve => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => resolve();
      channel.port2.postMessage(null);
    });
  }

  // ============================================================
  // HIGHLIGHT REGISTRY
  // ============================================================

  function registerHighlights() {
    if (!supported) return;
    for (let i = 0; i < LEVEL_COUNT; i++) {
      if (CSS.highlights.get(HIGHLIGHT_NAMES[i]) !== highlights[i]) {
        CSS.highlights.set(HIGHLIGHT_NAMES[i], highlights[i]);
      }
    }
    if (CSS.highlights.get(CURRENT_HIGHLIGHT) !== currentHighlight) {
      CSS.highlights.set(CURRENT_HIGHLIGHT, currentHighlight);
    }
  }

  function unregisterHighlights() {
    if (!supported) return;
    for (let i = 0; i < LEVEL_COUNT; i++) {
      highlights[i].clear();
      if (CSS.highlights.get(HIGHLIGHT_NAMES[i]) === highlights[i]) CSS.highlights.delete(HIGHLIGHT_NAMES[i]);
    }
    currentHighlight.clear();
    if (CSS.highlights.get(CURRENT_HIGHLIGHT) === currentHighlight) CSS.highlights.delete(CURRENT_HIGHLIGHT);
  }

  // ============================================================
  // TEXT COLLECTION
  // ============================================================

  const textFilter = {
    acceptNode(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        return node.data.length > 0 && NON_WS.test(node.data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
      if (SKIP_TAGS.has(node.tagName) || node.id === OVERLAY_ID) return NodeFilter.FILTER_REJECT;
      const editable = node.contentEditable;
      if (editable === 'true' || editable === 'plaintext-only') return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_SKIP;
    }
  };

  function collectTextNodes(root, out) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, textFilter);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n);
    return out;
  }

  function isInsideSkipped(node) {
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!el) return true;
    return el.closest(SKIP_SELECTOR) !== null;
  }

  // ============================================================
  // MATCHING
  // ============================================================

  function buildMatcher(request) {
    if (request.mode === 'regex') {
      return Core.buildRegexMatcher(request.pattern, request.flags);
    }
    return Core.buildKeywordMatcher(request.keywords || [], {
      ignoreCase: request.ignoreCase !== false,
      smartMatch: request.smartMatch !== false
    });
  }

  function addMatch(node, start, end, level) {
    state.total++;
    state.levelCounts[level]++;
    if (state.matches.length >= MAX_HIGHLIGHTS) {
      state.truncated = true;
      return;
    }
    const range = new StaticRange({ startContainer: node, startOffset: start, endContainer: node, endOffset: end });
    const match = { node, start, end, level, range, top: 0, left: 0, visible: false, dead: false };
    state.matches.push(match);
    highlights[level].add(range);
    let list = nodeMatches.get(node);
    if (!list) {
      list = [];
      nodeMatches.set(node, list);
    }
    list.push(match);
  }

  function dropMatch(match) {
    if (match.dead) return;
    match.dead = true;
    highlights[match.level].delete(match.range);
    if (state.current === match) {
      state.current = null;
      currentHighlight.clear();
    }
    state.total = Math.max(0, state.total - 1);
    state.levelCounts[match.level] = Math.max(0, state.levelCounts[match.level] - 1);
  }

  function dropNodeMatches(node) {
    const list = nodeMatches.get(node);
    if (!list) return false;
    list.forEach(dropMatch);
    nodeMatches.delete(node);
    return true;
  }

  // scan one text node from `from`; returns the offset to resume at when the
  // time budget ran out, or -1 when the node is done
  function scanTextNode(node, from, deadline) {
    const matcher = state.matcher;
    const re = matcher.regex;
    const text = node.data;
    re.lastIndex = from;
    let iterations = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const length = m[0].length;
      if (length === 0) {
        re.lastIndex = start + 1;
        continue;
      }
      const entry = matcher.resolve(text, start, start + length);
      if (!entry) {
        re.lastIndex = start + 1;
        continue;
      }
      addMatch(node, start, start + length, entry.level);
      if (!matcher.global) return -1;
      if ((++iterations & 63) === 0 && performance.now() > deadline) return re.lastIndex;
    }
    return -1;
  }

  // scan a list of text nodes with time slicing; returns false if superseded
  async function scanNodes(nodes, seq, onProgress) {
    let deadline = performance.now() + SLICE_MS;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (!node.isConnected) continue;
      scannedNodes.add(node);
      let resumeAt = 0;
      for (;;) {
        resumeAt = scanTextNode(node, resumeAt, deadline);
        if (resumeAt < 0) break;
        await yieldToMain();
        if (seq !== state.seq) return false;
        deadline = performance.now() + SLICE_MS;
        if (!node.isConnected) break;
      }
      if (!state.matcher.global && state.total > 0) return true;
      if (performance.now() > deadline) {
        if (onProgress) onProgress(i + 1, nodes.length);
        await yieldToMain();
        if (seq !== state.seq) return false;
        deadline = performance.now() + SLICE_MS;
      }
    }
    return true;
  }

  // ============================================================
  // SEARCH
  // ============================================================

  function resetResults() {
    for (const h of highlights) h.clear();
    if (currentHighlight) currentHighlight.clear();
    state.matches = [];
    state.visible = [];
    state.total = 0;
    state.levelCounts.fill(0);
    state.truncated = false;
    state.cursor = -1;
    state.current = null;
    state.hotspots = [];
    nodeMatches = new WeakMap();
    scannedNodes = new WeakSet();
    clearMarkers();
  }

  async function runSearch(request, source) {
    if (!supported) {
      return { success: false, error: 'This version of Chrome is too old (needs Chrome 105+).' };
    }
    const seq = ++state.seq;
    clearTimeout(rerunTimer);
    stopLive();
    resetResults();

    let matcher;
    try {
      matcher = buildMatcher(request || {});
    } catch (e) {
      state.matcher = null;
      return { success: false, error: 'Invalid regex: ' + e.message };
    }
    if (!matcher) {
      state.matcher = null;
      state.request = null;
      state.source = null;
      broadcast(true);
      return { success: false, error: 'No keywords to search' };
    }

    state.matcher = matcher;
    state.request = request;
    state.source = source;
    state.running = true;
    state.autoSuppressed = false;
    state.lastError = null;
    registerHighlights();

    // watch the page while scanning so content that streams in meanwhile is not missed
    if (matcher.global) startLive();

    const root = document.body || document.documentElement;
    const nodes = root ? collectTextNodes(root, []) : [];
    const startedAt = performance.now();
    const completed = await scanNodes(nodes, seq, (done, total) => sendProgress(done, total, startedAt));
    if (!completed || seq !== state.seq) {
      return { success: false, aborted: true };
    }

    state.running = false;
    refreshLayout();
    broadcast(true);
    return Object.assign({ success: true }, buildSummary());
  }

  function sendProgress(done, total, startedAt) {
    const now = performance.now();
    // quick searches finish before anyone could read a progress line
    if (now - startedAt < 300 || now - lastProgressAt < 150) return;
    lastProgressAt = now;
    const elapsed = now - startedAt;
    const rate = done / Math.max(elapsed, 1);
    safeSend({
      action: 'searchProgress',
      percent: Math.round((done / Math.max(total, 1)) * 100),
      matches: state.total,
      estimatedSeconds: rate > 0 ? Math.ceil((total - done) / rate / 1000) : 0
    });
  }

  function clearAll(options) {
    state.seq++;
    clearTimeout(rerunTimer);
    stopLive();
    resetResults();
    state.matcher = null;
    state.request = null;
    state.source = null;
    state.running = false;
    if (options && options.suppressAuto) state.autoSuppressed = true;
    broadcast(true);
  }

  // ============================================================
  // LIVE UPDATES (streaming logs, SPAs, lazy-rendered content)
  // ============================================================

  function startLive() {
    if (live.observer) return;
    live.observer = new MutationObserver(onMutations);
    live.observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    live.resizeObserver = new ResizeObserver(() => scheduleLayout());
    live.resizeObserver.observe(document.documentElement);
    window.addEventListener('resize', scheduleLayout);
  }

  function stopLive() {
    if (live.observer) live.observer.disconnect();
    if (live.resizeObserver) live.resizeObserver.disconnect();
    live.observer = null;
    live.resizeObserver = null;
    window.removeEventListener('resize', scheduleLayout);
    clearTimeout(live.debounceTimer);
    clearTimeout(live.maxWaitTimer);
    clearTimeout(live.layoutTimer);
    live.debounceTimer = null;
    live.maxWaitTimer = null;
    live.layoutTimer = null;
    live.added.clear();
    live.changed.clear();
    live.layoutDirty = false;
  }

  function isOwnNode(node) {
    return !!overlay && (node === overlay || overlay.contains(node));
  }

  function onMutations(records) {
    if (!isAlive()) {
      teardownOrphan();
      return;
    }
    const head = document.head;
    let relevant = false;
    for (const r of records) {
      const target = r.target;
      if (isOwnNode(target) || (head && (target === head || head.contains(target)))) continue;
      if (r.type === 'characterData') {
        live.changed.add(target);
        relevant = true;
        continue;
      }
      for (const n of r.addedNodes) {
        if (n.nodeType === Node.ELEMENT_NODE || n.nodeType === Node.TEXT_NODE) {
          live.added.add(n);
          relevant = true;
        }
      }
      if (r.removedNodes.length > 0) {
        live.layoutDirty = true;
        relevant = true;
      }
    }
    if (relevant) scheduleFlush();
  }

  function scheduleFlush() {
    clearTimeout(live.debounceTimer);
    live.debounceTimer = setTimeout(flushLive, LIVE_DEBOUNCE_MS);
    if (!live.maxWaitTimer) {
      live.maxWaitTimer = setTimeout(flushLive, LIVE_MAX_WAIT_MS);
    }
  }

  async function flushLive() {
    clearTimeout(live.debounceTimer);
    clearTimeout(live.maxWaitTimer);
    live.debounceTimer = null;
    live.maxWaitTimer = null;
    if (live.flushing || !state.matcher || state.running) {
      // a scan is in progress; try again shortly
      if (state.matcher) scheduleFlush();
      return;
    }
    live.flushing = true;
    const seq = state.seq;
    try {
      const changed = Array.from(live.changed);
      const added = Array.from(live.added);
      live.changed.clear();
      live.added.clear();

      const nodes = [];
      let modified = live.layoutDirty;
      for (const node of changed) {
        if (dropNodeMatches(node)) modified = true;
        scannedNodes.delete(node);
        if (node.isConnected && node.nodeType === Node.TEXT_NODE && !isInsideSkipped(node)) nodes.push(node);
      }
      for (const root of added) {
        if (!root.isConnected) continue;
        if (root.nodeType === Node.TEXT_NODE) {
          if (!scannedNodes.has(root) && root.data.length && !isInsideSkipped(root)) nodes.push(root);
        } else if (!isInsideSkipped(root)) {
          const found = collectTextNodes(root, []);
          for (const t of found) {
            if (!scannedNodes.has(t)) nodes.push(t);
          }
        }
      }

      const before = state.total;
      if (nodes.length > 0) {
        const completed = await scanNodes(nodes, seq, null);
        if (!completed || seq !== state.seq) return;
      }
      if (modified || state.total !== before) scheduleLayout(true);
    } finally {
      live.flushing = false;
    }
  }

  function scheduleLayout(force) {
    if (!state.matcher) return;
    if (force === true) live.layoutDirty = true;
    if (live.layoutTimer) return;
    const wait = Math.max(0, LAYOUT_THROTTLE_MS - (performance.now() - live.lastLayoutAt));
    live.layoutTimer = setTimeout(() => {
      live.layoutTimer = null;
      if (!state.matcher || state.running) return;
      refreshLayout();
      broadcast(false);
    }, wait);
  }

  // ============================================================
  // LAYOUT: positions, navigation order, hotspots, markers
  // ============================================================

  function refreshLayout() {
    live.lastLayoutAt = performance.now();
    live.layoutDirty = false;

    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const range = document.createRange();
    const kept = [];
    const visible = [];

    for (const m of state.matches) {
      if (m.dead) continue;
      if (!m.node.isConnected || m.end > m.node.length) {
        // node left the page (virtualized lists, re-renders); rescan it if it comes back
        dropNodeMatches(m.node);
        dropMatch(m);
        scannedNodes.delete(m.node);
        continue;
      }
      kept.push(m);
      range.setStart(m.node, m.start);
      range.setEnd(m.node, m.end);
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        m.visible = false;
        continue;
      }
      m.visible = true;
      m.top = rect.top + scrollY;
      m.left = rect.left + scrollX;
      visible.push(m);
    }

    visible.sort((a, b) => (a.top - b.top) || (a.left - b.left));
    state.matches = kept;
    state.visible = visible;
    state.cursor = state.current ? visible.indexOf(state.current) : -1;
    state.hotspots = computeHotspots(visible);
    renderMarkers(visible);
  }

  function documentHeight() {
    const docEl = document.documentElement;
    const body = document.body;
    return Math.max(docEl.scrollHeight, body ? body.scrollHeight : 0, window.innerHeight);
  }

  // top 3 non-overlapping 300px windows, weighted by severity. O(n log n).
  function computeHotspots(visible) {
    const n = visible.length;
    if (n === 0) return [];
    const prefix = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + LEVEL_WEIGHTS[visible[i].level];

    const windows = [];
    let j = 0;
    for (let i = 0; i < n; i++) {
      if (j < i) j = i;
      while (j + 1 < n && visible[j + 1].top - visible[i].top <= HOTSPOT_WINDOW) j++;
      windows.push({ i, j, score: prefix[j + 1] - prefix[i] });
    }
    windows.sort((a, b) => (b.score - a.score) || (a.i - b.i));

    const picked = [];
    for (const w of windows) {
      if (picked.length === 3) break;
      const top = visible[w.i].top;
      if (picked.some(p => Math.abs(visible[p.i].top - top) < HOTSPOT_WINDOW)) continue;
      picked.push(w);
    }

    return picked.map((w, index) => {
      // jump target: most severe match in the window, first occurrence
      let anchor = visible[w.i];
      for (let k = w.i + 1; k <= w.j; k++) {
        if (visible[k].level < anchor.level) anchor = visible[k];
      }
      return { rank: index + 1, count: w.j - w.i + 1, anchor };
    });
  }

  function ensureOverlay() {
    if (overlay && overlay.isConnected) return overlay;
    const stale = document.getElementById(OVERLAY_ID);
    if (stale) stale.remove();
    overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.setAttribute('aria-hidden', 'true');
    tooltip = document.createElement('div');
    tooltip.className = 'rsearch-tooltip';
    overlay.appendChild(tooltip);
    overlay.addEventListener('mouseover', onMarkerOver);
    overlay.addEventListener('mouseout', onMarkerOut);
    overlay.addEventListener('click', onMarkerClick);
    // documentElement survives SPA frameworks that swap <body>
    document.documentElement.appendChild(overlay);
    return overlay;
  }

  function clearMarkers() {
    if (!overlay) return;
    const markers = overlay.querySelectorAll('.rsearch-marker');
    markers.forEach(m => m.remove());
    if (tooltip) tooltip.classList.remove('rsearch-show');
  }

  function renderMarkers(visible) {
    const docHeight = documentHeight();
    const viewHeight = window.innerHeight;
    if (visible.length === 0 || docHeight <= viewHeight + 1) {
      clearMarkers();
      return;
    }
    ensureOverlay();
    clearMarkers();

    // one marker per few pixels of scrollbar, keeping the most severe match
    const buckets = new Map();
    for (const m of visible) {
      const bucket = Math.floor(((m.top / docHeight) * viewHeight) / MARKER_BUCKET_PX);
      const prev = buckets.get(bucket);
      if (!prev || m.level < prev.level) buckets.set(bucket, m);
    }

    const fragment = document.createDocumentFragment();
    for (const m of buckets.values()) {
      const marker = document.createElement('div');
      marker.className = 'rsearch-marker';
      marker.style.setProperty('top', ((m.top / docHeight) * 100) + '%', 'important');
      marker.style.setProperty('background-color', LEVELS[m.level].bg, 'important');
      marker.__rsearchMatch = m;
      fragment.appendChild(marker);
    }
    overlay.appendChild(fragment);
  }

  function onMarkerOver(event) {
    const marker = event.target;
    if (!marker.__rsearchMatch || !tooltip) return;
    tooltip.textContent = contextLine(marker.__rsearchMatch, 90) || '…';
    const rect = marker.getBoundingClientRect();
    tooltip.style.setProperty('top', (rect.top + rect.height / 2) + 'px', 'important');
    tooltip.classList.add('rsearch-show');
  }

  function onMarkerOut() {
    if (tooltip) tooltip.classList.remove('rsearch-show');
  }

  function onMarkerClick(event) {
    const marker = event.target;
    if (!marker.__rsearchMatch) return;
    event.stopPropagation();
    event.preventDefault();
    const index = state.visible.indexOf(marker.__rsearchMatch);
    if (index >= 0) {
      setCurrent(index, true);
      broadcast(false);
    }
  }

  // ============================================================
  // CONTEXT LINES (previews, tooltips, copy)
  // ============================================================

  // text of `el` plus the offset of `node` inside it; null once the text
  // exceeds `limit` (never materializes a whole multi-MB <pre>)
  function boundedText(el, node, limit) {
    let text = '';
    let offset = -1;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n === node) offset = text.length;
      text += n.data;
      if (text.length > limit) return null;
    }
    return offset < 0 ? null : { text, offset };
  }

  const BLOCK_TAGS = new Set(['DIV', 'P', 'LI', 'TR', 'TD', 'TH', 'PRE', 'SECTION', 'ARTICLE', 'DD', 'DT', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

  // the log line containing a match. syntax-colored log viewers split one
  // line into many spans, so climb to the line container when it is small.
  function contextLine(match, maxLength) {
    const limit = maxLength || 120;
    let text = match.node.data;
    let offset = match.start;
    let el = match.node.parentElement;
    for (let depth = 0; el && depth < 5; depth++, el = el.parentElement) {
      const found = boundedText(el, match.node, 2000);
      if (!found) break;
      text = found.text;
      offset = found.offset + match.start;
      if (BLOCK_TAGS.has(el.tagName)) break;
    }
    let start = text.lastIndexOf('\n', offset - 1) + 1;
    let end = text.indexOf('\n', offset);
    if (end < 0) end = text.length;
    if (end - start > limit) {
      start = Math.max(start, offset - Math.floor(limit / 3));
      end = Math.min(end, start + limit);
    }
    return text.slice(start, end).replace(/\s+/g, ' ').trim();
  }

  function collectLines(maxLevel, limit) {
    const lines = [];
    const seen = new Set();
    const pass = (filter) => {
      for (const m of state.visible) {
        if (!filter(m)) continue;
        const line = contextLine(m, 400);
        if (!line || seen.has(line)) continue;
        seen.add(line);
        lines.push(line);
        if (lines.length >= limit) return;
      }
    };
    pass(m => m.level <= maxLevel);
    if (lines.length === 0) pass(() => true);
    return lines;
  }

  // ============================================================
  // NAVIGATION
  // ============================================================

  function isScrollable(el) {
    if (el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1) return false;
    const style = getComputedStyle(el);
    return /(auto|scroll|overlay)/.test(style.overflowY + ' ' + style.overflowX);
  }

  // scroll nested scroll containers (inner -> outer), then the window
  function scrollToMatch(match, center) {
    const range = document.createRange();
    try {
      range.setStart(match.node, match.start);
      range.setEnd(match.node, match.end);
    } catch (e) {
      return false;
    }
    let el = match.node.parentElement;
    while (el && el !== document.body && el !== document.documentElement) {
      if (isScrollable(el)) {
        const rect = range.getBoundingClientRect();
        const box = el.getBoundingClientRect();
        if (center || rect.top < box.top || rect.bottom > box.bottom) {
          el.scrollTop += rect.top - box.top - el.clientHeight / 2 + rect.height / 2;
        }
        if (rect.left < box.left || rect.right > box.right) {
          el.scrollLeft += rect.left - box.left - el.clientWidth / 3;
        }
      }
      el = el.parentElement;
    }
    const rect = range.getBoundingClientRect();
    const margin = 40;
    const needsY = center || rect.top < margin || rect.bottom > window.innerHeight - margin;
    const needsX = rect.left < 0 || rect.right > window.innerWidth;
    if (needsY || needsX) {
      window.scrollBy({
        top: needsY ? rect.top - window.innerHeight / 2 + rect.height / 2 : 0,
        left: needsX ? rect.left - window.innerWidth / 3 : 0,
        behavior: 'instant'
      });
    }
    return true;
  }

  function setCurrent(index, center) {
    const match = state.visible[index];
    if (!match) return false;
    state.cursor = index;
    state.current = match;
    currentHighlight.clear();
    currentHighlight.add(match.range);
    return scrollToMatch(match, center);
  }

  function levelFilter(level) {
    if (level === null || level === undefined) return () => true;
    if (level === 'other') return m => m.level >= 4;
    return m => m.level === level;
  }

  function firstIndexAtOrAfter(list, y) {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].top < y) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function navigate(direction, level) {
    if (live.layoutDirty) refreshLayout();
    const list = state.visible;
    if (list.length === 0) return false;
    const accept = levelFilter(level);
    const dir = direction < 0 ? -1 : 1;

    let i = state.cursor;
    const hasCurrent = i >= 0 && i < list.length && list[i] === state.current;
    if (!hasCurrent) {
      // start from the viewport, like the browser's find bar
      if (dir > 0) {
        i = firstIndexAtOrAfter(list, window.scrollY) - 1;
      } else {
        i = firstIndexAtOrAfter(list, window.scrollY + window.innerHeight);
      }
    }
    for (let step = 0; step < list.length; step++) {
      i = (i + dir + list.length) % list.length;
      if (accept(list[i])) return setCurrent(i, false);
    }
    return false;
  }

  function scrollToHotspot(areaIndex) {
    const spot = state.hotspots[areaIndex];
    if (!spot) return false;
    const index = state.visible.indexOf(spot.anchor);
    if (index < 0) return false;
    return setCurrent(index, true);
  }

  // ============================================================
  // SUMMARY & BROADCAST
  // ============================================================

  function buildSummary() {
    const docHeight = documentHeight();
    return {
      active: !!state.matcher,
      running: state.running,
      source: state.source,
      mode: state.request ? state.request.mode : null,
      label: state.request ? state.request.label || null : null,
      count: state.total,
      highlighted: state.matches.length,
      visibleCount: state.visible.length,
      truncated: state.truncated,
      maxHighlights: MAX_HIGHLIGHTS,
      levels: state.levelCounts.slice(),
      cursor: state.cursor,
      autoSuppressed: state.autoSuppressed,
      hotspots: state.hotspots.map((spot, index) => ({
        areaIndex: index,
        rank: spot.rank,
        count: spot.count,
        level: spot.anchor.level,
        position: Math.min(100, Math.round((spot.anchor.top / docHeight) * 100)) + '%',
        preview: contextLine(spot.anchor, 80)
      }))
    };
  }

  // tell background (badge) and an open popup about new results
  function broadcast(immediate) {
    const send = () => {
      broadcastTimer = null;
      lastBroadcastAt = performance.now();
      safeSend({ action: 'resultsUpdated', summary: buildSummary() });
    };
    if (immediate) {
      clearTimeout(broadcastTimer);
      send();
      return;
    }
    if (broadcastTimer) return;
    const wait = Math.max(0, BROADCAST_THROTTLE_MS - (performance.now() - lastBroadcastAt));
    broadcastTimer = setTimeout(send, wait);
  }

  // ============================================================
  // AUTO-HIGHLIGHT
  // ============================================================

  async function autoStart() {
    if (state.autoSuppressed || !isAlive()) return;
    const seqAtStart = state.seq;
    let settings;
    try {
      settings = await Core.loadSettings();
    } catch (e) {
      return;
    }
    // an explicit search arrived while settings were loading
    if (state.seq !== seqAtStart || !isAlive()) return;
    if (!shouldAutoRun(settings)) return;

    if (document.visibilityState !== 'visible') {
      // background tabs wait until they are looked at
      if (!visibilityHandler) {
        visibilityHandler = () => {
          if (document.visibilityState !== 'visible') return;
          document.removeEventListener('visibilitychange', visibilityHandler);
          visibilityHandler = null;
          autoStart();
        };
        document.addEventListener('visibilitychange', visibilityHandler);
      }
      return;
    }

    const keywords = Core.getActiveKeywords(settings);
    if (keywords.length === 0) {
      if (state.source === 'auto') clearAll();
      return;
    }
    await runSearch({
      mode: 'keywords',
      keywords,
      ignoreCase: settings.options.ignoreCase,
      smartMatch: settings.options.smartMatch,
      label: settings.presets[settings.activePresetIndex].name
    }, 'auto');
  }

  function shouldAutoRun(settings) {
    if (!settings.autoEnabled) return false;
    const host = Core.hostFromUrl(location.href);
    return !settings.disabledHosts.includes(host);
  }

  const AUTO_KEYS = [
    Core.STORAGE.autoEnabled,
    Core.STORAGE.presets,
    Core.STORAGE.activePreset,
    Core.STORAGE.options,
    Core.STORAGE.disabledHosts
  ];

  function onStorageChanged(changes, area) {
    if (area !== 'local') return;
    if (!isAlive()) {
      teardownOrphan();
      return;
    }
    if (!AUTO_KEYS.some(key => key in changes)) return;

    const autoChange = changes[Core.STORAGE.autoEnabled];
    if (autoChange && autoChange.newValue === false) {
      if (state.source === 'auto') clearAll();
      return;
    }
    const hostChange = changes[Core.STORAGE.disabledHosts];
    if (hostChange && (hostChange.newValue || []).includes(Core.hostFromUrl(location.href))) {
      if (state.source === 'auto') clearAll();
      return;
    }
    if (state.source === 'manual' || state.autoSuppressed) return;

    // re-run with the new settings, unless an explicit search (e.g. from
    // the popup that made this change) arrives first
    const seqAtChange = state.seq;
    clearTimeout(rerunTimer);
    rerunTimer = setTimeout(() => {
      if (state.seq === seqAtChange) autoStart();
    }, 500);
  }

  // ============================================================
  // MESSAGES
  // ============================================================

  function onMessage(message, sender, sendResponse) {
    if (!message || typeof message.action !== 'string') return false;
    switch (message.action) {
      case 'ping':
        sendResponse({ ok: true });
        return false;
      case 'search':
        runSearch(message.request, message.source === 'auto' ? 'auto' : 'manual')
          .then(sendResponse, error => sendResponse({ success: false, error: error.message }));
        return true;
      case 'clear':
        clearAll({ suppressAuto: true });
        sendResponse({ success: true });
        return false;
      case 'getState':
        sendResponse(buildSummary());
        return false;
      case 'navigate': {
        const ok = navigate(message.direction, message.level);
        sendResponse(Object.assign({ success: ok }, buildSummary()));
        return false;
      }
      case 'scrollToHotspot': {
        const ok = scrollToHotspot(message.areaIndex);
        sendResponse(Object.assign({ success: ok }, buildSummary()));
        return false;
      }
      case 'collectLines':
        sendResponse({ lines: collectLines(message.maxLevel === undefined ? 2 : message.maxLevel, message.limit || 500) });
        return false;
      default:
        return false;
    }
  }

  // ============================================================
  // LIFECYCLE
  // ============================================================

  function teardownOrphan() {
    if (destroyed) return;
    destroyed = true;
    stopLive();
    clearTimeout(rerunTimer);
    clearTimeout(broadcastTimer);
    if (visibilityHandler) document.removeEventListener('visibilitychange', visibilityHandler);
  }

  function destroy() {
    teardownOrphan();
    unregisterHighlights();
    if (overlay) overlay.remove();
    overlay = null;
    try {
      chromeRef.runtime.onMessage.removeListener(onMessage);
      chromeRef.storage.onChanged.removeListener(onStorageChanged);
    } catch (e) {
      // context already invalidated
    }
  }

  globalThis.__rsearchContent = { isAlive, destroy };

  const stale = document.getElementById(OVERLAY_ID);
  if (stale) stale.remove();

  chromeRef.runtime.onMessage.addListener(onMessage);
  chromeRef.storage.onChanged.addListener(onStorageChanged);

  // back/forward cache restores keep our state, but the badge was reset on navigation
  window.addEventListener('pageshow', event => {
    if (event.persisted && state.matcher && isAlive()) broadcast(true);
  });

  autoStart();
})();
