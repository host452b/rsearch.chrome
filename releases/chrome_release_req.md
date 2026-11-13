# Chrome Web Store 发布资料 — RSearch v3.5.0

> 生成日期：2026-11-13
> 此文件包含 Dashboard 所有需要填写的字段，发布时逐项复制粘贴。

---

## 产品详情

### 软件包中的标题
RSearch - Error Log Search & Highlighter


### 软件包中的摘要
Error log highlighter: 450+ error patterns, severity colors, regex search and always-on auto-highlight.


### 说明（最长 16,000 字符）
RSearch - Error Log Search & Highlighter

Open a CI log, a crash dump or a server log and the problems are already highlighted: crashes in red, errors, problems and warnings in their own colors, with a match count on the toolbar badge.

ALWAYS-ON AUTO-HIGHLIGHT (on by default)
- Every page you open is highlighted with the active preset
- One click "Allow" grants access to all sites; decline and it runs whenever you open RSearch
- Pause it per site, or turn it off with the Auto switch
- Streaming logs and dynamically loaded content are highlighted as they appear
- Match count on the toolbar badge, colored by the worst severity found

450+ ERROR KEYWORDS
- Signals and crashes: SIGSEGV, SIGABRT, core dumped, panicked, OOMKilled
- Python, C/C++ compiler and linker, Go, Rust, Java, Node/npm
- CUDA, cuBLAS, cuDNN, NCCL, TensorRT, NVIDIA driver (Xid, NVRM)
- PyTorch, ONNX, ONNXRuntime, vLLM, SGLang
- Kubernetes and containers: CrashLoopBackOff, ImagePullBackOff, Evicted
- Sanitizers: heap-use-after-free, data race, double free
- Smart match: "error" finds TypeError and CUDA_ERROR, but "fault" never lights up "default"

FIND THE REAL PROBLEM FAST
- Severity colors: Critical, Error, Problem, Warning
- Click a severity to jump to its next match
- Previous / next match navigation (also inside scrollable log panes)
- Top 3 hotspots: the densest, most severe regions of the page
- Scrollbar markers colored by severity, hover to preview a line
- Copy error lines: grab the failing lines for a bug report

FAST AND SAFE
- A 50,000-line log is searched in about 0.2 seconds without freezing the page
- Highlights never modify the page, so web apps and editors keep working
- Text boxes and editable areas are skipped

REGEX MODE AND PRESETS
- Full regular expressions with ignore-case and find-all options
- 3 CSV preset slots, up to 500 keywords each

PRIVACY
- No data collection, no network requests, no analytics
- All processing happens locally in your browser
- Open source on GitHub

HOW TO USE
1. Click the RSearch icon and click "Allow" for automatic highlighting
2. Open any log page: matches are highlighted and counted on the badge
3. Open RSearch to see severity counts and hotspots, and step through matches
4. Type keywords or switch to Regex for one-off searches
5. Click "Clear" to remove highlights on the current page

Open source: https://github.com/host452b/rsearch


### 类别
Developer Tools


### 语言
English


---

## 图片资源

> 以下文件已拷贝到 releases/ 目录，上传时直接从此目录选择。

| 资源 | 文件名 | 规格 | 状态 |
|------|--------|------|------|
| 商店图标 | `icon-128x128.png` | 128x128 PNG | 已就绪 |
| 屏幕截图 1 | `screenshot-1-1280x800.png` | 1280x800 PNG | 需手动截图 |
| 屏幕截图 2 | `screenshot-2-1280x800.png` | 1280x800 PNG | 需手动截图 |
| 屏幕截图 3 | `screenshot-3-1280x800.png` | 1280x800 PNG | 需手动截图 |
| 小型宣传图块 | `small-promo-440x280.png` | 440x280 PNG | 需制作 |
| 顶部宣传图块 | `marquee-promo-1400x560.png` | 1400x560 PNG | 需制作 |

