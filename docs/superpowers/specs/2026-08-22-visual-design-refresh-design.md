# Visual Design Refresh — Design Spec

**Date:** 2026-08-22
**Status:** Approved by user, ready for implementation planning
**Classification:** Architectural (design-system-level change, spans the whole app)

## Context

Speelfinance Asset Management is a single-stylesheet, no-build-step, vanilla
JS app (`js/app.js`, `index.html`, `css/style.css`). `css/style.css` already
uses CSS custom properties for every color (`--bg`, `--surface`, `--text`,
`--primary`, `--teal`, `--amber`, `--red`, `--blue`, `--purple`, `--grey`,
etc.) — there is no hardcoded color anywhere in the ~250 rules that follow
the `:root` block. Typography is currently a system-font stack only
(`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial,
sans-serif`), and there is exactly one visual theme — no dark mode, no
manual theme toggle. The brand mark (Speelfinance logo, blue/purple
primary) is used throughout the sidebar, buttons, active nav state, and
several icon-tint classes.

The user asked for the app to be made "more beautiful and useful," scoped
(via brainstorming) to: a visual pass across the *whole existing app*
first, followed by finishing three already-agreed backlog items (theme
toggle — now folded into this spec since dark mode requires it anyway —
plus a guided office setup wizard and a custody self-service redo) with
the same design care applied. This spec covers the visual-system pass;
the setup wizard and custody redo are out of scope here and will each get
their own brainstorming pass before implementation, since they're
features, not part of the token system.

## Decisions (validated with the user, including via visual mockups)

1. **Brand identity is kept, not replaced.** The blue/purple primary
   (`--primary: #4c5ef8` and friends) and the Speelfinance logo stay
   exactly as they are. This pass elevates typography, spacing, shadows,
   and component polish *around* that identity — it does not redesign it.
2. **Typography: Manrope (headings) + Inter (body).** Chosen over two
   other candidate pairings (Sora/Public Sans, Lexend/Source Sans 3) and
   over keeping system fonts, via a live mockup comparison using real
   Stock Summary content (page title, stat cards, data table) rendered in
   each pairing. Manrope was picked for headings/numbers — geometric,
   confident at large sizes, good tabular-figure support for a
   number-dense admin tool. Inter for body/table text — extremely legible
   at small sizes, the de facto standard for dense UI.
3. **Dark theme: neutral slate, not brand-tinted.** Chosen over a
   blue/purple-tinted dark palette via a second live mockup. Near-black
   neutral background (`#14161c` ballpark) with no color cast; the
   brand blue/purple accent (lightened for dark-background contrast)
   still carries every accent/link/primary-action color, so the theme
   still reads as "Speelfinance," just without tinting the neutral base.
4. **Theme selection: system-default with a manual override.** On first
   visit (no stored preference), the app follows
   `prefers-color-scheme`. A sun/moon toggle in the sidebar footer (next
   to the existing "🔄 Refresh Data" control) lets the user set an
   explicit choice, persisted in `localStorage` per-browser (same
   mechanism already used for "last office opened") — that choice then
   wins over the OS setting until changed or cleared.
5. **No build step, no framework, no automated test suite** — this pass
   must not introduce any of the three. It stays consistent with how the
   rest of the app is built.

## Architecture: extend the token system, don't rewrite

Because every color in `css/style.css` already flows through a CSS custom
property, dark mode is "redefine ~15 tokens under a media query / data
attribute," not "touch every rule." This is the recommended approach over
two alternatives considered and rejected:

