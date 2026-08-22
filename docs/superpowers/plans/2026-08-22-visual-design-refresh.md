# Visual Design Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Speelfinance Asset Management real typography (Manrope + Inter), a working dark theme (system-default with a manual sidebar toggle), and a component-level polish pass — without changing brand colors, without a build step, without breaking any existing page.

**Architecture:** Extend the existing CSS custom-property token system in `css/style.css` in place — add font tokens and a parallel dark-mode set of the existing color tokens, switched via `prefers-color-scheme` + a `data-theme` attribute on `<html>`. No HTML/JS structural changes to any page's render function; every page re-themes automatically because it already renders through the shared tokens/classes.

**Tech Stack:** Vanilla HTML/CSS/JS, no build step, no framework, no automated test suite. Google Fonts (Manrope, Inter) loaded via `<link>`. Firebase Hosting for deploy.

**Spec:** `docs/superpowers/specs/2026-08-22-visual-design-refresh-design.md`

## Global Constraints

- No new build step, bundler, or framework — stay vanilla, matching the rest of the app.
- No automated test suite exists — verification is `node --check js/app.js` (JS-touching tasks only) + manual visual check via the local emulator (`firebase emulators:start --only hosting`, `http://127.0.0.1:5000`) + the established curl-and-diff-against-live check after every `firebase deploy --only hosting`.
- Brand colors (`--primary` family) and the Speelfinance logo do not change.
- Every color must remain a CSS custom property — no new hardcoded hex in a rule that already has a themed equivalent.
- Dark-mode token activation must use exactly this pattern (from the spec) so both the system-default and the manual-toggle behaviors work together:
  ```css
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) { /* dark values */ }
  }
  :root[data-theme="dark"] { /* same dark values */ }
  ```
- Theme preference key in `localStorage`: `themePreference`, values `"light"` | `"dark"` (absent = follow system).

---

### Task 1: Webfonts + typography tokens

**Files:**
- Modify: `index.html:7-9` (add font `<link>` tags after the existing `<link rel="icon">`/before `<link rel="stylesheet" href="css/style.css">`)
- Modify: `css/style.css:1-48` (`:root` token block and `body`)

**Interfaces:**
- Produces: `--font-heading` and `--font-body` custom properties, usable by every later task and by Tasks 3-7's component polish.

- [ ] **Step 1: Add the Google Fonts `<link>` tags**

In `index.html`, immediately before the existing `<link rel="stylesheet" href="css/style.css" />` line, add:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@600;700;800&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
```

(Only the weights actually used elsewhere in the stylesheet are requested — 400/500/600/700 for Inter body text and existing `font-weight` values already in use, 600/700/800 for Manrope headings.)

- [ ] **Step 2: Add font tokens to `:root`**

In `css/style.css`, inside the existing `:root{...}` block (after the `--shadow-lg` line, before the closing `}` at line 37), add:

```css
  --font-heading: 'Manrope', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --font-body: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
```

- [ ] **Step 3: Apply `--font-body` as the base font, `--font-heading` to titles and stat numbers**

Change the existing `body{...}` rule's `font-family` line (currently `font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;`) to:

```css
  font-family: var(--font-body);
```

Then add a new rule right after the `body{...}` block:

```css
h1, h2, h3, .page-title, .stat-card .value { font-family: var(--font-heading); }
```

- [ ] **Step 4: Verify no syntax errors and fonts actually load**

Run: `node --check js/app.js` (unaffected by this task, but confirms nothing else broke)
Then start the local emulator if it isn't already running: `firebase emulators:start --only hosting` (background it)
Open `http://127.0.0.1:5000`, sign in, and confirm on the Dashboard: the page title and every stat-card number render in Manrope (noticeably more geometric/bold than before), everything else renders in Inter (slightly different from the old system-font look, most visible in table text). Check the browser's Network tab shows the Google Fonts request succeeding (200, not blocked).

- [ ] **Step 5: Commit**

```bash
git add index.html css/style.css
git commit -m "Add Manrope/Inter webfonts and typography tokens"
```

---

### Task 2: Dark-mode color tokens, theme-init script, and sidebar toggle