### 建议截图内容
1. Keywords 模式主界面 + 高亮效果
2. Top 3 密度区域展示
3. Preset 编辑 / Auto-search 开关

### 宣传视频（可选）
YouTube URL: (无)


---

## 其他字段

### 官方网址
https://github.com/host452b/rsearch


### 首页网址
https://github.com/host452b/rsearch


### 支持信息页面网址
https://github.com/host452b/rsearch/issues


### 成人内容
不包含成人内容


---

## 隐私权

### 单一用途说明（最长 1,000 字符）

This extension searches and highlights error keywords and regex patterns on web pages, with 450+ built-in error patterns for log analysis. All search and highlighting operations happen locally in the browser. No data is collected, stored externally, or transmitted to any server.


### 需请求权限的理由

**需请求 activeTab 的理由：**
Required to access the current tab's DOM content for searching and highlighting matched text patterns. Only activates when the user clicks the extension icon or when auto-search is enabled. No page content is collected or transmitted — all processing happens locally in the browser.


**需请求 scripting 的理由：**
Required to inject the content script that performs text searching and highlighting on the current page. The content script scans the page DOM for keyword or regex matches and applies CSS highlights. Only activates on user action (clicking Search or with auto-search enabled). No remote scripts are loaded.


**需请求 storage 的理由：**
Required to save user's custom keyword presets (up to 3 preset slots with 500 keywords each), auto-search toggle state, and active preset selection locally on the device. Uses chrome.storage.local only — data is never synced to external servers and is cleared when the extension is uninstalled.


**需请求 tabs 的理由：**
Required for the auto-search feature to detect when users switch tabs or load new pages, enabling automatic keyword highlighting on the newly active tab. Only reads the tab URL to determine if search should run. Tab information is used locally and never transmitted.


**需请求主机权限（optional_host_permissions: <all_urls>）的理由：**
Optional, requested at runtime only when the user enables "auto-highlight every page" in the popup. With it, RSearch runs its bundled search script on each page the user opens so error keywords are highlighted without clicking the icon. Page text is scanned locally in memory; nothing is stored, extracted or transmitted. Users can decline (the extension then works on click via activeTab), pause it per site, or revoke it at any time.


### 远程代码

不，我并未使用远程代码


### 数据使用

| 数据类型 | 是否收集 | 说明 |
|---------|---------|------|
| 个人身份信息 | 否 | — |
| 健康信息 | 否 | — |
| 财务和付款信息 | 否 | — |
| 身份验证信息 | 否 | — |
| 个人通讯 | 否 | — |
| 位置 | 否 | — |
| 网络记录 | 否 | Tab URL is read locally for auto-search trigger only, never stored or transmitted |
| 用户活动 | 否 | — |
| 网站内容 | 否 | Page text is scanned locally for pattern matching; no content is extracted, stored, or sent anywhere |

**三个必勾声明：**

- [x] 我不会出于已获批准的用途之外的用途向第三方出售或传输用户数据
- [x] 我不会为实现与我的产品的单一用途无关的目的而使用或转移用户数据
- [x] 我不会为确定信用度或实现贷款而使用或转移用户数据

### 隐私权政策网址

https://github.com/host452b/rsearch/blob/main/PRIVACY.md


---

## 分发设置

### 付款
免费


### 公开范围
公开


### 分发地区
所有地区


---

## Enhanced Safe Browsing 信任修复

> 此警告 "This extension is not trusted by Enhanced Safe Browsing" 主要通过以下步骤解决：

1. **开发者身份验证**（最关键）
   - Dashboard → 左侧 Account → Identity Verification
   - 提供真实地址 + 邮箱验证
   - 未验证的开发者扩展会一直显示此警告

2. **填完所有 Privacy 字段**
   - 以上权限理由全部填入 Dashboard → Privacy tab
   - 数据使用声明逐项勾选
   - 单一用途说明不能留空

3. **重新提交审核**
   - 上传 v3.4.0 zip
   - Google 重新评估信任级别
   - 通常 1-3 周后警告消除
