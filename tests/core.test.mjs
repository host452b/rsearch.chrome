// Unit tests for shared.js (keywords, matcher, settings). No dependencies:
//   node tests/core.test.mjs            run the tests
//   node tests/core.test.mjs --bench    also benchmark the matcher
import fs from 'fs';
import vm from 'vm';
import path from 'path';
import assert from 'assert';
import { fileURLToPath } from 'url';
import { sampleLines } from './fixtures/sample-log.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
vm.runInThisContext(fs.readFileSync(path.join(repo, 'shared.js'), 'utf8'));
const C = globalThis.RSearchCore;
const oldKeywords = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'keywords-v3.4.0.json'), 'utf8'));
const BENCH = process.argv.includes('--bench');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('ok   ' + name); }
  catch (e) { failures++; console.log('FAIL ' + name + '\n     ' + e.message); }
}

function findAll(matcher, text) {
  const out = [];
  const re = matcher.regex;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) { re.lastIndex++; continue; }
    const entry = matcher.resolve(text, m.index, m.index + m[0].length);
    if (!entry) { re.lastIndex = m.index + 1; continue; }
    out.push(m[0]);
  }
  return out;
}

// ---------- keyword list sanity ----------
check('default list keeps every old keyword', () => {
  const now = new Set(C.DEFAULT_KEYWORDS.map(k => k.toLowerCase()));
  const lost = oldKeywords.filter(k => !now.has(k.toLowerCase()));
  assert.deepStrictEqual(lost, []);
});
check('default list has no case-insensitive duplicates and fits MAX_KEYWORDS', () => {
  const lower = C.DEFAULT_KEYWORDS.map(k => k.toLowerCase());
  assert.strictEqual(new Set(lower).size, lower.length);
  const all = C.parseCsvToKeywords(C.DEFAULT_PRESET_CSV);
  assert.ok(all.length <= C.MAX_KEYWORDS, 'count ' + all.length);
  assert.strictEqual(all.length, C.DEFAULT_KEYWORDS.length + C.DEFAULT_IGNORE.length);
  assert.deepStrictEqual(C.countRules(all), { keywords: C.DEFAULT_KEYWORDS.length, ignores: C.DEFAULT_IGNORE.length });
});

check('ignore rules: success summaries are not problems, real failures still are', () => {
  const m = C.buildKeywordMatcher(C.parseCsvToKeywords(C.DEFAULT_PRESET_CSV), { ignoreCase: true, smartMatch: true });
  const quiet = [
    'Tests run: 128, Failures: 0, Errors: 0, Skipped: 2',
    '========== 412 passed, 0 failed, 3 skipped in 81.2s ==========',
    'Build succeeded.    0 Warning(s)    0 Error(s)',
    'compile finished: 0 errors, 0 warnings',
    'test result: ok. 10 passed; 0 failed; 0 ignored',
    'Warning: Permanently added github.com (ED25519) to the list of known hosts.',
    'strategy: fail-fast: false, continue-on-error: true',
    'There were no errors.'
  ];
  for (const t of quiet) assert.deepStrictEqual(findAll(m, t), [], t);
  assert.deepStrictEqual(findAll(m, 'Tests run: 128, Failures: 3, Errors: 0'), ['Failures']);
  assert.deepStrictEqual(findAll(m, '10 errors generated.'), ['errors']);
  assert.deepStrictEqual(findAll(m, '0 errors in 10 files, 2 failed'), ['failed']);
});

check('ignore rules: literal needs standalone match, regex rules and bad regex', () => {
  const m = C.buildKeywordMatcher(['errors', 'error', '!0 errors', '!/flaky-\\d+ error/i', '!/[/'], { ignoreCase: true, smartMatch: true });
  assert.strictEqual(m.ignoreCount, 2, 'invalid regex rule is skipped');
  assert.deepStrictEqual(findAll(m, '10 errors'), ['errors'], '"!0 errors" must not hide "10 errors"');
  assert.deepStrictEqual(findAll(m, 'got 0 errors'), []);
  assert.deepStrictEqual(findAll(m, 'flaky-12 error then error'), ['error']);
});
check('legacy default csv is recognised for migration', () => {
  const lines = ['rank,key_word'];
  oldKeywords.forEach((k, i) => lines.push((i + 1) + ',' + k));
  assert.ok(C.isLegacyDefaultCsv(lines.join('\n')));
  assert.ok(!C.isLegacyDefaultCsv(lines.join('\n') + '\n999,foo'));
});