**Files:**
- Modify: `css/style.css:1-37` (`:root` — add dark-mode counterparts as a second block right after)
- Modify: `css/style.css:325-330` (`.badge-*` rules — convert hardcoded text colors to tokens)
- Modify: `index.html` (add inline theme-init `<script>` in `<head>`, add toggle button in `.sidebar-footer`)
- Modify: `js/app.js` (add toggle click handler)

**Interfaces:**
- Consumes: `--font-heading`/`--font-body` from Task 1 (no direct interaction, but both tasks touch `:root` — do Task 1 first).
- Produces: `data-theme` attribute on `<html>` (`"light"` | `"dark"`, or absent = follow system), `localStorage["themePreference"]`, and a `toggleTheme()` function in `js/app.js` other tasks/future work can call.

- [ ] **Step 1: Add the dark-mode token block to `css/style.css`**

Immediately after the `:root{...}` block's closing `}` (after line 37, before the `*{ box-sizing: border-box; }` line), add:

```css
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #14161c;
    --surface: #1b1e27;
    --surface-2: #20232e;
    --border: #2a2e3a;
    --text: #f2f3f7;
    --text-muted: #a2a8bb;
    --text-faint: #6b7185;

    --primary: #7b8cff;
    --primary-dark: #9aa7ff;
    --primary-light: #232748;

    --teal: #2dd4be;
    --teal-light: rgba(45,212,190,.16);
    --amber: #f0b955;
    --amber-light: rgba(240,185,85,.16);
    --red: #f0705a;
    --red-light: rgba(240,112,90,.16);
    --blue: #5ea3f0;
    --blue-light: rgba(94,163,240,.16);
    --purple: #a687ff;
    --purple-light: rgba(166,135,255,.16);
    --grey: #9aa1b3;
    --grey-light: rgba(154,161,179,.16);

    --badge-green-text: #4fe0c9;
    --badge-blue-text: #7ec1ff;
    --badge-amber-text: #ffce7a;
    --badge-red-text: #ff9c86;
    --badge-grey-text: #c7cbe0;
    --badge-purple-text: #c9b3ff;

    --shadow-sm: 0 1px 2px rgba(0,0,0,.3), 0 1px 1px rgba(0,0,0,.25);
    --shadow-md: 0 6px 20px rgba(0,0,0,.35);
    --shadow-lg: 0 20px 48px rgba(0,0,0,.5);
  }
}
:root[data-theme="dark"] {
  --bg: #14161c;
  --surface: #1b1e27;
  --surface-2: #20232e;
  --border: #2a2e3a;
  --text: #f2f3f7;
  --text-muted: #a2a8bb;
  --text-faint: #6b7185;

  --primary: #7b8cff;
  --primary-dark: #9aa7ff;
  --primary-light: #232748;

  --teal: #2dd4be;
  --teal-light: rgba(45,212,190,.16);
  --amber: #f0b955;
  --amber-light: rgba(240,185,85,.16);
  --red: #f0705a;
  --red-light: rgba(240,112,90,.16);
  --blue: #5ea3f0;
  --blue-light: rgba(94,163,240,.16);
  --purple: #a687ff;
  --purple-light: rgba(166,135,255,.16);
  --grey: #9aa1b3;
  --grey-light: rgba(154,161,179,.16);

  --badge-green-text: #4fe0c9;
  --badge-blue-text: #7ec1ff;
  --badge-amber-text: #ffce7a;
  --badge-red-text: #ff9c86;
  --badge-grey-text: #c7cbe0;
  --badge-purple-text: #c9b3ff;

  --shadow-sm: 0 1px 2px rgba(0,0,0,.3), 0 1px 1px rgba(0,0,0,.25);
  --shadow-md: 0 6px 20px rgba(0,0,0,.35);
  --shadow-lg: 0 20px 48px rgba(0,0,0,.5);
}
```

Then add the light-mode defaults for the two new token groups to the ORIGINAL `:root{...}` block (Task 1 already added font tokens there — add these alongside, before the closing `}`):

```css
  --badge-green-text: #0a8f80;
  --badge-blue-text: #1f6fc4;
  --badge-amber-text: #b6791f;
  --badge-red-text: #c33d28;
  --badge-grey-text: #5b6172;
  --badge-purple-text: #6c3fd6;
```

