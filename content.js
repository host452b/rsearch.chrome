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
  // severity weights for hotspots and the minimap heat strip: steep on
  // purpose, so a wall of warnings never outranks a burst of crashes
  const LEVEL_WEIGHTS = [8, 5, 2, 0.5, 0.25, 1, 1, 1];
  const HIGHLIGHT_NAMES = LEVELS.map((_, i) => 'rsearch-l' + i);
  const CURRENT_HIGHLIGHT = 'rsearch-current';
  const OVERLAY_ID = 'rsearch-overlay';
  const MINIMAP_ID = 'rsearch-minimap';

  const MAX_HIGHLIGHTS = 100000;  // affordable because registration is virtualized
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
  // subtrees whose text sits deeper than a direct child (direct-child cases
  // like <script>/<textarea> are caught by SKIP_TAGS on the parent)
  const DEEP_SKIP_SELECTOR = 'svg,math,iframe,object,embed,canvas,video,audio,noscript,' +
    '[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"],#' + OVERLAY_ID + ',#' + MINIMAP_ID;
  const NON_WS = /\S/;

  // Chrome rebuilds the markers of every registered highlight range on each
  // DOM or style change anywhere in the page (~1 ms per 1,000 ranges per
  // frame). Past this many matches only the ones near the viewport are
  // registered, so scrolling, hovering and page animations stay smooth.
  const VIRTUAL_THRESHOLD = 3000;

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
    hidden: new Set(),      // severity levels the user switched off (layers)
    lastError: null,
    partial: null           // { source, text, href } when the page shows only part of a log
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
    layoutDirty: false,     // nodes were removed: prune before the next use
    needFull: false         // viewport resized: every position must be re-measured
  };

  const layout = {
    version: 0,
    unmeasured: []          // matches added since the last layout pass
  };

  const virtual = {
    active: false,
    registered: new Set(),  // matches whose range is in a Highlight right now
    top: 0,
    bottom: 0,
    frame: 0,
    pinned: new Map(),      // inner scroll container -> matches near its viewport
    containerInfo: new WeakMap(),
    pendingContainers: new Set()
  };

  let overlay = null;
  let tooltip = null;
  let ui = Object.assign({}, Core.DEFAULT_UI);
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

  // hidden layers are taken out of the registry; their ranges are kept
  function registerHighlights() {
    if (!supported) return;
    for (let i = 0; i < LEVEL_COUNT; i++) {
      const registered = CSS.highlights.get(HIGHLIGHT_NAMES[i]) === highlights[i];
      if (state.hidden.has(i)) {
        if (registered) CSS.highlights.delete(HIGHLIGHT_NAMES[i]);
      } else if (!registered) {
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

  // text-only walk without a filter callback (a JS callback per node made
  // collection the slowest part of a search); deep skip subtrees are found
  // once with a native selector query
  function excludedTextNodes(root) {
    let excluded = null;
    if (root.querySelectorAll) {
      for (const el of root.querySelectorAll(DEEP_SKIP_SELECTOR)) {
        const inner = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = inner.nextNode(); n; n = inner.nextNode()) {
          if (!excluded) excluded = new Set();
          excluded.add(n);
        }
      }
    }
    return excluded;
  }

  // ============================================================
  // PARTIAL LOGS: CI pages that show only part of a long log
  // ============================================================
  // the root cause is usually the first error, and that is exactly the part
  // these pages leave out. rules with a link require the link to be present,
  // so ordinary log lines like "Skipping 5 MB of cache" do not trigger.

  const TRUNCATION_QUICK = /Skipping|Showing last|truncated/i;
  const TRUNCATION_RULES = [
    { source: 'Jenkins', re: /Skipping\s+[\d,.]+\s*[KMG]i?B\b/i, link: /full\s*log/i },
    { source: 'GitLab', re: /Showing last\s+[\d,.]+\s*[KMG]i?B\b/i, link: /complete raw|\braw\b/i },
    { source: 'GitHub Actions', re: /This step has been truncated due to its large size/i, link: null },
    { source: null, re: /\b(?:log|output)\s+(?:has been\s+|was\s+|is\s+)?truncated\b/i, link: /full|raw|complete|download/i }
  ];

  function checkTruncation(node) {
    if (state.partial) return;
    const text = node.data;
    if (text.length > 400 || !TRUNCATION_QUICK.test(text)) return;
    for (const rule of TRUNCATION_RULES) {
      if (!rule.re.test(text)) continue;
      let href = null;
      if (rule.link) {
        let el = node.parentElement;
        for (let depth = 0; el && depth < 3 && !href; depth++, el = el.parentElement) {
          for (const a of el.querySelectorAll('a[href]')) {
            if (rule.link.test(a.textContent || '') && /^https?:/i.test(a.href)) {
              href = a.href;
              break;
            }
          }
        }
        if (!href) continue;
      }
      state.partial = { source: rule.source, text: text.replace(/\s+/g, ' ').trim().slice(0, 140), href };
      return;
    }
  }

  function acceptText(n, excluded) {
    const parent = n.parentNode;
    if (parent && SKIP_TAGS.has(parent.nodeName)) return false;
    if (excluded && excluded.has(n)) return false;
    return NON_WS.test(n.data);
  }

  function collectTextNodes(root, out) {
    const excluded = excludedTextNodes(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (acceptText(n, excluded)) out.push(n);
    }
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
    const match = { node, start, end, level, range, top: 0, left: 0, width: 0, height: 0, visible: false, dead: false, reg: false };
    state.matches.push(match);
    layout.unmeasured.push(match);
    // show matches right away until the page has many; then the viewport decides
    if (!virtual.active && virtual.registered.size < VIRTUAL_THRESHOLD) registerMatch(match);
    let list = nodeMatches.get(node);
    if (!list) {
      list = [];
      nodeMatches.set(node, list);
    }
    list.push(match);
  }

  function registerMatch(m) {
    if (m.reg) return;
    highlights[m.level].add(m.range);
    m.reg = true;
    virtual.registered.add(m);
  }

  function unregisterMatch(m) {
    if (!m.reg) return;
    highlights[m.level].delete(m.range);
    m.reg = false;
    virtual.registered.delete(m);
  }

  function dropMatch(match) {
    if (match.dead) return;
    match.dead = true;
    unregisterMatch(match);
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

  // initial search: walk and scan in the same time slices, so even a
  // 100k-node page never blocks the main thread for one long task.
  // returns false if superseded by a newer search/clear.
  async function walkAndScan(root, seq, onProgress) {
    let excluded = excludedTextNodes(root);
    let walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const estimate = Math.max(1, root.getElementsByTagName('*').length);
    let deadline = performance.now() + SLICE_MS;
    let visited = 0;
    const restartIfDetached = node => {
      // the page replaced content under us: walk again, skipping scanned nodes
      if (node && !node.isConnected) {
        walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        excluded = excludedTextNodes(root);
      }
    };
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      visited++;
      if (!scannedNodes.has(n) && acceptText(n, excluded)) {
        scannedNodes.add(n);
        checkTruncation(n);
        let resumeAt = 0;
        for (;;) {
          resumeAt = scanTextNode(n, resumeAt, deadline);
          if (resumeAt < 0) break;
          await yieldToMain();
          if (seq !== state.seq) return false;
          deadline = performance.now() + SLICE_MS;
          if (!n.isConnected) break;
        }
        if (!state.matcher.global && state.total > 0) return true;
        if (!n.isConnected) {
          restartIfDetached(n);
          continue;
        }
      }
      if ((visited & 127) === 0 && performance.now() > deadline) {
        if (onProgress) onProgress(Math.min(visited, estimate - 1), estimate);
        await yieldToMain();
        if (seq !== state.seq) return false;
        deadline = performance.now() + SLICE_MS;
        restartIfDetached(walker.currentNode);
      }
    }
    return true;
  }

  // scan a list of text nodes with time slicing; returns false if superseded
  async function scanNodes(nodes, seq, onProgress) {
    let deadline = performance.now() + SLICE_MS;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (!node.isConnected) continue;
      scannedNodes.add(node);
      checkTruncation(node);
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
    setVirtualActive(false);
    virtual.registered.clear();
    layout.unmeasured = [];
    state.matches = [];
    state.visible = [];
    state.total = 0;
    state.levelCounts.fill(0);
    state.truncated = false;
    state.cursor = -1;
    state.current = null;
    state.hotspots = [];
    state.partial = null;
    patternCache = null;
    nodeMatches = new WeakMap();
    scannedNodes = new WeakSet();
    clearMarkers();
    removeMinimap();
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
    const startedAt = performance.now();
    const completed = root ? await walkAndScan(root, seq, (done, total) => sendProgress(done, total, startedAt)) : true;
    if (!completed || seq !== state.seq) {
      return { success: false, aborted: true };
    }
    if (!await layoutAllSliced(seq)) {
      return { success: false, aborted: true };
    }

    state.running = false;
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
    // the page growing (streaming logs) only needs new lines measured
    live.resizeObserver = new ResizeObserver(() => scheduleLayout(false));
    live.resizeObserver.observe(document.documentElement);
    window.addEventListener('resize', onWindowResize);
  }

  function onWindowResize() {
    scheduleLayout(true);
  }

  function stopLive() {
    if (live.observer) live.observer.disconnect();
    if (live.resizeObserver) live.resizeObserver.disconnect();
    live.observer = null;
    live.resizeObserver = null;
    window.removeEventListener('resize', onWindowResize);
    clearTimeout(live.debounceTimer);
    clearTimeout(live.maxWaitTimer);
    clearTimeout(live.layoutTimer);
    live.debounceTimer = null;
    live.maxWaitTimer = null;
    live.layoutTimer = null;
    live.added.clear();
    live.changed.clear();
    live.layoutDirty = false;
    live.needFull = false;
  }

  function isOwnNode(node) {
    if (minimap.host && node === minimap.host) return true;
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
      if (modified) live.layoutDirty = true;
      if (modified || state.total !== before) scheduleLayout(false);
    } finally {
      live.flushing = false;
    }
  }

  // incremental passes are cheap and run promptly; a full re-measure
  // (resize, reflow above existing matches) is throttled
  function scheduleLayout(full) {
    if (!state.matcher) return;
    if (full === true) live.needFull = true;
    if (live.layoutTimer) return;
    const since = performance.now() - live.lastLayoutAt;
    const wait = live.needFull ? Math.max(0, LAYOUT_THROTTLE_MS - since) : Math.max(60, 250 - since);
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

  function compareMatches(a, b) {
    return (a.top - b.top) || (a.left - b.left);
  }

  // measure one match; false when it has no box (hidden) or left the page
  function measure(m, range) {
    if (!m.node.isConnected || m.end > m.node.length) {
      m.visible = false;
      return false;
    }
    range.setStart(m.node, m.start);
    range.setEnd(m.node, m.end);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      m.visible = false;
      return false;
    }
    m.visible = true;
    m.top = rect.top + window.scrollY;
    m.left = rect.left + window.scrollX;
    m.width = rect.width;
    m.height = rect.height;
    return true;
  }

  // drop matches whose text left the page (virtualized lists, re-renders);
  // they are rescanned if the node comes back
  function pruneDetached() {
    let removed = false;
    for (const m of state.matches) {
      if (m.dead) {
        removed = true;
        continue;
      }
      if (!m.node.isConnected || m.end > m.node.length) {
        dropNodeMatches(m.node);
        dropMatch(m);
        scannedNodes.delete(m.node);
        removed = true;
      }
    }
    if (removed) {
      const alive = m => !m.dead;
      state.matches = state.matches.filter(alive);
      state.visible = state.visible.filter(alive);
      layout.unmeasured = layout.unmeasured.filter(alive);
    }
    return removed;
  }

  // re-measure ~16 evenly spaced matches: if none moved, nothing above or
  // between them reflowed and only new matches need measuring
  function anchorsStable(range) {
    const list = state.visible;
    if (list.length === 0) return true;
    const step = Math.max(1, Math.floor(list.length / 16));
    const check = m => {
      const top = m.top;
      const left = m.left;
      return measure(m, range) && Math.abs(m.top - top) <= 1 && Math.abs(m.left - left) <= 1;
    };
    for (let i = 0; i < list.length; i += step) {
      if (!check(list[i])) return false;
    }
    return check(list[list.length - 1]);
  }

  function mergeSorted(a, b) {
    if (b.length === 0) return a;
    if (a.length === 0) return b;
    if (compareMatches(a[a.length - 1], b[0]) <= 0) return a.concat(b); // appended at the end
    const out = new Array(a.length + b.length);
    let i = 0;
    let j = 0;
    let k = 0;
    while (i < a.length && j < b.length) out[k++] = compareMatches(a[i], b[j]) <= 0 ? a[i++] : b[j++];
    while (i < a.length) out[k++] = a[i++];
    while (j < b.length) out[k++] = b[j++];
    return out;
  }

  function refreshLayout(forceFull) {
    live.lastLayoutAt = performance.now();
    const full = !!forceFull || live.needFull;
    live.needFull = false;
    live.layoutDirty = false;
    pruneDetached();

    const range = document.createRange();
    if (full || !anchorsStable(range)) {
      const visible = [];
      for (const m of state.matches) {
        if (measure(m, range)) visible.push(m);
      }
      visible.sort(compareMatches);
      state.visible = visible;
    } else {
      // new matches, plus hidden ones that may have been expanded since
      const fresh = [];
      for (const m of layout.unmeasured) {
        if (!m.dead && measure(m, range)) fresh.push(m);
      }
      const hidden = state.matches.length - state.visible.length - layout.unmeasured.length;
      if (hidden > 0 && hidden <= 2000) {
        const inUnmeasured = new Set(layout.unmeasured);
        for (const m of state.matches) {
          if (!m.visible && !m.dead && !inUnmeasured.has(m) && measure(m, range)) fresh.push(m);
        }
      }
      fresh.sort(compareMatches);
      state.visible = mergeSorted(state.visible, fresh);
    }
    layout.unmeasured = [];
    finishLayout();
  }

  // first layout after a search: measure in time slices so a 100,000-match
  // page never blocks for one long task
  async function layoutAllSliced(seq) {
    pruneDetached();
    const range = document.createRange();
    const visible = [];
    const list = state.matches;
    let deadline = performance.now() + SLICE_MS;
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (!m.dead && measure(m, range)) visible.push(m);
      if ((i & 255) === 255 && performance.now() > deadline) {
        await yieldToMain();
        if (seq !== state.seq) return false;
        deadline = performance.now() + SLICE_MS;
      }
    }
    pruneDetached();
    state.visible = visible.filter(m => !m.dead).sort(compareMatches);
    layout.unmeasured = [];
    live.lastLayoutAt = performance.now();
    live.needFull = false;
    live.layoutDirty = false;
    finishLayout();
    return true;
  }

  function finishLayout() {
    state.cursor = state.current ? state.visible.indexOf(state.current) : -1;
    layout.version++;
    renderDerived();
    syncHighlights(true);
  }

  // ============================================================
  // VIRTUALIZED HIGHLIGHTS
  // ============================================================

  function setVirtualActive(on) {
    if (virtual.active === on) return;
    virtual.active = on;
    if (on) {
      window.addEventListener('scroll', onVirtualScroll, { passive: true });
      document.addEventListener('scroll', onInnerScroll, { capture: true, passive: true });
    } else {
      window.removeEventListener('scroll', onVirtualScroll);
      document.removeEventListener('scroll', onInnerScroll, { capture: true });
      if (virtual.frame) cancelAnimationFrame(virtual.frame);
      virtual.frame = 0;
      virtual.pinned.clear();
      virtual.containerInfo = new WeakMap();
      virtual.pendingContainers.clear();
    }
  }

  // register exactly the matches near the viewport (and near the viewport
  // of inner scroll panes the user scrolled); everything else stays in
  // memory, measured, counted and navigable
  function syncHighlights(force) {
    virtual.frame = 0;
    if (state.matches.length <= VIRTUAL_THRESHOLD) {
      setVirtualActive(false);
      for (const m of state.matches) {
        if (!m.dead) registerMatch(m);
      }
      return;
    }
    setVirtualActive(true);
    const H = window.innerHeight;
    const y = window.scrollY;
    if (!force && y - H * 0.5 >= virtual.top && y + H * 1.5 <= virtual.bottom) return;
    virtual.top = y - 2 * H;
    virtual.bottom = y + 3 * H;

    const desired = new Set();
    const list = state.visible;
    for (let i = firstIndexAtOrAfter(list, virtual.top); i < list.length && list[i].top <= virtual.bottom; i++) {
      desired.add(list[i]);
    }
    for (const set of virtual.pinned.values()) {
      for (const m of set) desired.add(m);
    }
    for (const m of Array.from(virtual.registered)) {
      if (!desired.has(m)) unregisterMatch(m);
    }
    for (const m of desired) {
      if (!m.dead) registerMatch(m);
    }
  }

  function onVirtualScroll() {
    if (!virtual.frame) virtual.frame = requestAnimationFrame(() => syncHighlights(false));
  }

  function onInnerScroll(event) {
    const el = event.target;
    if (!(el instanceof Element) || el === document.documentElement || el === document.body || isOwnNode(el)) return;
    if (virtual.pendingContainers.has(el)) return;
    virtual.pendingContainers.add(el);
    requestAnimationFrame(() => {
      virtual.pendingContainers.delete(el);
      syncContainer(el);
    });
  }

  // offsets inside a scroll pane do not change when the pane scrolls, so
  // measure them once per layout version and binary-search afterwards
  function syncContainer(container) {
    if (!virtual.active || !container.isConnected) return;
    let info = virtual.containerInfo.get(container);
    if (!info || info.version !== layout.version) {
      const box = container.getBoundingClientRect();
      const range = document.createRange();
      const items = [];
      for (const m of state.visible) {
        if (!container.contains(m.node)) continue;
        range.setStart(m.node, m.start);
        range.setEnd(m.node, m.end);
        items.push({ m, offset: range.getBoundingClientRect().top - box.top + container.scrollTop });
      }
      items.sort((a, b) => a.offset - b.offset);
      info = { version: layout.version, items };
      virtual.containerInfo.set(container, info);
    }
    if (info.items.length === 0) return;
    const H = container.clientHeight;
    const top = container.scrollTop - 2 * H;
    const bottom = container.scrollTop + 3 * H;
    let lo = 0;
    let hi = info.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (info.items[mid].offset < top) lo = mid + 1;
      else hi = mid;
    }
    const set = new Set();
    for (let i = lo; i < info.items.length && info.items[i].offset <= bottom; i++) set.add(info.items[i].m);
    virtual.pinned.set(container, set);
    syncHighlights(true);
  }

  function shownMatches() {
    return state.hidden.size ? state.visible.filter(m => !state.hidden.has(m.level)) : state.visible;
  }

  // everything computed from laid-out matches without measuring again:
  // hotspots, the minimap (or the scrollbar strip when it is not shown)
  function renderDerived() {
    const shown = shownMatches();
    state.hotspots = computeHotspots(shown);
    const eligible = minimapEligible();
    renderMinimap(shown, eligible);
    if (eligible && ui.minimap === 'expanded') clearMarkers();
    else renderMarkers(shown);
  }

  // ============================================================
  // LAYERS: show / hide a severity level
  // ============================================================

  function groupLevels(group) {
    if (group === 'other') return [4, 5, 6, 7];
    const level = Number(group);
    return Number.isInteger(level) && level >= 0 && level < LEVEL_COUNT ? [level] : [];
  }

  function setLayer(group, visible) {
    const levels = groupLevels(group);
    if (levels.length === 0) return false;
    const show = visible === undefined ? levels.every(l => state.hidden.has(l)) : !!visible;
    for (const l of levels) {
      if (show) state.hidden.delete(l);
      else state.hidden.add(l);
    }
    if (state.current && state.hidden.has(state.current.level)) {
      state.current = null;
      state.cursor = -1;
      currentHighlight.clear();
    }
    registerHighlights();
    renderDerived();
    broadcast(true);
    return true;
  }

  // read several times per render; scrollHeight can force layout
  let docHeightValue = 0;
  let docHeightAt = -Infinity;
  function documentHeight() {
    const now = performance.now();
    if (now - docHeightAt < 50) return docHeightValue;
    const docEl = document.documentElement;
    const body = document.body;
    docHeightValue = Math.max(docEl.scrollHeight, body ? body.scrollHeight : 0, window.innerHeight);
    docHeightAt = now;
    return docHeightValue;
  }

  // top 3 hotspots: densest severity-weighted 300px windows, preferring
  // distinct bursts. a burst is a run of significant matches separated by
  // more than HOTSPOT_RUN_GAP; only when fewer than 3 bursts exist do two
  // hotspots come from the same burst (never overlapping). O(n log n).
  const HOTSPOT_RUN_GAP = 600;

  function computeHotspots(visible) {
    const n = visible.length;
    if (n === 0) return [];
    const prefix = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + LEVEL_WEIGHTS[visible[i].level];

    // bursts are delimited by significant matches (weight >= 1) when there
    // are any, so a sprinkle of warnings does not chain bursts together
    const hasSignificant = visible.some(m => LEVEL_WEIGHTS[m.level] >= 1);
    const runOf = new Int32Array(n);
    let run = 0;
    let lastTop = -Infinity;
    for (let i = 0; i < n; i++) {
      const m = visible[i];
      if (!hasSignificant || LEVEL_WEIGHTS[m.level] >= 1) {
        if (m.top - lastTop > HOTSPOT_RUN_GAP && i > 0) run++;
        lastTop = m.top;
      }
      runOf[i] = run;
    }

    // window i spans matches i..end[i]; score is its severity weight
    const end = new Int32Array(n);
    const score = new Float64Array(n);
    let j = 0;
    for (let i = 0; i < n; i++) {
      if (j < i) j = i;
      while (j + 1 < n && visible[j + 1].top - visible[i].top <= HOTSPOT_WINDOW) j++;
      end[i] = j;
      score[i] = prefix[j + 1] - prefix[i];
    }

    // at most 3 picks: a few linear max-scans beat sorting ~100k windows
    const picked = [];
    const usedRuns = new Set();
    const overlaps = i => picked.some(p => Math.abs(visible[p.i].top - visible[i].top) < HOTSPOT_WINDOW);
    for (const distinctBursts of [true, false]) {
      while (picked.length < 3) {
        let best = -1;
        for (let i = 0; i < n; i++) {
          if (best >= 0 && score[i] <= score[best]) continue;
          if (overlaps(i)) continue;
          if (distinctBursts && (usedRuns.has(runOf[i]) || usedRuns.has(runOf[end[i]]))) continue;
          best = i;
        }
        if (best < 0) break;
        picked.push({ i: best, j: end[best], score: score[best] });
        for (let r = runOf[best]; r <= runOf[end[best]]; r++) usedRuns.add(r);
      }
    }
    picked.sort((a, b) => (b.score - a.score) || (a.i - b.i));

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
  // MINIMAP: floating pixel texture of where the matches are
  // ============================================================
  // a closed shadow root keeps page CSS out; styles are applied through
  // constructable stylesheets / CSSOM, which page CSP does not block.

  const MAP_WIDTH = 72;
  const HEAT_WIDTH = 4;
  const HEAT_GAP = 2;
  // the minimap is a white, clean surface: low tiers use darker shades of
  // their hue (yellow/amber wash out on white) and alpha stays high
  const TIER_ALPHA = [1, 1, 0.9, 0.75, 0.6, 0.9, 0.9, 0.9];
  const hexRgb = hex => {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const LEVEL_RGB = LEVELS.map(level => hexRgb(level.bg));
  const MAP_RGB = ['#DC2626', '#EA580C', '#D97706', '#CA8A04', '#94A3B8', '#16A34A', '#0891B2', '#DB2777'].map(hexRgb);
  const LAYER_GROUPS = [0, 1, 2, 3, 'other'];

  const MINIMAP_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .panel {
      position: relative; width: ${MAP_WIDTH + 12}px; padding: 6px;
      background: #FFFFFF; border: 1px solid #E2E8F0; border-radius: 10px;
      box-shadow: 0 6px 20px rgba(15, 23, 42, 0.14), 0 1px 2px rgba(15, 23, 42, 0.06);
      font: 10px/1.2 -apple-system, BlinkMacSystemFont, sans-serif; color: #334155;
      opacity: 0.97; transition: opacity 0.15s ease; user-select: none; -webkit-user-select: none;
    }
    .panel:hover { opacity: 1; }
    .head { display: flex; align-items: center; gap: 4px; height: 16px; margin-bottom: 5px; }
    .count { flex: 1; min-width: 0; font: 600 11px "SF Mono", Monaco, Menlo, monospace; color: #0F172A;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .dot { width: 8px; height: 8px; border-radius: 2px; flex-shrink: 0; }
    button { all: unset; cursor: pointer; }
    .btn { width: 16px; height: 16px; border-radius: 4px; display: flex; align-items: center; justify-content: center;
      color: #64748B; font: 13px/1 -apple-system, BlinkMacSystemFont, sans-serif; }
    .btn:hover { background: #F1F5F9; color: #0F172A; }
    .btn:focus-visible, .sw:focus-visible, .pill:focus-visible { outline: 2px solid #3B82F6; outline-offset: 1px; }
    .map { position: relative; width: ${MAP_WIDTH}px; border-radius: 6px; overflow: hidden; background: #FFFFFF;
      box-shadow: inset 0 0 0 1px #E2E8F0; cursor: pointer; touch-action: none; }
    canvas { display: block; width: 100%; height: 100%; }
    .slider { position: absolute; left: 0; right: 0; min-height: 4px; border: 1px solid rgba(15, 23, 42, 0.4);
      background: rgba(15, 23, 42, 0.06); border-radius: 3px; pointer-events: none; }
    .legend { display: flex; justify-content: center; gap: 5px; margin-top: 6px; height: 10px; }
    .sw { width: 10px; height: 10px; border-radius: 2px; }
    .sw.off { opacity: 0.25; }
    .tip { position: absolute; right: calc(100% + 8px); display: none; max-width: 440px; padding: 4px 8px;
      background: #FFFFFF; border: 1px solid #E2E8F0; border-radius: 6px; color: #0F172A;
      font: 12px/1.4 "SF Mono", Monaco, Menlo, monospace; white-space: nowrap; overflow: hidden;
      text-overflow: ellipsis; transform: translateY(-50%); pointer-events: none;
      box-shadow: 0 4px 14px rgba(15, 23, 42, 0.14); }
    .tip.show { display: block; }
    .pill { display: none; align-items: center; gap: 5px; height: 22px; padding: 0 8px;
      background: #FFFFFF; border: 1px solid #E2E8F0; border-radius: 10px;
      font: 600 11px "SF Mono", Monaco, Menlo, monospace; color: #0F172A;
      box-shadow: 0 4px 14px rgba(15, 23, 42, 0.14); }
    .pill:hover { background: #F8FAFC; }
  `;

  const minimap = {
    host: null, panel: null, map: null, canvas: null, slider: null, count: null, dot: null,
    legend: null, tip: null, pill: null, pillDot: null, pillCount: null,
    height: 0, docHeight: 1, shown: [], drag: null, scrollFrame: 0, base: null
  };

  function swatchStyle(el, level) {
    const meta = LEVELS[level];
    const [r, g, b] = LEVEL_RGB[level];
    el.style.background = 'transparent';
    el.style.boxShadow = 'none';
    el.style.borderBottom = 'none';
    el.style.borderRadius = '2px';
    if (meta.style === 'solid') {
      el.style.background = meta.bg;
    } else if (meta.style === 'tint') {
      el.style.background = `rgba(${r}, ${g}, ${b}, 0.35)`;
      el.style.boxShadow = `inset 0 0 0 1px ${meta.bg}`;
    } else {
      el.style.borderRadius = '0';
      el.style.borderBottom = `2px ${meta.style === 'dotted' ? 'dotted' : 'solid'} ${meta.bg}`;
    }
  }

  function buildMinimap() {
    const host = document.createElement('div');
    host.id = MINIMAP_ID;
    for (const [prop, value] of [
      ['all', 'initial'], ['position', 'fixed'], ['top', '50%'], ['right', '16px'],
      ['transform', 'translateY(-50%)'], ['z-index', '2147483646'], ['display', 'block']
    ]) host.style.setProperty(prop, value, 'important');

    const root = host.attachShadow({ mode: 'closed' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(MINIMAP_CSS);
      root.adoptedStyleSheets = [sheet];
    } catch (e) {
      const style = document.createElement('style');
      style.textContent = MINIMAP_CSS;
      root.appendChild(style);
    }

    const make = (tag, cls, parent) => {
      const el = document.createElement(tag);
      if (cls) el.className = cls;
      parent.appendChild(el);
      return el;
    };
    const panel = make('div', 'panel', root);
    const head = make('div', 'head', panel);
    minimap.dot = make('span', 'dot', head);
    minimap.count = make('span', 'count', head);
    const collapse = make('button', 'btn', head);
    collapse.textContent = '–';
    collapse.title = 'Collapse the minimap (on every page)';
    collapse.addEventListener('click', () => setMinimapMode('collapsed'));
    minimap.map = make('div', 'map', panel);
    minimap.canvas = make('canvas', null, minimap.map);
    minimap.slider = make('div', 'slider', minimap.map);
    minimap.legend = make('div', 'legend', panel);
    minimap.tip = make('div', 'tip', panel);

    minimap.pill = make('button', 'pill', root);
    minimap.pillDot = make('span', 'dot', minimap.pill);
    minimap.pillCount = make('span', null, minimap.pill);
    minimap.pill.title = 'Show the RSearch minimap';
    minimap.pill.addEventListener('click', () => setMinimapMode('expanded'));

    // keep page handlers (click-outside, drag handlers) from reacting to us
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu']) {
      panel.addEventListener(type, e => e.stopPropagation());
      minimap.pill.addEventListener(type, e => e.stopPropagation());
    }
    minimap.legend.addEventListener('click', event => {
      const group = event.target && event.target.dataset ? event.target.dataset.group : undefined;
      if (group !== undefined) setLayer(group === 'other' ? 'other' : Number(group));
    });

    const map = minimap.map;
    map.addEventListener('pointerdown', onMapPointerDown);
    map.addEventListener('pointermove', onMapPointerMove);
    map.addEventListener('pointerup', onMapPointerUp);
    map.addEventListener('pointercancel', () => { minimap.drag = null; });
    map.addEventListener('pointerleave', hideMapTip);

    minimap.host = host;
    minimap.panel = panel;
    document.documentElement.appendChild(host);
    window.addEventListener('scroll', onWindowScroll, { passive: true });
  }

  function removeMinimap() {
    if (minimap.host) minimap.host.remove();
    minimap.host = null;
    minimap.shown = [];
    minimap.drag = null;
    window.removeEventListener('scroll', onWindowScroll);
  }

  function setMinimapMode(mode) {
    ui = Core.normalizeUi(Object.assign({}, ui, { minimap: mode }));
    renderDerived();
    try {
      chromeRef.storage.local.set({ [Core.STORAGE.ui]: ui }).catch(() => {});
    } catch (e) {
      // context invalidated
    }
  }

  // floating panels are noise on pages with a stray "required": only show
  // the map on scrollable pages with real problems (or any manual search)
  function minimapEligible() {
    if (ui.minimap === 'off' || state.visible.length === 0) return false;
    if (documentHeight() < window.innerHeight * 1.5) return false;
    if (state.source === 'manual') return state.visible.length >= 3;
    let serious = 0;
    for (const m of state.visible) {
      if (m.level <= 2 && ++serious >= 3) return true;
    }
    return false;
  }

  function renderMinimap(shown, eligible) {
    if (!eligible) {
      removeMinimap();
      return;
    }
    if (!minimap.host || !minimap.host.isConnected) {
      removeMinimap();
      buildMinimap();
    }
    const collapsed = ui.minimap === 'collapsed';
    minimap.panel.style.display = collapsed ? 'none' : 'block';
    minimap.pill.style.display = collapsed ? 'flex' : 'none';

    const counts = new Array(LEVEL_COUNT).fill(0);
    for (const m of state.visible) counts[m.level]++;
    const worst = counts.findIndex(c => c > 0);
    const label = Core.formatCount(state.total);
    for (const dot of [minimap.dot, minimap.pillDot]) swatchStyle(dot, worst < 0 ? 4 : worst);
    minimap.count.textContent = label;
    minimap.pillCount.textContent = label;
    minimap.count.title = state.total.toLocaleString('en-US') + ' matches · click or drag the map to scroll';
    if (collapsed) return;

    // legend doubles as layer switches
    minimap.legend.textContent = '';
    for (const group of LAYER_GROUPS) {
      const levels = groupLevels(group);
      const n = levels.reduce((sum, l) => sum + counts[l], 0);
      if (n === 0) continue;
      const sw = document.createElement('button');
      sw.className = 'sw' + (levels.every(l => state.hidden.has(l)) ? ' off' : '');
      sw.dataset.group = String(group);
      swatchStyle(sw, group === 'other' ? (counts.slice(4).findIndex(c => c > 0) + 4) : group);
      const name = group === 'other' ? 'Other' : LEVELS[group].label;
      sw.title = name + ' · ' + n.toLocaleString('en-US') + (sw.classList.contains('off') ? ' · hidden, click to show' : ' · click to hide');
      minimap.legend.appendChild(sw);
    }

    minimap.height = Math.round(Math.max(140, Math.min(window.innerHeight * 0.55, 520)));
    minimap.map.style.height = minimap.height + 'px';
    minimap.docHeight = documentHeight();
    minimap.shown = shown;
    drawMinimap();
    updateSlider();
  }

  // navigation only moves the current-match line: repaint the cached base
  // texture and draw the line, instead of rebuilding the texture
  function drawMinimapCurrent() {
    if (!minimap.host || !minimap.base || ui.minimap !== 'expanded') return;
    const ctx = minimap.canvas.getContext('2d');
    if (!ctx) return;
    ctx.putImageData(minimap.base.image, 0, 0);
    paintCurrentLine(ctx, minimap.base);
  }

  function paintCurrentLine(ctx, base) {
    const m = state.current;
    if (!m || !m.visible || state.hidden.has(m.level)) return;
    const y = Math.round(m.top * base.ys);
    ctx.fillStyle = '#3B82F6';
    ctx.fillRect(base.texX, Math.max(0, y - base.dpr), base.texW, Math.max(2, Math.round(2 * base.dpr)));
  }

  function drawMinimap() {
    minimap.base = null;
    if (!minimap.host || ui.minimap !== 'expanded' || minimap.panel.style.display === 'none') return;
    const shown = minimap.shown;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(MAP_WIDTH * dpr);
    const H = Math.round(minimap.height * dpr);
    const canvas = minimap.canvas;
    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== H) canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const heatW = Math.round(HEAT_WIDTH * dpr);
    const texX = heatW + Math.round(HEAT_GAP * dpr);
    const texW = W - texX;
    const docH = Math.max(1, minimap.docHeight);
    const ys = H / docH;

    // x axis spans the area the matches occupy, so narrow logs still fill the map
    let minX = Infinity;
    let maxX = -Infinity;
    for (const m of shown) {
      if (m.left < minX) minX = m.left;
      if (m.left + m.width > maxX) maxX = m.left + m.width;
    }
    const spanX = Math.max(1, maxX - minX);
    const xs = texW / spanX;

    const counts = new Uint16Array(W * H);
    const worst = new Uint8Array(W * H).fill(255);
    const rowWeight = new Float32Array(H);
    let maxCount = 1;
    for (const m of shown) {
      const y0 = Math.min(H - 1, Math.max(0, Math.floor(m.top * ys)));
      const y1 = Math.min(H, Math.max(y0 + Math.max(1, Math.round(dpr)), Math.ceil((m.top + m.height) * ys)));
      const x0 = Math.min(W - 1, texX + Math.max(0, Math.floor((m.left - minX) * xs)));
      const x1 = Math.min(W, Math.max(x0 + 1, texX + Math.ceil((m.left + m.width - minX) * xs)));
      const weight = LEVEL_WEIGHTS[m.level];
      for (let y = y0; y < y1; y++) {
        rowWeight[y] += weight;
        const row = y * W;
        for (let x = x0; x < x1; x++) {
          const i = row + x;
          if (counts[i] < 65535) counts[i]++;
          if (counts[i] > maxCount) maxCount = counts[i];
          if (m.level < worst[i]) worst[i] = m.level;
        }
      }
    }

    const image = ctx.createImageData(W, H);
    const data = image.data;
    const logMax = Math.log1p(maxCount);
    for (let i = 0; i < counts.length; i++) {
      const c = counts[i];
      if (c === 0) continue;
      const level = worst[i];
      const rgb = MAP_RGB[level];
      const alpha = (0.65 + 0.35 * (Math.log1p(c) / logMax)) * TIER_ALPHA[level];
      const o = i * 4;
      data[o] = rgb[0];
      data[o + 1] = rgb[1];
      data[o + 2] = rgb[2];
      data[o + 3] = Math.round(alpha * 255);
    }

    // density heat strip on the left: smoothed severity-weighted density
    const radius = Math.max(2, Math.round(H / 120));
    const smooth = new Float32Array(H);
    let acc = 0;
    for (let y = 0; y < H + radius; y++) {
      if (y < H) acc += rowWeight[y];
      if (y - 2 * radius - 1 >= 0) acc -= rowWeight[y - 2 * radius - 1];
      const center = y - radius;
      if (center >= 0 && center < H) smooth[center] = acc;
    }
    let maxHeat = 0;
    for (let y = 0; y < H; y++) if (smooth[y] > maxHeat) maxHeat = smooth[y];
    if (maxHeat > 0) {
      for (let y = 0; y < H; y++) {
        const t = smooth[y] / maxHeat;
        if (t < 0.04) continue;
        // amber -> red as density rises
        const r = Math.round(245 + (220 - 245) * t);
        const g = Math.round(158 + (38 - 158) * t);
        const b = Math.round(11 + (38 - 11) * t);
        const a = Math.round(Math.min(1, 0.25 + 0.75 * Math.pow(t, 0.7)) * 255);
        for (let x = 0; x < heatW; x++) {
          const o = (y * W + x) * 4;
          data[o] = r;
          data[o + 1] = g;
          data[o + 2] = b;
          data[o + 3] = a;
        }
      }
    }
    ctx.putImageData(image, 0, 0);

    // top hotspots: dark ticks across the heat strip
    ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
    for (const spot of state.hotspots) {
      const y = Math.round(spot.anchor.top * ys);
      ctx.fillRect(0, Math.max(0, y - dpr), heatW, Math.max(1, Math.round(2 * dpr)));
    }
    minimap.base = { image: ctx.getImageData(0, 0, W, H), ys, texX, texW, dpr };
    // current match: blue line across the texture
    paintCurrentLine(ctx, minimap.base);
  }

  function updateSlider() {
    minimap.scrollFrame = 0;
    if (!minimap.host || !minimap.slider) return;
    const H = minimap.height;
    const docH = Math.max(1, minimap.docHeight);
    const top = (window.scrollY / docH) * H;
    const height = Math.max(4, (window.innerHeight / docH) * H);
    minimap.slider.style.top = Math.min(H - 4, top) + 'px';
    minimap.slider.style.height = Math.min(H, height) + 'px';
  }

  function onWindowScroll() {
    if (!minimap.scrollFrame) minimap.scrollFrame = requestAnimationFrame(updateSlider);
  }

  function mapY(event) {
    const rect = minimap.map.getBoundingClientRect();
    return Math.min(rect.height, Math.max(0, event.clientY - rect.top));
  }

  function scrollToMapY(y) {
    const docY = (y / minimap.height) * minimap.docHeight;
    window.scrollTo({ top: docY - window.innerHeight / 2, behavior: 'instant' });
  }

  // most severe match within a few minimap pixels of y, then the nearest
  function matchNearMapY(y) {
    const list = minimap.shown;
    if (list.length === 0) return null;
    const scale = minimap.docHeight / minimap.height;
    const docY = y * scale;
    const tolerance = scale * 4;
    let i = firstIndexAtOrAfter(list, docY - tolerance);
    let best = null;
    for (; i < list.length && list[i].top <= docY + tolerance; i++) {
      const m = list[i];
      if (!best || m.level < best.level ||
        (m.level === best.level && Math.abs(m.top - docY) < Math.abs(best.top - docY))) best = m;
    }
    return best;
  }

  function showMapTip(y) {
    const m = matchNearMapY(y);
    if (!m) {
      hideMapTip();
      return;
    }
    minimap.tip.textContent = contextLine(m, 90) || '…';
    minimap.tip.style.top = (minimap.map.offsetTop + y) + 'px';
    minimap.tip.classList.add('show');
  }

  function hideMapTip() {
    if (minimap.tip) minimap.tip.classList.remove('show');
  }

  function onMapPointerDown(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    minimap.map.setPointerCapture(event.pointerId);
    minimap.drag = { startY: event.clientY, moved: false };
    hideMapTip();
    scrollToMapY(mapY(event));
  }

  function onMapPointerMove(event) {
    const y = mapY(event);
    if (minimap.drag) {
      if (Math.abs(event.clientY - minimap.drag.startY) > 3) minimap.drag.moved = true;
      scrollToMapY(y);
      return;
    }
    showMapTip(y);
  }

  function onMapPointerUp(event) {
    const drag = minimap.drag;
    minimap.drag = null;
    if (!drag || drag.moved) return;
    // a click on a match jumps to it and makes it the current match
    const m = matchNearMapY(mapY(event));
    if (!m) return;
    const index = state.visible.indexOf(m);
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
    let lead = '';
    let tail = '';
    if (end - start > limit) {
      const lineStart = start;
      const lineEnd = end;
      start = Math.max(start, offset - Math.floor(limit / 3));
      // do not start mid-word: move to the next space when one is close
      if (start > lineStart) {
        const space = text.indexOf(' ', start);
        if (space !== -1 && space < offset && space - start < 20) start = space + 1;
        lead = '\u2026';
      }
      end = Math.min(end, start + limit);
      if (end < lineEnd) tail = '\u2026';
    }
    return lead + text.slice(start, end).replace(/\s+/g, ' ').trim() + tail;
  }

  // ============================================================
  // PATTERNS: group problem lines by shape ("5,470 matches = 12 errors")
  // ============================================================
  // like log-pattern features in log platforms: numbers, ids, paths,
  // timestamps and quoted values are masked, identical shapes are counted
  // once, and each group remembers its first occurrence (often the cause).

  let patternCache = null;

  function patternSignature(line) {
    return line
      .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<ts>')
      .replace(/\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, '<t>')
      .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
      .replace(/\b[0-9a-f]{12,}\b/gi, '<id>')
      .replace(/(?:[A-Za-z]:)?(?:[\/\\][\w.@+-]+){2,}/g, '<path>')
      .replace(/(["'`])(?:(?!\1).){1,80}\1/g, '<str>')
      .replace(/\d+(?:\.\d+)*/g, '<n>')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
  }

  async function computePatterns(maxLevel) {
    const key = state.seq + ':' + layout.version + ':' + maxLevel;
    if (patternCache && patternCache.key === key) return patternCache.groups;
    const seq = state.seq;
    const version = layout.version;
    const groups = new Map();
    let prevTop = NaN;
    let prevLine = null;
    let processed = 0;
    let deadline = performance.now() + SLICE_MS;
    for (const m of state.visible) {
      if (m.level > maxLevel || m.dead) continue;
      const line = contextLine(m, 200);
      // a second keyword on the same line is the same problem
      if (m.top === prevTop && line === prevLine) continue;
      prevTop = m.top;
      prevLine = line;
      if (!line) continue;
      const sig = patternSignature(line);
      let group = groups.get(sig);
      if (!group) {
        group = { count: 0, level: m.level, first: m, sample: line };
        groups.set(sig, group);
      }
      group.count++;
      if (m.level < group.level) group.level = m.level;
      if (++processed >= 20000) break;
      if ((processed & 63) === 0 && performance.now() > deadline) {
        await yieldToMain();
        // superseded by a newer layout: keep showing the last complete result
        if (seq !== state.seq || version !== layout.version) return patternCache ? patternCache.groups : [];
        deadline = performance.now() + SLICE_MS;
      }
    }
    // most severe first; within a severity, earliest first (likely the cause)
    const list = Array.from(groups.values()).sort((a, b) => (a.level - b.level) || (a.first.top - b.first.top));
    patternCache = { key, groups: list };
    return list;
  }

  function describePatterns(list, limit) {
    const docHeight = documentHeight();
    return list.slice(0, limit).map((g, index) => ({
      index,
      count: g.count,
      level: g.level,
      sample: g.sample.slice(0, 400),
      position: Math.min(100, Math.round((g.first.top / docHeight) * 100)) + '%'
    }));
  }

  function jumpToPattern(index) {
    const group = patternCache && patternCache.groups[index];
    if (!group || group.first.dead) return false;
    if (state.hidden.has(group.first.level)) setLayer(group.first.level, true);
    const at = state.visible.indexOf(group.first);
    return at >= 0 && setCurrent(at, true);
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
    const ok = scrollToMatch(match, center);
    drawMinimapCurrent();
    return ok;
  }

  function levelFilter(level) {
    const shown = m => !state.hidden.has(m.level);
    if (level === null || level === undefined) return shown;
    if (level === 'other') return m => m.level >= 4 && shown(m);
    return m => m.level === level && shown(m);
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
    // asking for a hidden severity turns its layer back on
    if (level !== null && level !== undefined && groupLevels(level).every(l => state.hidden.has(l))) {
      setLayer(level, true);
    }
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
      hiddenLevels: Array.from(state.hidden).sort(),
      autoSuppressed: state.autoSuppressed,
      partial: state.partial,
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
    const uiChange = changes[Core.STORAGE.ui];
    if (uiChange) {
      ui = Core.normalizeUi(uiChange.newValue);
      if (state.matcher && !state.running) renderDerived();
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
      case 'toggleLayer': {
        const ok = setLayer(message.level, message.visible);
        sendResponse(Object.assign({ success: ok }, buildSummary()));
        return false;
      }
      case 'patterns':
        computePatterns(message.maxLevel === undefined ? 2 : message.maxLevel)
          .then(list => sendResponse({ total: list.length, patterns: describePatterns(list, message.limit || 30) }))
          .catch(error => sendResponse({ total: 0, patterns: [], error: error.message }));
        return true;
      case 'jumpToPattern': {
        const ok = jumpToPattern(message.index);
        broadcast(false);
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
    setVirtualActive(false);
    clearTimeout(rerunTimer);
    clearTimeout(broadcastTimer);
    if (visibilityHandler) document.removeEventListener('visibilitychange', visibilityHandler);
  }

  function destroy() {
    teardownOrphan();
    unregisterHighlights();
    if (overlay) overlay.remove();
    overlay = null;
    removeMinimap();
    try {
      chromeRef.runtime.onMessage.removeListener(onMessage);
      chromeRef.storage.onChanged.removeListener(onStorageChanged);
    } catch (e) {
      // context already invalidated
    }
  }

  globalThis.__rsearchContent = { isAlive, destroy };

  for (const id of [OVERLAY_ID, MINIMAP_ID]) {
    const stale = document.getElementById(id);
    if (stale) stale.remove();
  }

  chromeRef.runtime.onMessage.addListener(onMessage);
  chromeRef.storage.onChanged.addListener(onStorageChanged);

  // back/forward cache restores keep our state, but the badge was reset on navigation
  window.addEventListener('pageshow', event => {
    if (event.persisted && state.matcher && isAlive()) broadcast(true);
  });

  // display preferences apply to manual searches too, so load them up front
  Core.loadSettings().then(settings => {
    ui = settings.ui;
    if (state.matcher && !state.running && state.visible.length) renderDerived();
  }).catch(() => {});

  autoStart();
})();