// ---------- trie == longest-first alternation ----------
function plainMatcher(keywords, ignoreCase) {
  const keys = [...new Set(keywords.map(k => ignoreCase ? k.toLowerCase() : k))]
    .sort((a, b) => b.length - a.length);
  const esc = keys.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(esc.join('|'), ignoreCase ? 'gi' : 'g');
}
function plainAll(re, text) {
  const out = []; re.lastIndex = 0; let m;
  while ((m = re.exec(text)) !== null) out.push(m[0]);
  return out;
}
const sample = sampleLines(4000).join('\n') + '\n';
check('trie regex finds exactly what a longest-first alternation finds (default list)', () => {
  const matcher = C.buildKeywordMatcher(C.DEFAULT_KEYWORDS, { ignoreCase: true, smartMatch: false });
  const a = findAll(matcher, sample);
  const b = plainAll(plainMatcher(C.DEFAULT_KEYWORDS, true), sample);
  assert.strictEqual(a.length, b.length, 'counts ' + a.length + ' vs ' + b.length);
  assert.deepStrictEqual(a, b);
});
check('trie regex equivalence on random keyword sets (case-sensitive too)', () => {
  const alphabet = 'abAB-.:_ ';
  let seed = 7;
  const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let round = 0; round < 300; round++) {
    const kws = [];
    const count = 1 + rnd(12);
    for (let i = 0; i < count; i++) {
      let s = ''; const len = 1 + rnd(5);
      for (let j = 0; j < len; j++) s += alphabet[rnd(alphabet.length)];
      if (s.trim()) kws.push(s.trim());
    }
    if (!kws.length) continue;
    let text = ''; for (let j = 0; j < 400; j++) text += alphabet[rnd(alphabet.length)];
    for (const ic of [true, false]) {
      const m = C.buildKeywordMatcher(kws, { ignoreCase: ic, smartMatch: false });
      const a = findAll(m, text);
      const b = plainAll(plainMatcher(kws.map(k => k.trim()), ic), text);
      assert.deepStrictEqual(a, b, 'round ' + round + ' ic=' + ic + ' kws=' + JSON.stringify(kws) + ' src=' + m.regex.source);
    }
  }
});

// ---------- smart match ----------
const smart = C.buildKeywordMatcher(C.DEFAULT_KEYWORDS, { ignoreCase: true, smartMatch: true });
const cases = [
  // [text, expected matches]
  ['TypeError: x is not a function', ['TypeError']],
  ['requests.HTTPError happened', ['Error']],
  ['pod status OOMKilled after 3m', ['OOMKilled']],
  ['CUDA_ERROR_ILLEGAL_ADDRESS', ['CUDA_ERROR', 'ILLEGAL']],
  ['Job errored; 2 errors; fatality report; Crashlytics; abortion debate', ['errored', 'errors']],
  ['zoom into the room, bloom', []],
  ['OOM killer invoked', ['OOM']],
  ['use the default settings; defaults apply', []],
  ['page fault at 0x0, SegFault, faults: 3', ['fault', 'SegFault', 'faults']],
  ['a pleasant peasant from Hungary with a deadline', []],
  ['task hung, process dead', ['hung', 'dead']],
  ['loss: nan, grad: NaN', ['nan', 'NaN']],
  ['banana maintenance tenant', []],
  ['Xid 79, NVRM: GPU has fallen off the bus', ['Xid', 'NVRM', 'fallen off the bus']],
  ['oxide oxidation', []],
  ['3 passed, 1 xfail, 2 failed', ['failed']],
  ['test fails, failsafe mode', ['fails']],
  ['ErrorCode=7 errorHandler ERROR_CODE crashes', ['Error', 'error', 'ERROR', 'crashes']],
  ['npm ERR! code ELIFECYCLE', ['ERR!', 'ELIFECYCLE']],
  ['Caused by: java.lang.NullPointerException', ['Caused by', 'Exception']],
  ['Connection timed out after 30s', ['timed out']],
  ['WARN  [main] disk almost full; warning: low space', ['WARN', 'warning']],
  ['Process completed with exit code 1.', ['exit code']],
  ['ERROR: AddressSanitizer: heap-use-after-free on address', ['ERROR:', 'AddressSanitizer', 'heap-use-after-free']],
  ['stackoverflow.com question', []],
  ['torch.cuda.OutOfMemoryError: CUDA out of memory', ['OutOfMemoryError', 'CUDA out of memory']]
];
for (const [text, expected] of cases) {
  check('smart: ' + JSON.stringify(text), () => {
    assert.deepStrictEqual(findAll(smart, text), expected);
  });
}

