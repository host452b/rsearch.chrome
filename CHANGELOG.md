# Changelog

All notable changes to RSearch will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Always-on auto-highlight, ON by default** — every page you open is highlighted with the active preset.
  Uses the new *optional* `<all_urls>` host permission, requested once from the popup ("Allow"), so the
  install warning is unchanged and existing users are not disabled on update. Without the grant,
  auto-highlight runs whenever the popup is opened.
- Per-site pause ("Auto on this site") and a labeled **Auto** switch (off = neutral gray, not red)
- Live updates for streaming logs, lazy-loaded content and SPAs (MutationObserver, debounced)
- Toolbar badge with the match count per tab, colored by the worst severity found
- ~96 new default keywords (363 → 459): `Caused by`, `timed out`, `exit code`, `ERR!`, `WARN`, `[W]`, `NaN`,
  `panicked`, `OOMKilled`, `CrashLoopBackOff`, `ImagePullBackOff`, `heap-use-after-free`, `data race`,
  `fallen off the bus`, `device-side assert`, `illegal memory access`, `no space left`, `too many open files`,
  `connection reset`, `not found`, `unable to`, `forbidden`, `unauthorized`, `rate limit`, and more
- Meaningful severity colors (critical / error / problem / warning / notice) following the design-system
  gradient, instead of colors that cycled by keyword position
- Smart match (default on): keywords must start at a word or camelCase boundary; keywords of ≤5 letters
  must be whole words. `error` still finds `TypeError`/`CUDA_ERROR`; `fault` no longer matches `default`,
  `oom` no longer matches `zoom`/`room`, `fatal` no longer matches `fatality`
- Popup: severity chips that jump to the next match of that severity, prev/next navigation (`j`/`k`),
  "Copy error lines", hidden-match count, file:// access hint, restricted-page notice
- Dark popup following the design system (matches the store screenshots)

### Changed
- Highlights are painted with the CSS Custom Highlight API — the page DOM is no longer modified, so
  React/Vue apps, code editors and contenteditable fields can't be broken; clearing is instant
- Keywords compile to a prefix-trie regex (~10× faster than the old 363-capture-group alternation);
  the longest keyword wins at a position (`oom-killer` no longer cut to `oom`)
- Search is time-sliced (~12 ms slices) and cancellable; at most 20,000 highlights per page (all matches
  are still counted)
- Top 3 hotspots are computed in O(n log n), weighted by severity and never overlap each other
- Scrollbar markers are bucketed per pixel row and show the most severe match in each
- Opening the popup shows existing results instantly instead of re-searching the page
- Settings shared through `shared.js` (popup, service worker and page)
- `minimum_chrome_version` set to 105 (CSS Custom Highlight API)

### Fixed
- Auto-search never ran on page load: the service worker read `preset.keywords`, but presets only store
  `csv`; it also lacked host access, and all errors were swallowed
- Auto-search was effectively OFF on fresh installs until the popup had been opened
- Hotspot calculation was O(n²): a 50,000-line log froze the tab for ~107 s (now ~0.2 s total)
- Top 3 hotspots could all point at the same cluster
- Regex-mode multi-keyword colors were always the first color
- `setTimeout(0)` after every 50 nodes added seconds of idle delay on large pages
- `document.body.normalize()` on clear could merge text nodes owned by page frameworks
- Re-injected content scripts after an extension update were silently inert (orphaned instance guard)
- Unused `highlightedElements` array kept references to every highlight

### Removed
- Unreachable AND/intersection-mode code path (no UI exposed it)
- Popup close button (the popup closes on Esc or blur) and the redundant "Apply" button
  (selecting a preset applies it)

---

## [3.3.0] - 2026-03-03

### Added
- **Scrollbar Marker & Navigation**
  - Color-coded markers on a fixed right-side overlay matching highlight colors
  - Click any marker to smooth-scroll to the corresponding search result
  - Flash animation (1.5s) emphasizes the target match after navigation
  - Hover tooltip shows first 20 characters of matched text
  - Automatic marker consolidation when matches exceed 500 for performance
  - Dynamic position refresh via MutationObserver and window resize listener
  - Full cleanup on search clear (markers, tooltip, observer)

- **Styles**
  - Tooltip CSS for scrollbar marker hover preview
  - `@keyframes rsearch-flash` animation for click-to-navigate emphasis

---

## [2.0.0] - 2026-02-05

### Major Release - Error Log Analysis

#### Added
- **CSV Preset System**
  - 3 customizable preset slots
  - CSV format: rank,keyword
  - Up to 500 keywords per preset
  - Import/export via editor
  - Default preset with 363+ error keywords

- **Top 3 Density Areas**
  - Sliding window algorithm (300px window)
  - Detects high-density error regions
  - Click to navigate to hotspots
  - Temporary highlight on target

- **Auto-Search Feature**
  - Toggle switch in header (green=on, red=off)
  - Auto-search on new page loads
  - Auto-search when switching tabs
  - State persists across sessions

- **Background Service Worker**
  - Monitors tab changes
  - Triggers auto-search automatically
  - Works even when popup is closed

- **Severity-Based Color Coding**
  - 8 colors from magenta to green
  - Higher severity = warmer colors
  - Lower severity = cooler colors

- **UI Improvements**
  - Close button in header
  - Real-time search progress with ETA
  - Auto-expanding popup height
  - Keywords mode as default
  - Wider popup (340px)

#### Changed
- Keywords mode now default (was Regex)
- Removed AND mode option
- Removed auto-scroll to first match
- Updated color palette for better visibility

#### Technical
- Added `storage` permission for presets
- Added `tabs` permission for auto-search
- Added background.js service worker
- Manifest V3 compliant

---

## [1.0.0] - 2025-11-04

### Initial Release

#### Added
- **Regex Search Mode**
  - Full regular expression support
  - Case-sensitive and case-insensitive options
  - Global search option (find all matches)
  - Real-time regex validation
  - Red bold highlighting for matches
  
- **Keywords Search Mode**
  - Multi-keyword search in one line
  - Space or comma-separated keywords
  - 8 vibrant colors for different keywords
  - OR mode (default): Match any keyword
  - AND mode: All keywords must exist
  - Missing keywords error reporting
  
- **UI Features**
  - Clean and intuitive popup interface
  - Mode toggle between Regex and Keywords
  - Checkbox options for search behavior
  - Status messages with success/error feedback
  - Auto-hide success messages after 3 seconds
  - Enter key support for quick search
  
- **Core Features**
  - Auto-scroll to first match
  - Match count display
  - Clear function to remove all highlights
  - Dynamic script injection for better performance
  - Works on all websites (where permissions allow)
  
- **Privacy & Security**
  - No data collection
  - No external network requests
  - All processing happens locally
  - Open source code
  
- **Documentation**
  - Comprehensive README.md
  - Privacy policy (PRIVACY.md)
  - MIT License
  - Usage examples and guides

### Technical Details
- Manifest V3 compliant
- Minimal permissions (activeTab, scripting)
- Optimized for performance
- No external dependencies

---

## Future Plans

### Planned Features
- [ ] Search history (local only)
- [ ] Custom color themes
- [ ] Keyboard shortcuts
- [ ] Search results navigation (next/previous)
- [ ] Dark mode support
- [ ] Export search results

### Under Consideration
- Multi-language support
- Search within specific page sections
- Advanced regex helper/builder
- Preset sharing/import from URL

---

**Note**: We welcome feedback and contributions! Please open an issue on GitHub.
