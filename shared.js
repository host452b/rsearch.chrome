// RSearch shared core.
// Loaded by popup.html (<script>), background.js (importScripts) and injected
// into pages right before content.js. No dependencies, no network access.
(function (root) {
  'use strict';

  // ============================================================
  // STORAGE
  // ============================================================

  const STORAGE = {
    presets: 'rsearch_presets_v2',
    activePreset: 'activePresetIndex',
    autoEnabled: 'autoSearchEnabled',
    options: 'rsearch_options',
    disabledHosts: 'rsearch_disabled_hosts',
    defaultsVersion: 'rsearch_defaults_version',
    ui: 'rsearch_ui'
  };

  const STORAGE_KEYS = Object.values(STORAGE);

  // bump when DEFAULT_ROWS / DEFAULT_IGNORE change so untouched default presets get upgraded
  const DEFAULTS_VERSION = 3;

  // FNV-1a hashes of default preset CSVs shipped by earlier versions
  // (3.4.0, 3.5.0). a stored preset with one of these hashes was never
  // edited by the user.
  const LEGACY_DEFAULT_HASHES = ['9f112079', '919ce151'];

  const MAX_KEYWORDS = 500;
  const HOST_PERMISSION = { origins: ['<all_urls>'] };
  const DEFAULT_OPTIONS = { ignoreCase: true, smartMatch: true };
  // minimap: 'expanded' | 'collapsed' | 'off'
  const DEFAULT_UI = { minimap: 'expanded' };

  // ============================================================
  // SEVERITY LEVELS
  // ============================================================
  // colors come from the CLAUDE.md palette. levels are layered by visual
  // weight, not just hue, so a busy log does not turn into a rainbow wall:
  //   solid fill  -> critical, error   (must see)
  //   tinted fill -> problem, custom   (should see)
  //   underline   -> warning, notice   (may see)
  // `style` mirrors the ::highlight rules in styles.css.

  const LEVELS = [
    { id: 'critical', label: 'Critical', bg: '#DC2626', fg: '#FFFFFF', style: 'solid' },
    { id: 'error', label: 'Error', bg: '#F97316', fg: '#0F172A', style: 'solid' },
    { id: 'problem', label: 'Problem', bg: '#F59E0B', fg: '#0F172A', style: 'tint' },
    { id: 'warning', label: 'Warning', bg: '#EAB308', fg: '#0F172A', style: 'wavy' },
    { id: 'notice', label: 'Notice', bg: '#94A3B8', fg: '#0F172A', style: 'dotted' },
    { id: 'custom-green', label: 'Other', bg: '#22C55E', fg: '#0F172A', style: 'tint' },
    { id: 'custom-cyan', label: 'Other', bg: '#06B6D4', fg: '#0F172A', style: 'tint' },
    { id: 'custom-pink', label: 'Other', bg: '#EC4899', fg: '#0F172A', style: 'tint' }
  ];

  // ============================================================
  // DEFAULT PRESET - ERROR KEYWORDS
  // ============================================================
  // each row: [severity level, ...keywords]
  // row order defines the CSV rank. append new keywords at the end.
  // levels: 0 critical, 1 error, 2 problem, 3 warning, 4 notice

  const DEFAULT_ROWS = [
    // --- basic error terms ---
    [1, 'error', 'fail', 'failed', 'failure'],
    [0, 'fatal'],
    [1, 'exception'],
    [0, 'crash', 'abort', 'aborted', 'panic'],
    [3, 'warning'],
    [0, 'critical', 'severe'],
    [2, 'timeout', 'invalid', 'denied', 'refused', 'rejected', 'missing'],
    [1, 'corrupt', 'corrupted'],
    [2, 'overflow', 'terminated'],
    [1, 'unhandled'],
    [2, 'unexpected'],
    [1, 'illegal'],
    [2, 'unreachable'],

    // --- unix signals ---
    [0, 'sigsegv', 'sigabrt', 'sigfpe', 'sigbus', 'sigill', 'sigtrap', 'sigkill', 'sigsys'],
    [2, 'sigterm', 'sigpipe'],
    [0, 'sigxcpu', 'sigxfsz'],

    // --- process states ---
    [0, 'killed'],
    [1, 'traceback'],
    [0, 'segfault', 'coredump'],
    [1, 'backtrace'],

    // --- errno codes ---
    [0, 'enomem'],
    [1, 'einval', 'bad address', 'eacces', 'enoent', 'eperm', 'ebadf', 'enospc', 'emfile', 'enfile', 'ebusy', 'eexist', 'epipe'],
    [2, 'eagain', 'etimedout'],
    [1, 'econnreset', 'econnrefused', 'enotconn'],

    // --- python exceptions ---
    [1, 'typeerror', 'valueerror', 'keyerror', 'indexerror', 'nameerror', 'syntaxerror', 'runtimeerror'],
    [0, 'memoryerror'],
    [1, 'oserror', 'ioerror', 'assertionerror', 'importerror', 'attributeerror', 'overflowerror',
      'recursionerror', 'permissionerror', 'timeouterror', 'indentationerror', 'taberror', 'systemerror',
      'zerodivisionerror', 'filenotfounderror', 'modulenotfounderror', 'notimplementederror',
      'unboundlocalerror', 'unicodedecodeerror', 'unicodeencodeerror', 'brokenpipeerror', 'connectionerror',
      'connectionrefusederror', 'connectionabortederror', 'blockingioerror', 'childprocesserror',
      'interruptederror', 'floatingpointerror'],
    [4, 'stopiteration', 'generatorexit'],
    [2, 'systemexit', 'keyboardinterrupt'],

    // --- cuda errors ---
    [1, 'cudaerror', 'cuda_error'],
    [0, 'bad_alloc', 'oom-killer', 'cudaerrormemoryallocation'],
    [1, 'cudaerrorinvaliddevice', 'cudaerrorinvalidvalue'],
    [0, 'cudaerrorlaunchfailure', 'cudaerrorlaunchtimeout'],
    [1, 'cudaerrornodevice'],
    [0, 'cudaerrorassert'],
    [1, 'cudaerrorunknown', 'cudaerrorinvalidptx'],
    [0, 'cudaerrorillegaladdress'],
    [1, 'cudaerrorinsufficientdriver', 'cudaerrorinvalidconfiguration', 'cudaerrorlaunchoutofresources',
      'cudaerrorinvaliddevicefunction'],

    // --- cublas / cudnn status ---
    [1, 'cublas_status_execution_failed', 'cublas_status_alloc_failed', 'cublas_status_invalid_value',
      'cudnn_status_bad_param', 'cudnn_status_execution_failed', 'cudnn_status_internal_error',
      'cudnn_status_not_supported'],

    // --- tensorrt severity ---
    [1, 'severity::kerror'],
    [0, 'severity::kinternal_error'],
    [2, 'kinvalid'],

    // --- nvidia driver ---
    [0, 'xid'],
    [1, 'nvrm'],

    // --- sanitizers ---
    [0, 'asan', 'lsan', 'tsan', 'ubsan', 'msan', 'addresssanitizer', 'leaksanitizer', 'threadsanitizer',
      'memorysanitizer', 'undefinedbehaviorsanitizer'],

    // --- c++ exceptions ---
    [1, 'std::runtime_error', 'std::logic_error', 'std::out_of_range', 'std::invalid_argument',
      'std::bad_cast', 'std::bad_typeid', 'thrust::system_error'],

    // --- msvc linker errors ---
    [1, 'lnk2001', 'lnk2019', 'lnk1120'],

    // --- general error states ---
    [0, 'oops'],
    [2, 'leaked', 'leaking'],
    [0, 'crashing', 'crashed'],
    [1, 'failing'],
    [0, 'aborting'],
    [2, 'dead', 'hung', 'stuck', 'frozen', 'blocked', 'unresponsive', 'halted', 'broken'],
    [0, 'segv', 'abrt'],
    [1, 'assertion'],
    [2, 'thrown', 'raised', 'leak'],
    [1, 'faults', 'errors', 'failures', 'exceptions'],
    [0, 'crashes', 'aborts', 'panics'],
    [2, 'underflow'],
    [1, 'misaligned'],
    [0, 'deadlock', 'deadlocked'],
    [1, 'violation'],
    [2, 'starvation'],
    [3, 'contention'],
    [2, 'unavailable'],

    // --- additional python exceptions ---
    [3, 'syntaxwarning'],
    [1, 'buffererror', 'fileexistserror', 'isadirectoryerror', 'notadirectoryerror', 'arithmeticerror'],
    [4, 'stopasynciteration'],
    [1, 'unicodetranslateerror', 'unicodeerror', 'connectionreseterror', 'lookuperror', 'referenceerror'],

    // --- c/c++ syntax & parse errors ---
    [1, 'syntax error', 'parse error', 'stray', 'lvalue required'],
    [2, 'incompatible', 'type mismatch'],
    [1, 'invalid conversion'],

    // --- c/c++ identifier errors ---
    [1, 'undeclared'],
    [3, 'implicit declaration'],
    [1, 'redefinition', 'multiple definition'],
    [3, 'unused variable', 'unused parameter', 'uninitialized'],
    [1, 'unresolved'],

    // --- c/c++ preprocessor errors ---
    [1, 'unterminated', '#error'],
    [3, '#warning'],

    // --- c/c++ linker errors ---
    [2, 'no such file'],
    [0, 'fatal error'],
    [1, 'undefined reference', 'undefined symbol', 'library not found', 'linker command failed'],
    [2, 'relocation'],
    [1, 'ld returned', 'collect2'],
    [2, 'cannot find'],

    // --- c/c++ memory & pointer errors ---
    [1, 'dereferencing', 'null pointer', 'dangling pointer'],
    [0, 'double free', 'use after free', 'heap-buffer-overflow', 'stack-buffer-overflow'],
    [2, 'memory leak'],
    [1, 'out of bounds'],
    [2, 'array subscript'],
    [0, 'buffer overflow', 'stack smashing'],

    // --- c/c++ class & template errors ---
    [1, 'no member named'],
    [2, 'vtable'],
    [1, 'abstract class', 'pure virtual'],
    [2, 'template argument'],
    [1, 'No module named', 'no viable', 'private member', 'protected member', 'incomplete type'],

    // --- c/c++ constant & expression errors ---
    [2, 'non-constant'],
    [3, 'narrowing conversion'],

    // --- c/c++ compiler warnings ---
    [3, 'fall-through', 'stack protector', 'deprecated', 'discards qualifiers', 'Wformat'],
    [1, 'Werror'],

    // --- runtime crash signals ---
    [0, 'Segmentation fault', 'Bus error', 'Floating point exception', 'Illegal instruction', 'core dumped', 'Aborted'],

    // --- pytorch onnx export errors ---
    [1, 'ONNXCheckerError', 'TorchONNXOperatorSupportError', 'UnsupportedOperatorError',
      'TorchScriptSyntaxError', 'GraphConstructionError', 'export failed'],

    // --- onnx model errors ---
    [1, 'InvalidProtobufError', 'MissingAttributeError', 'InvalidGraphError', 'TypeInferenceError',
      'InvalidModelError'],
    [2, 'onnx.checker'],
    [1, 'ValidationError'],
    [2, 'shape inference'],

    // --- onnxruntime errors ---
    [1, 'OrtException', 'ExecutionProviderError', 'NoRegisteredKernelForOperator', 'SessionCreationError',
      'InvalidInputShapeError', 'EPInitializationFailure', 'RuntimeShapeInferenceError'],

    // --- vllm errors ---
    [1, 'PagedAttentionError', 'BlockAllocatorError', 'WorkerError', 'ModelLoaderError', 'ParallelConfigError',
      'SchedulerError', 'KVCacheLimitError', 'UnsupportedModelArchitectureError'],

    // --- sglang errors ---
    [1, 'RadixAttentionError', 'EngineInitializationError', 'RadixTreeError', 'BackendNotSupportedError',
      'PrefillError', 'RequestAbortedError'],

    // --- ml framework common errors ---
    [1, 'OperatorNotFoundError', 'VersionMismatchError', 'IncompatibleDTypeError'],
    [3, 'DeprecatedOperatorWarning'],

    // --- cuda & device errors ---
    [1, 'RuntimeError: CUDA', 'CUDARuntimeError', 'DeviceMismatchError', 'InvalidDeviceError',
      'TensorRTCompatibilityError'],

    // --- memory & oom errors ---
    [0, 'OutOfMemoryError', 'cuda out of memory', 'MemoryAllocationError', 'DoubleFreeError'],
    [3, 'MemoryLeakWarning'],
    [0, 'OOM', 'out of memory'],
    [2, 'memory allocation'],

    // --- environment & installation errors ---
    [1, 'DlOpenError', 'cannot open shared object', 'CompilerError', 'nvcc not found',
      'BrokenInstallationError', 'UnsupportedPythonVersionError'],

    // --- distributed & nccl errors ---
    [1, 'NCCLError', 'DistributedBackendError', 'PeerAccessError', 'CommunicationAbortedError'],

    // --- tensor shape errors ---
    [1, 'ShapeMismatchError', 'InvalidBatchSizeError', 'EmptyTensorError', 'DimensionOutOfBoundsError'],
    [2, 'mismatch'],

    // --- model weight errors ---
    [1, 'SafetensorsError', 'CheckpointCorruptedError', 'InvalidTensorNameError', 'SerializationError'],
    [2, 'missing keys', 'unexpected keys'],

    // --- incompatibility errors ---
    [2, 'not compatible', 'not supported', 'unsupported', 'version conflict', 'conflict', 'conflicting',
      'ABI mismatch', 'binary incompatible', 'API mismatch', 'protocol mismatch', 'does not match'],
    [4, 'expected', 'requires', 'required'],
    [3, 'breaking change'],
    [2, 'backward incompatible', 'cannot be used', 'incompatible version', 'incompatible type',
      'architecture mismatch', 'platform mismatch', 'dependency conflict', 'package conflict'],

    // --- specific patterns ---
    [1, '[E]', 'error:'],
    [2, 'Could not'],

    // ---- added in 3.5.0 ----

    // --- log levels & ci markers ---
    [3, 'warn', '[W]'],
    [1, 'errored', 'ERR!', 'ELIFECYCLE', 'Caused by', 'uncaught', 'stack trace', 'stacktrace', 'exit code', 'exit status',
      'exitcode', 'non-zero', 'errno', 'fails', 'fault', 'NaN'],
    [0, 'panicked'],
    [2, 'leaks'],

    // --- timeouts, io & network ---
    [2, 'timed out', 'unable to', 'cannot', 'not found', 'not permitted'],
    [1, 'no space left', 'too many open files', 'read-only file system', 'address already in use',
      'eaddrinuse', 'econnaborted', 'ehostunreach', 'enetunreach', 'eio', 'erofs'],
    [2, 'connection reset', 'reset by peer', 'broken pipe', 'name or service not known', 'interrupted',
      'giving up', 'exceeded', 'expired', 'exhausted', 'insufficient', 'not implemented', 'unimplemented',
      'unrecognized', 'no matching'],
    [3, 'cancelled', 'canceled', 'retrying'],
    [1, 'undefined behavior', 'ResolutionImpossible'],

    // --- http & auth ---
    [2, 'unauthorized', 'unauthenticated', 'forbidden', 'bad gateway', 'bad request', 'too many requests',
      'rate limit'],

    // --- kubernetes & containers ---
    [0, 'OOMKilled', 'CrashLoopBackOff'],
    [1, 'ImagePullBackOff', 'ErrImagePull'],
    [2, 'back-off', 'Evicted', 'DeadlineExceeded', 'Unschedulable', 'NotReady', 'manifest unknown',
      'no such image', 'toomanyrequests'],

    // --- memory safety & sanitizers ---
    [0, 'heap-use-after-free', 'use-after-free', 'stack-use-after-return', 'double-free',
      'global-buffer-overflow', 'stack overflow', 'data race', 'kasan', 'cannot allocate memory',
      'general protection'],
    [1, 'nil pointer', 'dereference'],

    // --- kernel & gpu ---
    [1, 'call trace'],
    [0, 'lockup', 'machine check', 'uncorrectable', 'fallen off the bus', 'gpu is lost', 'device-side assert',
      'illegal memory access'],
    [1, 'no cuda-capable device', 'cublas_status_not_initialized', 'cublas_status_internal_error',
      'cublas_status_not_supported', 'cudnn_status_alloc_failed', 'cudnn_status_arch_mismatch']
  ];

  // ignore rules ("ok" rules, as in Jenkins' Log Parser plugin): a keyword
  // match overlapping one of these is not a problem. covers success summaries
  // like "Failures: 0, Errors: 0", "412 passed, 0 failed", "0 Error(s)".
  //   !phrase        literal, must stand alone (so "!0 errors" keeps "10 errors")
  //   !/regex/flags  pattern
  const DEFAULT_IGNORE = [
    '!/\\b(?:errors?|failures?|failed|warnings?|exceptions?|crash(?:es)?)\\s*[:=]\\s*0(?![\\d.])/i',
    '!/(?<![\\d.])0\\s+(?:errors?|failures?|failed|warnings?|error\\(s\\)|warning\\(s\\)|exceptions?|crash(?:es)?)(?![a-z])/i',
    '!no errors',
    '!no failures',
    '!without errors',
    '!continue-on-error',
    '!fail-fast',
    '!ignore_errors',
    '!ignore-errors',
    '!Warning: Permanently added'
  ];

  // flatten rows, dropping case-insensitive duplicates (first wins)
  const DEFAULT_KEYWORDS = [];
  const BUILTIN_LEVELS = new Map();
  for (const row of DEFAULT_ROWS) {
    const level = row[0];
    for (let i = 1; i < row.length; i++) {
      const kw = row[i];
      const key = kw.toLowerCase();
      if (BUILTIN_LEVELS.has(key)) continue;
      BUILTIN_LEVELS.set(key, level);
      DEFAULT_KEYWORDS.push(kw);
    }
  }

  // heuristics for keywords outside the built-in list (user presets, regex matches)
  const LEVEL_HEURISTICS = [
    [0, /fatal|panic|crash|segfault|segmentation|sigsegv|sigabrt|sigkill|core ?dump|out of memory|oom|killed|abort|critical|emerg|severe/],
    [1, /error|exception|fail|traceback|assert/],
    [2, /timeout|timed out|invalid|denied|refused|missing|not found|unable|cannot|could not|mismatch|unsupported|conflict|reject/],
    [3, /warn|deprecat/]
  ];

  function classifyKeyword(keyword, index) {
    const key = String(keyword).toLowerCase();
    const builtin = BUILTIN_LEVELS.get(key);
    if (builtin !== undefined) return builtin;
    for (const [level, re] of LEVEL_HEURISTICS) {
      if (re.test(key)) return level;
    }
    // unknown keyword: cycle through the tinted custom colors so different
    // custom keywords stay distinguishable without claiming a severity
    return 5 + ((index || 0) % 3);
  }

  // ============================================================
  // CSV PRESETS
  // ============================================================

  function generatePresetCsv(keywords) {
    const lines = ['rank,key_word'];
    keywords.forEach((kw, i) => lines.push((i + 1) + ',' + kw));
    return lines.join('\n');
  }

  const DEFAULT_PRESET_CSV = generatePresetCsv(DEFAULT_KEYWORDS.concat(DEFAULT_IGNORE));

  function isIgnoreRule(keyword) {
    return typeof keyword === 'string' && keyword.length > 1 && keyword[0] === '!';
  }

  // { keywords, ignores } counts for display
  function countRules(keywords) {
    let ignores = 0;
    for (const k of keywords || []) if (isIgnoreRule(String(k).trim())) ignores++;
    return { keywords: (keywords || []).length - ignores, ignores };
  }

  // compile one ignore rule; null when it is not valid
  function compileIgnoreRule(rule, ignoreCase) {
    const body = rule.slice(1);
    if (!body) return null;
    const asRegex = /^\/(.+)\/([a-z]*)$/.exec(body);
    if (asRegex) {
      try {
        const flags = asRegex[2].replace(/[^imsu]/g, '');
        return new RegExp(asRegex[1], Array.from(new Set(flags + 'g')).join(''));
      } catch (e) {
        return null;
      }
    }
    const escaped = body.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&');
    const alnum = /[A-Za-z0-9]/;
    const left = alnum.test(body[0]) ? '(?<![A-Za-z0-9])' : '';
    const right = alnum.test(body[body.length - 1]) ? '(?![A-Za-z0-9])' : '';
    return new RegExp(left + escaped + right, ignoreCase ? 'gi' : 'g');
  }

  const COMMON_ERRORS_CSV = generatePresetCsv([
    'error', 'warning', 'info', 'debug', 'trace', 'fatal', 'critical', 'notice', 'alert', 'emerg'
  ]);

  const EMPTY_CSV = 'rank,key_word';

  function getDefaultPresets() {
    return [
      { name: 'Error Keywords', csv: DEFAULT_PRESET_CSV },
      { name: 'Common Errors', csv: COMMON_ERRORS_CSV },
      { name: 'Custom', csv: EMPTY_CSV }
    ];
  }

  // parse "rank,key_word" csv; returns keywords sorted by rank (max MAX_KEYWORDS)
  function parseCsvToKeywords(csvContent) {
    const lines = String(csvContent || '').trim().split('\n');
    if (lines.length === 0) return [];

    const firstLine = lines[0].trim().toLowerCase();
    const hasHeader = firstLine.includes('rank') && firstLine.includes('key');
    const dataLines = hasHeader ? lines.slice(1) : lines;

    const entries = [];
    for (const line of dataLines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const comma = trimmed.indexOf(',');
      if (comma === -1) continue;
      const rank = parseInt(trimmed.substring(0, comma).trim(), 10);
      const keyword = trimmed.substring(comma + 1).trim();
      if (isNaN(rank) || !keyword) continue;
      entries.push({ rank, keyword });
    }

    entries.sort((a, b) => a.rank - b.rank);
    return entries.slice(0, MAX_KEYWORDS).map(e => e.keyword);
  }

  // split a comma separated input; spaces inside keywords are preserved
  function parseKeywordInput(input) {
    return String(input || '')
      .split(',')
      .map(k => k.trim())
      .filter(k => k.length > 0);
  }

  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16);
  }

  function isLegacyDefaultCsv(csv) {
    return typeof csv === 'string' && LEGACY_DEFAULT_HASHES.includes(fnv1a(csv));
  }

  // ============================================================
  // SETTINGS
  // ============================================================

  function normalizeUi(value) {
    const ui = Object.assign({}, DEFAULT_UI, value && typeof value === 'object' ? value : {});
    if (!['expanded', 'collapsed', 'off'].includes(ui.minimap)) ui.minimap = DEFAULT_UI.minimap;
    return ui;
  }

  function normalizeSettings(raw) {
    raw = raw || {};
    let presets = raw[STORAGE.presets];
    if (!Array.isArray(presets) || presets.length === 0) {
      presets = getDefaultPresets();
    } else {
      presets = presets.map(p => ({
        name: (p && typeof p.name === 'string' && p.name) || 'Preset',
        csv: (p && typeof p.csv === 'string') ? p.csv : EMPTY_CSV
      }));
      while (presets.length < 3) {
        presets.push({ name: 'Custom ' + (presets.length + 1), csv: EMPTY_CSV });
      }
    }

    let activePresetIndex = raw[STORAGE.activePreset];
    if (!Number.isInteger(activePresetIndex) || activePresetIndex < 0 || activePresetIndex >= presets.length) {
      activePresetIndex = 0;
    }

    const storedOptions = raw[STORAGE.options] && typeof raw[STORAGE.options] === 'object' ? raw[STORAGE.options] : {};

    return {
      presets,
      activePresetIndex,
      // auto-highlight is ON unless the user explicitly turned it off
      autoEnabled: raw[STORAGE.autoEnabled] !== false,
      options: Object.assign({}, DEFAULT_OPTIONS, storedOptions),
      ui: normalizeUi(raw[STORAGE.ui]),
      disabledHosts: Array.isArray(raw[STORAGE.disabledHosts]) ? raw[STORAGE.disabledHosts] : []
    };
  }

  async function loadSettings() {
    const raw = await chrome.storage.local.get(STORAGE_KEYS);
    return normalizeSettings(raw);
  }

  function getActiveKeywords(settings) {
    const preset = settings.presets[settings.activePresetIndex];
    return preset ? parseCsvToKeywords(preset.csv) : [];
  }

  // ============================================================
  // URL HELPERS
  // ============================================================

  function hostFromUrl(url) {
    try {
      const u = new URL(url);
      if (u.protocol === 'file:') return 'file://';
      return u.hostname;
    } catch (e) {
      return '';
    }
  }

  // pages where chrome never lets extensions run
  function isRestrictedUrl(url) {
    if (!url) return true;
    if (!/^(https?|file):/i.test(url)) return true;
    if (url.startsWith('https://chromewebstore.google.com')) return true;
    if (url.startsWith('https://chrome.google.com/webstore')) return true;
    return false;
  }

  function formatCount(n) {
    if (n < 1000) return String(n);
    if (n < 10000) return (Math.floor(n / 100) / 10).toFixed(1).replace(/\.0$/, '') + 'k';
    if (n < 100000) return Math.floor(n / 1000) + 'k';
    return '99k+';
  }

  // ============================================================
  // MATCHER
  // ============================================================
  // keywords compile into one prefix-trie regex (longest match wins at a
  // position, far fewer alternatives for V8 to try than a flat a|b|c list).
  // "smart match" post-filters candidates with word boundaries that also
  // understand camelCase, so 'error' still hits TypeError / CUDA_ERROR but
  // 'fault' no longer hits "default" and 'oom' no longer hits "zoom".
  // every keyword must start at a word boundary; short keywords must also
  // end at one ('fatal' skips "fatality", 'fails' skips "failsafe").

  const SHORT_KEYWORD_LETTERS = 5;

  function isLetterCode(c) {
    return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  }

  function isUpperCode(c) {
    return c >= 65 && c <= 90;
  }

  function isLowerCode(c) {
    return c >= 97 && c <= 122;
  }

  // is there a word boundary between text[pos - 1] and text[pos]?
  function isBoundary(text, pos) {
    if (pos <= 0 || pos >= text.length) return true;
    const a = text.charCodeAt(pos - 1);
    const b = text.charCodeAt(pos);
    if (!isLetterCode(a) || !isLetterCode(b)) return true;
    if (isLowerCode(a) && isUpperCode(b)) return true; // camelCase: typeError
    // acronym followed by a word: HTTPError, OOMKilled
    if (isUpperCode(a) && isUpperCode(b) && pos + 1 < text.length && isLowerCode(text.charCodeAt(pos + 1))) {
      return true;
    }
    return false;
  }

  function countLetters(str) {
    let n = 0;
    for (let i = 0; i < str.length; i++) {
      if (isLetterCode(str.charCodeAt(i))) n++;
    }
    return n;
  }

  const REGEX_SPECIAL = /[.*+?^${}()|[\]\\\/-]/;

  function escapeRegexChar(ch) {
    return REGEX_SPECIAL.test(ch) ? '\\' + ch : ch;
  }

  function buildTrieSource(keys) {
    const rootNode = { children: new Map(), end: false };
    for (const key of keys) {
      let node = rootNode;
      for (const ch of key) {
        let next = node.children.get(ch);
        if (!next) {
          next = { children: new Map(), end: false };
          node.children.set(ch, next);
        }
        node = next;
      }
      node.end = true;
    }

    // returns { src, atomic }; atomic sources can take a '?' suffix directly.
    // sibling branches always start with different characters, so their
    // order does not matter, and greedy '?' makes the longest keyword win.
    function emit(node) {
      const alternatives = [];
      const singles = [];
      for (const [ch, child] of node.children) {
        if (child.children.size === 0) {
          singles.push(escapeRegexChar(ch));
          continue;
        }
        const tail = emit(child);
        let tailSrc = tail.src;
        if (child.end) {
          tailSrc = (tail.atomic ? tailSrc : '(?:' + tailSrc + ')') + '?';
        }
        alternatives.push({ src: escapeRegexChar(ch) + tailSrc, atomic: false });
      }
      if (singles.length === 1) alternatives.push({ src: singles[0], atomic: true });
      if (singles.length > 1) alternatives.push({ src: '[' + singles.join('') + ']', atomic: true });

      if (alternatives.length === 1) return alternatives[0];
      return { src: '(?:' + alternatives.map(a => a.src).join('|') + ')', atomic: true };
    }

    return emit(rootNode).src;
  }

  function buildKeywordMatcher(keywords, options) {
    const ignoreCase = !options || options.ignoreCase !== false;
    const smartMatch = !options || options.smartMatch !== false;

    const lookup = new Map();
    const ignores = [];
    let levelIndex = 0;
    for (const raw of keywords || []) {
      const keyword = String(raw).trim();
      if (!keyword) continue;
      if (isIgnoreRule(keyword)) {
        const compiled = compileIgnoreRule(keyword, ignoreCase);
        if (compiled) ignores.push(compiled);
        continue;
      }
      const key = ignoreCase ? keyword.toLowerCase() : keyword;
      if (lookup.has(key)) continue;
      const first = keyword.charCodeAt(0);
      const last = keyword.charCodeAt(keyword.length - 1);
      lookup.set(key, {
        keyword,
        level: classifyKeyword(keyword, levelIndex++),
        guardLeft: smartMatch && isLetterCode(first),
        guardRight: smartMatch && isLetterCode(last) && countLetters(keyword) <= SHORT_KEYWORD_LETTERS
      });
    }

    if (lookup.size === 0) return null;


    const regex = new RegExp(buildTrieSource(Array.from(lookup.keys())), ignoreCase ? 'gi' : 'g');

    // ignore intervals are computed once per text (only texts with candidates)
    let ignoreText = null;
    let ignoreSpans = [];
    function ignoredSpans(text) {
      if (text === ignoreText) return ignoreSpans;
      ignoreText = text;
      ignoreSpans = [];
      for (const re of ignores) {
        re.lastIndex = 0;
        let m;
        let guard = 0;
        while ((m = re.exec(text)) !== null && guard++ < 10000) {
          if (m[0].length === 0) {
            re.lastIndex++;
            continue;
          }
          ignoreSpans.push(m.index, m.index + m[0].length);
        }
      }
      return ignoreSpans;
    }

    return {
      kind: 'keywords',
      regex,
      global: true,
      size: lookup.size,
      ignoreCount: ignores.length,
      // returns { keyword, level } or null when the candidate fails smart
      // boundaries or sits inside an ignored phrase
      resolve(text, start, end) {
        const matched = text.substring(start, end);
        const entry = lookup.get(ignoreCase ? matched.toLowerCase() : matched);
        if (entry) {
          if (entry.guardLeft && !isBoundary(text, start)) return null;
          if (entry.guardRight && !isBoundary(text, end)) return null;
        }
        if (ignores.length) {
          const spans = ignoredSpans(text);
          for (let i = 0; i < spans.length; i += 2) {
            if (start < spans[i + 1] && end > spans[i]) return null;
          }
        }
        return entry || { keyword: matched, level: 5 };
      }
    };
  }

  function buildRegexMatcher(pattern, flags) {
    const cleanFlags = String(flags || '').replace(/[^gimsuy]/g, '');
    const regex = new RegExp(pattern, cleanFlags.includes('g') ? cleanFlags : cleanFlags + 'g');
    const global = String(flags || '').includes('g');
    const cache = new Map();
    return {
      kind: 'regex',
      regex,
      global,
      size: 1,
      resolve(text, start, end) {
        const matched = text.substring(start, end);
        const key = matched.toLowerCase();
        let entry = cache.get(key);
        if (!entry) {
          entry = { keyword: matched, level: classifyKeyword(matched, 0) };
          if (cache.size < 5000) cache.set(key, entry);
        }
        return entry;
      }
    };
  }

  root.RSearchCore = {
    STORAGE,
    STORAGE_KEYS,
    DEFAULTS_VERSION,
    MAX_KEYWORDS,
    HOST_PERMISSION,
    DEFAULT_OPTIONS,
    DEFAULT_UI,
    LEVELS,
    DEFAULT_KEYWORDS,
    DEFAULT_PRESET_CSV,
    EMPTY_CSV,
    getDefaultPresets,
    generatePresetCsv,
    DEFAULT_IGNORE,
    isIgnoreRule,
    countRules,
    parseCsvToKeywords,
    parseKeywordInput,
    isLegacyDefaultCsv,
    fnv1a,
    classifyKeyword,
    normalizeSettings,
    normalizeUi,
    loadSettings,
    getActiveKeywords,
    hostFromUrl,
    isRestrictedUrl,
    formatCount,
    isBoundary,
    buildTrieSource,
    buildKeywordMatcher,
    buildRegexMatcher
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
