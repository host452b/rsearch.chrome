# RSearch

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Chrome Web Store](https://img.shields.io/badge/Chrome-Web%20Store-blue)](https://chromewebstore.google.com/)

A powerful Chrome extension for advanced text searching with regex, multi-keyword support, and error log analysis on web pages.

## Features

### Always-On Auto-Highlight (default ON)

- Every page you open is highlighted automatically with the active preset
- One-time "Allow on all sites" grant (optional permission — the extension asks only when you want auto-highlight; nothing is ever sent anywhere)
- Pause it per site ("Auto on this site") or turn it off globally with the **Auto** switch
- Live updates: streaming CI logs, lazy-loaded and single-page-app content get highlighted as they appear
- Match count on the toolbar badge, colored by the worst severity found
- Background tabs wait until you look at them, so opening many tabs stays fast

### Two Search Modes

**1. Keywords Mode** (default)
- 450+ pre-configured error keywords (Python, C/C++, CUDA, NCCL, TensorRT, PyTorch, vLLM, Kubernetes, Go, Rust, Java, Node, kernel/GPU…)
- Leave the input empty to search with the active preset, or type ad-hoc keywords (`oom, xid, nccl`)
- **Smart match**: keywords must start at a word or camelCase boundary, and keywords of 5 letters or fewer must be whole words — `error` still finds `TypeError` and `CUDA_ERROR`, but `fault` no longer lights up `default`, `oom` no longer hits `zoom`, `fatal` no longer hits `fatality`
- CSV-based preset system with 3 slots, up to 500 keywords each

**2. Regex Mode**
- Full JavaScript regular expressions, ignore-case and find-all options

### Severity Colors

Every keyword has a severity, so the color tells you how bad a line is:

| Level | Color | Examples |
|-------|-------|----------|
| Critical | Red `#DC2626` | segfault, SIGSEGV, OOM, panic, Xid, heap-use-after-free, CrashLoopBackOff |
| Error | Light red `#EF4444` | error, exception, failed, Traceback, undefined reference, Caused by |
| Problem | Orange `#F97316` | timeout, timed out, invalid, not found, mismatch, unsupported |
| Warning | Amber `#F59E0B` | warning, WARN, deprecated, retrying |
| Notice / other | Yellow → cyan | expected, required, your own custom keywords |

### Find the Real Problem Fast

- Severity chips in the popup (e.g. `12 Critical · 300 Error`) — click one to jump to the next match of that severity
- Previous / next match navigation (`‹ ›`, or `j`/`k` / arrow keys in the popup), scrolling nested log panes too
- Top 3 hotspots: the densest, most severe, non-overlapping regions of the page, with a preview of the worst line
- Scrollbar markers on the right edge, colored by severity — hover for the line, click to jump
- **Copy error lines**: copies the deduplicated critical/error/problem lines for a bug report or chat

### Safe and Fast on Any Page

- Uses the CSS Custom Highlight API: the page DOM is never modified, so React/Vue apps, code editors and contenteditable fields keep working
- Skips text areas, inputs and editable regions
- Time-sliced, cancellable search: a 50,000-line log is searched in ~0.2 s without freezing the page (v3.4.0 took ~2 minutes and froze the tab)

## Installation

### From Chrome Web Store (Recommended)
1. Visit [RSearch on Chrome Web Store](https://chromewebstore.google.com/)
2. Click "Add to Chrome"
3. Confirm installation

### From Source
1. Clone this repository:
   ```bash
   git clone https://github.com/clemente0731/rsearch.git
   ```
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" (top right)
4. Click "Load unpacked"
5. Select the `rsearch` directory

## Usage

### Basic Usage

1. Install, open RSearch once and click **Allow** to auto-highlight every page you open
2. Open any log page — errors are highlighted automatically and counted on the badge
3. Click the RSearch icon to see severity counts, hotspots and step through matches
4. Type keywords or switch to Regex for a one-off search; **Clear** removes highlights on this page

### Preset Management

1. Select a preset from the dropdown (the page re-highlights immediately)
2. Click **Edit** to rename it or change its keywords
3. Edit in CSV format: `rank,keyword`
4. Click **Save**; **Reset to default** restores the built-in list

### Auto-Highlight

- The **Auto** switch in the header is ON by default
- Without the "all sites" permission, auto-highlight runs whenever you open the popup
- "Auto on this site" in the popup footer pauses it for the current site only

## Default Error Keywords

The default preset includes 450+ error keywords covering:
- System signals and crashes (SIGSEGV, SIGABRT, core dumped, panicked, OOMKilled…)
- Common errors (error, fail, exception, Caused by, exit code, timed out…)
- CUDA / cuBLAS / cuDNN / NCCL / TensorRT / NVIDIA driver (Xid, NVRM, fallen off the bus)
- Python, C/C++ compiler and linker, Go, Rust, Java, Node/npm
- ONNX / ONNXRuntime / vLLM / SGLang / PyTorch errors
- Kubernetes and containers (CrashLoopBackOff, ImagePullBackOff, Evicted…)
- Memory safety and sanitizers (heap-use-after-free, data race, double free…)
- HTTP and auth failures (forbidden, unauthorized, bad gateway, rate limit…)

Upgrading from 3.4.0: if you never edited the default preset it is upgraded automatically; otherwise use **Reset to default** to get the new keywords.

## Privacy

RSearch respects your privacy:
- No data collection
- No external network requests
- No tracking or analytics
- All processing happens locally
- Open source and transparent

See [PRIVACY.md](PRIVACY.md) for details.

## Development

### Project Structure
```
rsearch/
├── manifest.json       # extension configuration
├── popup.html          # extension popup UI
├── popup.js            # popup logic
├── shared.js           # keywords, severity, matcher, settings (shared by all contexts)
├── content.js          # search + highlight (CSS Custom Highlight API)
├── background.js       # auto-highlight registration, badge, migrations
├── styles.css          # highlight colors + scrollbar markers
├── icon.svg            # SVG icon source
├── icon*.png           # PNG icons
├── README.md           # this file
├── LICENSE             # MIT License
├── PRIVACY.md          # privacy policy
├── CHANGELOG.md        # version history
└── CONTRIBUTING.md     # contribution guide
```

### Building from Source
No build process required. The extension runs directly from source files.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for version history.

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Author

**clemente0731**

- GitHub: [@clemente0731](https://github.com/clemente0731)

## Support

If you encounter any issues or have questions:
- [Report a bug](https://github.com/clemente0731/rsearch/issues)
- [Request a feature](https://github.com/clemente0731/rsearch/issues)
- [Read the documentation](https://github.com/clemente0731/rsearch)

---

**Enjoy searching!**