- [ ] **Step 2: Convert the badge rules to use the new text-color tokens**

Replace `css/style.css:325-330`:

```css
.badge-green{ background:var(--teal-light); color:#0a8f80; }
.badge-blue{ background:var(--blue-light); color:#1f6fc4; }
.badge-amber{ background:var(--amber-light); color:#b6791f; }
.badge-red{ background:var(--red-light); color:#c33d28; }
.badge-grey{ background:var(--grey-light); color:#5b6172; }
.badge-purple{ background:var(--purple-light); color:#6c3fd6; }
```

with:

```css
.badge-green{ background:var(--teal-light); color:var(--badge-green-text); }
.badge-blue{ background:var(--blue-light); color:var(--badge-blue-text); }
.badge-amber{ background:var(--amber-light); color:var(--badge-amber-text); }
.badge-red{ background:var(--red-light); color:var(--badge-red-text); }
.badge-grey{ background:var(--grey-light); color:var(--badge-grey-text); }
.badge-purple{ background:var(--purple-light); color:var(--badge-purple-text); }
```

(This is the fix for the exact failure mode already hit once this session — a pale/light badge background reading as "murky" once the underlying surface goes dark. Routing the text color through a token too, not just the background, means dark mode gets genuinely readable badges instead of an automatic-but-wrong inversion.)

- [ ] **Step 3: Add the theme-init script to `index.html`**

Add this inline `<script>` as the FIRST thing inside `<head>`, before the `<meta charset="UTF-8" />` line — it must run before `css/style.css` loads, so there's no flash of the wrong theme:

```html
<script>
  (function() {
    try {
      var pref = localStorage.getItem("themePreference");
      if (pref === "light" || pref === "dark") {
        document.documentElement.setAttribute("data-theme", pref);
      }
    } catch (e) { /* localStorage unavailable (private mode, etc.) — fall back to system default */ }
  })();
</script>
```

- [ ] **Step 4: Add the toggle button to the sidebar footer**

In `index.html`, inside `.sidebar-footer` (right before the existing `<button class="btn-ghost btn-refresh" id="refreshDataBtn" ...>` at line 81), add:

```html
<button class="btn-ghost btn-theme-toggle" id="themeToggleBtn" title="Switch between light and dark">🌗 <span id="themeToggleLabel">Theme</span></button>
```

- [ ] **Step 5: Add toggle CSS**

In `css/style.css`, right after the existing `.btn-refresh:disabled{ opacity:.6; cursor:default; }` rule, add:

```css
.btn-theme-toggle{ margin-bottom:10px; }
```

(Reuses the existing `.btn-ghost` look — same as every other sidebar footer button — only adds the same bottom margin `.btn-refresh` already has, so spacing stays consistent when both buttons are stacked.)

- [ ] **Step 6: Add the toggle click handler to `js/app.js`**