- **Full stylesheet rewrite** — touches all ~250 rules at once, far higher
  regression risk for a live tool with no automated tests, most of the
  risk buys nothing (the light theme doesn't need to change).
  Rejected.
- **Parallel "v2" class system, migrated page by page** — safer in theory,
  but this app is one stylesheet with no component framework; the
  scaffolding a v2-class migration needs isn't warranted at this size.
  Rejected.
- **Extend tokens in place** (recommended, chosen) — add font tokens and a
  parallel dark set of the existing color tokens; zero HTML/JS class-name
  changes required for the base pass, so every existing page keeps
  working exactly as it does today, just re-themed.

### Token changes (`css/style.css`)

- Add `--font-heading` (Manrope) and `--font-body` (Inter) custom
  properties; apply `--font-body` as the base `body` font-family (already
  effectively the default everywhere via inheritance) and `--font-heading`
  to `h1`/`h2`/`h3`/`.page-title`/`.stat-card .value`/table `th` — i.e.
  titles, card numbers, and column headers, not every label.
- Define (or tighten) a type scale: page title, section header, card
  label, body text, caption/muted text — replacing today's somewhat ad
  hoc mix of one-off `font-size` values on individual rules, without
  renaming any existing class.
- Add a full dark-mode token set, values as validated in the mockup
  (exact numbers, not placeholders — refine only if a specific component
  fails contrast in practice):
  | token | light (existing) | dark (new) |
  |---|---|---|
  | `--bg` | `#f4f6fb` | `#14161c` |
  | `--surface` | `#ffffff` | `#1b1e27` |
  | `--surface-2` | `#f8f9fc` | `#20232e` |
  | `--border` | `#e6e9f2` | `#2a2e3a` |
  | `--text` | `#1c2333` | `#f2f3f7` |
  | `--text-muted` | `#6b7385` | `#a2a8bb` |
  | `--text-faint` | `#9aa1b3` | `#6b7185` |
  | `--primary` | `#4c5ef8` | `#7b8cff` |
  | `--primary-dark` | `#3843d6` | `#9aa7ff` |
  | `--primary-light` | `#eef0ff` | `#232748` |

  Semantic tint colors (`--teal`, `--amber`, `--red`, `--blue`,
  `--purple`, `--grey` and their `*-light` pairs) get the same
  lighten-for-contrast treatment as `--primary` — brighten the base hue
  slightly, replace each `*-light` background with a low-alpha version
  of that hue over `--surface-2` rather than the pale tint used in light
  mode, since a pale-yellow-on-white badge look pastel and pale-yellow-on
  near-black looks muddy (the exact failure mode already hit and reverted
  once this session in the Stock Summary table's editable-column tint —
  worth remembering going in, not just for badges).

  Activated two ways (so both the system-default and the manual-override
  behaviors work):
  ```css
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) { /* dark token values */ }
  }
  :root[data-theme="dark"] { /* same dark token values */ }
  ```
  `data-theme="light"|"dark"` is set on `<html>` by the toggle's JS,
  before first paint where possible (inline in `index.html`, reading
  `localStorage` synchronously) to avoid a flash of the wrong theme.
- Component-level polish (spacing, shadow tokens, border-radius
  consistency) applied to the shared components first — `.card`,
  `.table-wrap`/table rules, `.stat-card`, `.badge-*`, buttons — since
  those are reused across nearly every page already.

### `index.html` changes

- `<link>` tags for Manrope + Inter from Google Fonts (same
  `<script src="...">`-at-the-bottom-of-body pattern already used for
  Firebase/xlsx/jsPDF — no build step, no bundler).
- A small inline `<script>` in `<head>` that reads the stored theme
  preference from `localStorage` and sets `data-theme` on `<html>`
  synchronously, before `css/style.css` loads — this is what prevents a
  flash of the wrong theme on load.
- New toggle button markup in the sidebar footer.

### `js/app.js` changes

- Toggle click handler: flips `data-theme`, writes the choice to
  `localStorage`, no page reload needed (CSS custom properties update
  live).
- No changes to any render function's HTML generation — every page's
  markup already relies on the shared classes/tokens being restyled
  underneath it, so this pass touches CSS (and a few lines of new JS for
  the toggle itself) without touching how any page's content is built.

## Rollout order

Because this is token-level, dark mode and the new fonts apply to every
page simultaneously the moment the tokens ship — there's no page-by-page
rollout for that part. The *additional* component-level polish (spacing,
shadows, consistency fixes beyond what the token change gives for free)
is sequenced highest-traffic-first:

1. Dashboard (org view + Team Lead view)
2. Stock Summary
3. Asset Assignment
4. Asset Requests
5. Everything else (Employees, Master Inventory, Refill Log, Transfers,
   Categories, Activity Log, Reports, Settings, Login Activity) — only if
   still needed after 1–4, since most of these already inherit the
   improvement via shared `.card`/`.table-wrap`/`.stat-card` components.

## Testing / verification

No automated test suite exists for this app (consistent with how it's
built today) — verification is manual, matching the habits already
established this session:

- `node --check js/app.js` after any JS-touching change.
- Visual check via the local Firebase Hosting emulator
  (`http://127.0.0.1:5000`) in: light (system), dark (system), and both
  manual-toggle states.
- After `firebase deploy --only hosting`, the established
  curl-and-diff-against-live check before reporting anything as done.

## Explicitly out of scope for this spec

- The guided office setup wizard.
- The custody self-service redo (the dropdown-of-existing-logins
  rework).
- Any change to the actual brand colors, logo, or information
  architecture (nav structure, page list) — this is a *visual* pass, not
  a re-architecture of what the app does.

Both deferred items will consume whatever design tokens this spec
produces (fonts, spacing, dark-mode support) once built, but each needs
its own brainstorming pass — they're features, not part of the token
system this spec covers.
