# Privacy Policy for RSearch

**Last Updated: April 17, 2026**

## Overview

RSearch is committed to protecting your privacy. This privacy policy explains how RSearch handles information when you use our Chrome extension.

## Information Collection and Use

### What We DON'T Collect

RSearch does **NOT** collect, store, or transmit any of the following:

- Personal information
- Browsing history
- Search queries or patterns
- Page content
- Cookies or tracking data
- Usage statistics or analytics
- Any identifiable information

### How RSearch Works

RSearch operates entirely locally in your browser:

1. **Local Processing Only**: All search and highlighting operations happen directly in your browser
2. **No External Servers**: The extension does not communicate with any external servers
3. **Local Storage Only**: Settings and presets are stored locally in Chrome's storage API
4. **No Tracking**: We do not track your usage or behavior in any way

## Permissions Explained

RSearch requires the following Chrome permissions:

### `activeTab`
- **Why**: To search and highlight the current tab when you open RSearch
- **Usage**: Only granted for the tab you clicked the extension on
- **Scope**: Limited to the active tab only

### `scripting`
- **Why**: To run the search and highlighting code inside web pages
- **Usage**: Injects RSearch's own bundled scripts; no remote code is ever loaded
- **Scope**: Pages you open RSearch on, or all pages if you allow auto-highlight

### `storage`
- **Why**: To save your preferences and custom presets locally
- **Usage**: Stores presets, the active preset, the auto-highlight switch, search options and the list of sites where you paused auto-highlight
- **Scope**: Data stored locally in your browser only, never transmitted

### `tabs`
- **Why**: To show results for the current tab and keep auto-highlight working when you switch tabs
- **Usage**: Reads the tab URL to skip pages Chrome does not allow extensions on and to apply per-site pauses
- **Scope**: URLs are used locally and never stored except the hostnames you pause

### Optional: access to all sites (`<all_urls>`)
- **Why**: Auto-highlight — highlighting every page you open without clicking the icon
- **When**: Requested only if you click **Allow** (or turn the Auto switch on) in the popup; RSearch works without it
- **Usage**: Runs the same local search on each page you open; page text is scanned in memory and never stored, copied or sent anywhere
- **Revoke**: Turn the Auto switch off, or remove site access at `chrome://extensions` → RSearch → Details

## Data Storage

### What Is Stored Locally

- Preset configurations (keywords, names)
- Active preset selection
- Auto-highlight switch state and search options
- Hostnames where you paused auto-highlight

### Where Data Is Stored

All data is stored using Chrome's `chrome.storage.local` API, which:
- Keeps data on your local device only
- Does not sync to Google servers
- Is cleared when you uninstall the extension

## Data Security

Since RSearch does not collect, store externally, or transmit any data:
- There is no data to be compromised
- Your search patterns remain private on your device
- No risk of data breaches or leaks

## Third-Party Services

RSearch does **NOT** use any third-party services, including:
- No analytics services (e.g., Google Analytics)
- No error tracking services
- No advertising networks
- No social media integrations
- No external APIs

## Changes to This Policy

If we update this privacy policy, we will:
1. Update the "Last Updated" date at the top
2. Notify users through the extension's update notes
3. Post the updated policy in the GitHub repository

## Open Source Transparency

RSearch is open source. You can:
- Review the complete source code at: https://github.com/clemente0731/rsearch
- Verify that no data collection occurs
- Audit the code for privacy concerns
- Contribute improvements

## Children's Privacy

RSearch does not knowingly collect any information from anyone, including children under 13. The extension does not collect any data from any users.

## Your Consent

By using RSearch, you consent to this privacy policy.

## Contact

If you have any questions or concerns about this privacy policy:

- Open an issue on GitHub: https://github.com/clemente0731/rsearch/issues
- View the source code: https://github.com/clemente0731/rsearch

## Summary

**RSearch is privacy-first:**
- ✅ Zero data collection
- ✅ No tracking
- ✅ No external communications
- ✅ Fully local operation
- ✅ Open source and auditable
- ✅ Local storage only

---

**Your privacy is important to us. RSearch keeps your searches completely private and local to your browser.**