Add this near the other sidebar-footer button wiring (search for `document.getElementById("resetDataBtn")` and add the new block right before or after it — exact position doesn't matter, all these are independent top-level `addEventListener` calls):

```javascript
// Theme toggle: cycles light -> dark -> follow-system -> light... A person
// who has never touched it gets whatever their OS prefers (see the inline
// script in index.html's <head>, which reads the same key before first
// paint so there's no flash of the wrong theme); touching the toggle sets
// an explicit override that sticks until they cycle back to "system."
function applyThemePreference(pref) {
  if (pref === "light" || pref === "dark") {
    document.documentElement.setAttribute("data-theme", pref);
    localStorage.setItem("themePreference", pref);
  } else {
    document.documentElement.removeAttribute("data-theme");
    localStorage.removeItem("themePreference");
  }
  const label = document.getElementById("themeToggleLabel");
  if (label) label.textContent = pref === "light" ? "Light" : pref === "dark" ? "Dark" : "Theme";
}
document.getElementById("themeToggleBtn").addEventListener("click", () => {
  const current = localStorage.getItem("themePreference");
  const next = current === "light" ? "dark" : current === "dark" ? null : "light";
  applyThemePreference(next);
});
// Reflect whatever's already stored (set synchronously by index.html's
// inline script) in the label on first paint.
applyThemePreference(localStorage.getItem("themePreference"));
```

- [ ] **Step 7: Verify**

Run: `node --check js/app.js`
Expected: no output (syntax OK)

Then in the local emulator (`http://127.0.0.1:5000`):
1. With no stored preference, confirm the app matches your OS's light/dark setting.
2. Click the toggle once — confirm the whole app (sidebar, cards, tables, badges) switches to the opposite theme, badges stay legible (not muddy/low-contrast), and the label reads "Light" or "Dark."
3. Reload the page — confirm the manually-set theme persists (no flash of the other theme first).
4. Click the toggle twice more — confirm it cycles back to following the OS setting and the label reads "Theme" again.

- [ ] **Step 8: Commit**

```bash
git add index.html css/style.css js/app.js
git commit -m "Add dark theme (system-default + manual toggle) and fix badge contrast for dark mode"
```

---

### Task 3: Shared-component polish (Dashboard)

Most of the app's pages already render through the same handful of shared classes (`.card`, `.table-wrap` + table rules, `.stat-card`, `.badge-*`, buttons). This task polishes those shared rules while verifying on the Dashboard (org view), since it uses nearly all of them and is the highest-traffic page — later tasks mostly become verification passes because they inherit this work for free.

**Files:**
- Modify: `css/style.css` (targeted rules only, see below — no wholesale rewrite)

**Interfaces:**
- Consumes: `--font-heading`/`--font-body` (Task 1), dark tokens (Task 2).
- Produces: nothing new consumed by name elsewhere — this is a visual-only refinement of existing shared classes, so nothing downstream needs new interface knowledge.

- [ ] **Step 1: Locate the current `.card` and `.stat-card` rules**

Run: `grep -n "^\.card{" -A 6 css/style.css` and `grep -n "^\.stat-card{" -A 10 css/style.css` — read the actual current values before changing anything (they may have shifted line numbers since this plan was written).

- [ ] **Step 2: Tighten shadow/border consistency**

Confirm every `.card` and `.stat-card` rule uses `var(--shadow-sm)` (not a hardcoded `box-shadow`, not `none`) and `var(--radius)` for `border-radius` — if any shared component rule has a hardcoded shadow or radius value instead of the token, replace it with the token. This is a find-and-replace of literal values with existing tokens, not new design — the tokens already exist from the original stylesheet.

- [ ] **Step 3: Visual check on Dashboard, both themes**

Open `http://127.0.0.1:5000`, Dashboard page, light theme: confirm cards have visible-but-subtle shadows (not flat, not heavy), consistent corner rounding, consistent internal padding across every card on the page. Toggle to dark: confirm the shadow is still perceptible against the dark background (dark-mode shadows use higher-alpha black per Task 2's `--shadow-*` overrides — if a card looks completely flat with no depth in dark mode, that shadow token isn't being picked up; check the rule uses `var(--shadow-sm)` and not a literal value).

- [ ] **Step 4: Commit**

```bash
git add css/style.css
git commit -m "Polish shared card/stat-card shadow and radius consistency"
```

---

### Task 4: Stock Summary — verify + targeted fixes

**Files:**
- Modify: `css/style.css` (only if a concrete issue is found in Step 1 — no speculative changes)

- [ ] **Step 1: Visual check, both themes**

Open Stock Summary in both light and dark. Check specifically: the `.stock-table` grid borders are visible in both themes (not just light — `var(--border)` should already carry through, but confirm), the amber accent used nowhere (it was intentionally removed earlier this session — confirm it hasn't crept back in), numbers stay centered and tabular in both themes, the `.stock-edit` input boxes are visibly distinguishable from static text in dark mode (their `border: 1px solid var(--border)` must have enough contrast against `var(--surface)` — if they visually disappear into the row, that's a real issue to fix, not a false positive).

- [ ] **Step 2: Fix anything found, or note none needed**

If Step 1 found a real contrast/legibility issue, fix it with a targeted rule change (token-based, not a new hardcoded color) and re-check. If nothing was found, skip to Step 3 — do not invent changes to justify the task.

- [ ] **Step 3: Commit (only if Step 2 made a change)**

```bash
git add css/style.css
git commit -m "Fix Stock Summary dark-mode contrast issue: <specific thing found>"
```

---

### Task 5: Asset Assignment — verify + targeted fixes

**Files:**
- Modify: `css/style.css` (only if a concrete issue is found)

- [ ] **Step 1: Visual check, both themes**

Open Asset Assignment in both light and dark. Check specifically: the 📦 Custody badge (`.badge-blue`) is legible in dark mode (this is exactly the badge-text-token fix from Task 2 — confirm it actually took effect here, not just in isolation), the search/filter toolbar inputs are visibly distinct from the page background in dark mode, row-action icon buttons (↩️ 🔁 ✏️ 🗑️) remain clearly clickable-looking (not the same flat color as surrounding text) in dark mode.

- [ ] **Step 2: Fix anything found, or note none needed**

Same rule as Task 4 Step 2 — targeted, token-based, only if something's actually broken.

- [ ] **Step 3: Commit (only if Step 2 made a change)**

```bash
git add css/style.css
git commit -m "Fix Asset Assignment dark-mode contrast issue: <specific thing found>"
```

---

### Task 6: Asset Requests — verify + targeted fixes

**Files:**
- Modify: `css/style.css` (only if a concrete issue is found)

- [ ] **Step 1: Visual check, both themes**

Open Asset Requests (as Admin) in both light and dark, then open a request detail modal. Check specifically: every `requestStatusBadge`/`priorityBadge` color (Draft/Submitted/Under Review/Approved/Rejected/Fulfilled/Cancelled × Normal/High/Urgent) stays legible in dark mode, the `.req-timeline` dots/lines are visible against the dark modal background, the modal itself (`.modal`) has enough contrast against the dimmed backdrop in dark mode.

- [ ] **Step 2: Fix anything found, or note none needed**

Same rule as Task 4 Step 2.

- [ ] **Step 3: Commit (only if Step 2 made a change)**

```bash
git add css/style.css
git commit -m "Fix Asset Requests dark-mode contrast issue: <specific thing found>"
```

---

### Task 7: Remaining pages — spot-check pass

**Files:**
- Modify: `css/style.css` (only if a concrete issue is found)

- [ ] **Step 1: Spot-check every remaining page in both themes**

Employees, Employee History, Master Inventory, Stock Refill Log, Asset Transfers, Asset Categories, Activity Log, Reports, Settings, Login Activity — open each once in light and once in dark. Since these all inherit Tasks 1-3's shared-component work already, this step is about catching anything page-specific that slipped through: a hardcoded color in a one-off inline `style="..."` string inside `js/app.js` (search: `grep -n "color:#" js/app.js` and `grep -n "background:#" js/app.js` — any hit is a hardcoded color that won't respond to the theme toggle and needs to become a `var(--token)` reference instead).

- [ ] **Step 2: Fix anything found, or note none needed**

For each hardcoded color found in Step 1, replace it with the matching existing token (e.g. a hardcoded `#e2513b` becomes `var(--red)`). Re-run the grep from Step 1 after fixing to confirm the count dropped.

- [ ] **Step 3: Final full-app verification**

Run: `node --check js/app.js`
Then: `firebase deploy --only hosting`
Then: the established live-diff check —
```bash
curl -s "https://mount-road-asset-management.web.app/js/app.js" -o /tmp/live_final.js && diff -q /tmp/live_final.js js/app.js && echo JS_MATCHES
curl -s "https://mount-road-asset-management.web.app/index.html" -o /tmp/live_final.html && diff -q /tmp/live_final.html index.html && echo HTML_MATCHES
curl -s "https://mount-road-asset-management.web.app/css/style.css" -o /tmp/live_final.css && diff -q /tmp/live_final.css css/style.css && echo CSS_MATCHES
```
Expected: all three print their MATCHES line.

- [ ] **Step 4: Commit (only if Step 2 made a change)**

```bash
git add js/app.js css/style.css
git commit -m "Fix remaining hardcoded colors found in theme spot-check"
```