check('severity levels: built-ins, heuristics, custom cycling', () => {
  assert.strictEqual(C.classifyKeyword('SIGSEGV', 0), 0);
  assert.strictEqual(C.classifyKeyword('TypeError', 0), 1);
  assert.strictEqual(C.classifyKeyword('timeout', 0), 2);
  assert.strictEqual(C.classifyKeyword('deprecated', 0), 3);
  assert.strictEqual(C.classifyKeyword('required', 0), 4);
  assert.strictEqual(C.classifyKeyword('MyCustomFatalThing', 0), 0);
  assert.strictEqual(C.classifyKeyword('FooBarError', 0), 1);
  assert.strictEqual(C.classifyKeyword('requestId', 0), 5);
  assert.strictEqual(C.classifyKeyword('userId', 1), 6);
  assert.strictEqual(C.classifyKeyword('orderId', 2), 7);
  assert.strictEqual(C.classifyKeyword('traceId', 3), 5);
  assert.deepStrictEqual(C.LEVELS.map(l => l.style), ['solid', 'solid', 'tint', 'wavy', 'dotted', 'tint', 'tint', 'tint']);
});

check('settings default auto ON, explicit false respected', () => {
  assert.strictEqual(C.normalizeSettings({}).autoEnabled, true);
  assert.strictEqual(C.normalizeSettings({ autoSearchEnabled: false }).autoEnabled, false);
  assert.strictEqual(C.normalizeSettings({ autoSearchEnabled: true }).autoEnabled, true);
  assert.deepStrictEqual(C.normalizeSettings({}).options, { ignoreCase: true, smartMatch: true });
});

check('regex matcher colors by classification', () => {
  const m = C.buildRegexMatcher('segfault|\\d{3}', 'gi');
  const t = 'segfault 404';
  m.regex.lastIndex = 0;
  const m1 = m.regex.exec(t);
  assert.strictEqual(m.resolve(t, m1.index, m1.index + m1[0].length).level, 0);
  const m2 = m.regex.exec(t);
  assert.strictEqual(m.resolve(t, m2.index, m2.index + m2[0].length).level, 5);
});

// ---------- benchmark (--bench) ----------
if (BENCH) {
function oldRegex(keywords) {
  const kw = keywords.map((k, i) => ({ keyword: k, rank: i + 1 }));
  kw.sort((a, b) => b.rank - a.rank || b.keyword.length - a.keyword.length);
  return new RegExp(kw.map(i => '(' + i.keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')').join('|'), 'gi');
}
function bench(name, fn, reps = 5) {
  fn();
  const t0 = performance.now();
  let r;
  for (let i = 0; i < reps; i++) r = fn();
  const ms = (performance.now() - t0) / reps;
  console.log(`bench ${name.padEnd(42)} ${ms.toFixed(1).padStart(8)} ms  (${r} matches)`);
  return ms;
}
const big = sample.repeat(Math.ceil(5e6 / sample.length)).slice(0, 5e6);
const lines = big.split('\n');
console.log('\nbenchmark text: ' + (big.length / 1e6).toFixed(1) + ' MB, ' + lines.length + ' lines');
const oldRe = oldRegex(oldKeywords);
bench('old: 363 capture groups, per line', () => {
  let n = 0;
  for (const line of lines) {
    oldRe.lastIndex = 0; let m;
    while ((m = oldRe.exec(line)) !== null) {
      for (let i = 1; i < m.length; i++) if (m[i] !== undefined) break;
      n++;
    }
  }
  return n;
});
const newM = C.buildKeywordMatcher(C.DEFAULT_KEYWORDS, { ignoreCase: true, smartMatch: true });
bench('new: trie + smart match (' + newM.size + ' kw), per line', () => {
  let n = 0;
  const re = newM.regex;
  for (const line of lines) {
    re.lastIndex = 0; let m;
    while ((m = re.exec(line)) !== null) {
      if (newM.resolve(line, m.index, m.index + m[0].length)) n++;
      else re.lastIndex = m.index + 1;
    }
  }
  return n;
});
const flat = plainMatcher(C.DEFAULT_KEYWORDS, true);
bench('ref: flat longest-first alternation (' + C.DEFAULT_KEYWORDS.length + ' kw)', () => {
  let n = 0;
  for (const line of lines) {
    flat.lastIndex = 0;
    while (flat.exec(line) !== null) n++;
  }
  return n;
});

}

console.log('\nkeywords: v3.4.0 ' + oldKeywords.length + ' -> now ' + C.DEFAULT_KEYWORDS.length + ' (+' + C.DEFAULT_IGNORE.length + ' ignore rules)');
console.log(failures ? failures + ' FAILURE(S)' : 'ALL PASSED');
process.exit(failures ? 1 : 0);
