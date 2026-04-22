---
id: TASK-015
title: 'Author SCSS stylesheet for LibrarySelector so it renders with the dark theme aesthetic'
investigation: INV-001
status: done
priority: medium
blocked_by: []
date_created: 2026-04-21
date_completed: 2026-04-21
files:
  - 'resources/style/library-selector.scss (new)'
  - 'src/style.scss'
---

<!--
  Focused single-concern follow-up to TASK-004 (Library Selector UI).
  During QA review of INV-001 the task-closer agent discovered that
  `LibrarySelector.tsx` references a dozen CSS class names but no
  matching `.scss` file was ever authored, so the component renders
  with only default browser styling — violating TASK-004's requirement
  "Match the existing dark theme aesthetic".
-->

## What

Author `resources/style/library-selector.scss` containing styles for every class selector referenced by `src/frontend/containers/LibrarySelector.tsx`, using the project's CSS custom-property theme variables so the component renders correctly in both dark and light themes. Register the new stylesheet in `src/style.scss` so it is bundled with the rest of the application styles.

Scope is strictly styling — **no changes to `LibrarySelector.tsx` markup, no new class names, no refactors**. Every selector in this file must correspond to a class already present in the component as of commit `c620ff67`.

## Why

TASK-004 built the `LibrarySelector` component and declared CSS classes on its elements, but the companion stylesheet was never created. As a result the selector currently renders as unstyled HTML — headings, cards, and buttons have no layout, spacing, colors, or borders beyond browser defaults and the theme body color. This breaks TASK-004's "Match the existing dark theme aesthetic" requirement and looks broken next to the rest of the application.

The root cause is simply a missing file; the fix is to author that file following the conventions already established by sibling stylesheets such as `resources/style/settings.scss`, `resources/style/help-center.scss`, and `resources/style/about.scss`.

See [INV-001](../../pending_qa/investigations/INV-001_MEDIUM_ELECTRON_multi-library-support.md) and TASK-004 for the broader feature context.

## Project Styling Conventions (reference)

Read these before writing:

- **File location:** All component stylesheets live in `resources/style/` (flat, with a `controls/` subfolder for widget primitives). Component stylesheets are NOT co-located with `.tsx` files.
- **Import pattern:** Every stylesheet is manually `@import`ed from `src/style.scss`. Webpack resolves `~resources/style/...` via its alias configuration.
- **Theme variables:** Colors, borders, and hover states come from CSS custom properties defined in `resources/style/themes.scss` (available on both `.dark` and `.light` root classes). **Never hardcode colors.** The relevant variables for this component are:
  - `--background-color`, `--background-color-alt`, `--background-color-selected`
  - `--text-color`, `--text-color-muted`, `--text-color-strong`
  - `--shade1`, `--shade2`
  - `--accent-color`, `--accent-color-blue`, `--accent-color-variation`
  - `--border-color`
  - `--input-color`, `--input-color-hover`
  - `--hover-color`, `--hover-color-alt`
  - `--box-shadow`
- **Input styling:** Reuse the `.input` patterns from `resources/style/controls/input.scss` (background `var(--input-color)`, 0.0625rem border, 0.25rem radius, 0.125rem accent-color focus ring). The `LibrarySelector` uses bare `<input>` elements — style them directly via the class names listed below, mirroring the `.input` rules so they blend in.
- **Buttons:** The component uses `<Button>` and `<ButtonGroup>` from `widgets/`, which are already styled by `resources/style/controls/button.scss`. Do NOT restyle the buttons themselves — only lay them out within `.library-card-actions` and `.library-create-form`.
- **Units:** Use `rem` for spacing/sizing (base 16px, see `global.scss`). Match the 0.25rem / 0.5rem / 1rem / 1.25rem / 2rem rhythm already used throughout the codebase.
- **Borders/radius:** 0.0625rem solid borders and 0.25rem border-radius are the dominant idiom (see `settings.scss`, `input.scss`). Slightly larger radii (0.5rem – 0.75rem) are acceptable for full cards (see `about.scss` images).

## Required Selectors

Every one of the following classes is referenced by `LibrarySelector.tsx`. The stylesheet must style each of them. Do not add extra selectors beyond these (plus descendant/pseudo-class selectors targeting them).

### Root container and header
- `.library-selector` — Outermost wrapper. Full-viewport layout (`width: 100vw; height: 100vh;`), `background: var(--background-color)`, column flex, centered content with a sensible max-width on the inner column (suggest `max-width: 640px` centered via `margin: auto`), `padding: 2rem`. Matches the centered-fullscreen feel of `#about` and `#help-center`.
- `.library-selector-header` — Header block. Centered text, modest bottom margin (`margin-bottom: 1.5rem`). Its `h1` should use `var(--text-color-strong)` and a reasonable display size (e.g. `font-size: 1.5rem; margin-bottom: 0.25rem`). Its `p` should use `var(--text-color-muted)`.

### Library list
- `.library-selector-list` — Vertical stack of cards. `display: flex; flex-direction: column; gap: 0.75rem;` with `overflow-y: auto` so many libraries remain scrollable, `flex: 1 1 auto` so it takes the remaining vertical space between header and footer.
- `.library-card` — Individual library row. Horizontal flex with `justify-content: space-between` and `align-items: center`, `padding: 0.75rem 1rem`, `background: var(--background-color-alt)`, `border: 0.0625rem solid var(--border-color)`, `border-radius: 0.25rem`, `gap: 1rem`. Add a subtle hover state (`background: var(--hover-color)` on `:hover`).
- `.library-card--active` — Modifier for the currently active library card. Highlight using `border-color: var(--accent-color)` and a faint tinted background (`background: var(--accent-color-variation)`). On hover, keep the highlighted look (do not revert to the generic hover color).
- `.library-card-info` — Left-hand side of the card (name + date). Column flex, `gap: 0.25rem`, `min-width: 0` so long names ellipsize rather than overflow.
- `.library-card-name` — The library's display name. `color: var(--text-color-strong)`, `font-weight: 600`, `font-size: 1rem`, and `overflow: hidden; text-overflow: ellipsis; white-space: nowrap` to handle long names.
- `.library-card-date` — "Last opened: …" text. `color: var(--text-color-muted)`, `font-size: 0.8125rem` (matches the project body size).
- `.library-card-actions` — Right-hand button cluster. `display: flex; gap: 0.5rem; flex-shrink: 0;` so buttons never wrap under the text.
- `.library-card-rename-input` — Inline rename `<input>`. Apply the `.input` idiom: `background: var(--input-color)`, `border: 0.0625rem solid var(--border-color)`, `border-radius: 0.25rem`, `color: var(--text-color)`, `padding: 0.25rem 0.5rem`, `height: 1.75rem`, `width: 100%`. On `:hover`, `background: var(--input-color-hover)`. On `:focus`, `box-shadow: 0 0 0 0.125rem var(--accent-color)` and keep the non-hover background. It replaces `.library-card-name` in-place, so it should fill the same horizontal space.

### Footer and inline create form
- `.library-selector-footer` — Footer under the list. `display: flex; justify-content: center; padding-top: 1rem; border-top: 0.0625rem solid var(--border-color); margin-top: 1rem;`.
- `.library-create-form` — Row containing the new-library input and its Create/Cancel buttons. `display: flex; align-items: center; gap: 0.5rem; width: 100%;`.
- `.library-create-input` — The new-library name `<input>`. Mirror `.library-card-rename-input` (same `.input` idiom), with `flex: 1 1 auto` so it expands to fill available width, leaving the `<ButtonGroup>` at its natural width on the right.

## Implementation Steps

- [x] 1. **Create `resources/style/library-selector.scss`.** Author all selectors listed in the *Required Selectors* section above. Use only the CSS custom properties and units specified. Follow the comment-header style of neighboring files (e.g. `///////////////////////////////// Library Selector /////////////////////////////////`). Verify: file exists, contains exactly the listed selectors (plus pseudo-classes/modifiers), and contains no hardcoded hex colors other than passing values through `var(...)`.

- [x] 2. **Register the stylesheet in `src/style.scss`.** Add `@import '~resources/style/library-selector.scss';` in the "Individual components" section, alphabetically grouped near `about.scss`, `help-center.scss`, and `settings.scss`. Verify: running `yarn dev` (Webpack watch) produces no SCSS compilation errors and the file is included in the emitted bundle. — Verified via `yarn build`: webpack compiled successfully, CSS bundle emitted at 125 KiB with no SCSS errors.

- [ ] 3. **Visual verification — dark theme.** Launch the app (`yarn start`), force the Library Selector to appear (either by creating a second library via Settings > Advanced > Switch Library, or by launching with an empty `active-library.json`). Confirm:
  - Header is centered, readable, and uses the strong text color.
  - Library cards stack vertically with visible borders and rounded corners, against the app's dark background.
  - The active library card has an accent-colored border and a subtly tinted background.
  - Hovering a non-active card changes its background.
  - Clicking Rename swaps the name for an input that matches other app inputs (same border, same focus ring).
  - Clicking New Library reveals an inline input + Create/Cancel buttons laid out on one row.
  - Long library names ellipsize rather than overflow the card.
  NOTE: Cannot be verified in a non-interactive CI environment. Deferred to QA.

- [ ] 4. **Visual verification — light theme.** Switch the app to the light theme in Settings. Reopen the Library Selector and confirm every element above still reads correctly (contrast, borders, accent highlight). No hardcoded dark-only colors should leak through.
  NOTE: Cannot be verified in a non-interactive CI environment. Deferred to QA.

- [x] 5. **Lint.** Run `yarn lint`. If the project has any SCSS/stylelint configuration, ensure the new file is clean. If not, verify the file follows the 2-space indent and single-quote convention already used in sibling stylesheets. — No stylelint config exists in this project. The new file uses 2-space indentation, no string literals, and no hardcoded colors. All 49 ESLint errors reported by `yarn lint` are pre-existing in other files; none touch any file modified by this task.

## Done When

- [x] `resources/style/library-selector.scss` exists and styles every class name listed in *Required Selectors*.
- [x] `src/style.scss` imports the new file.
- [ ] The Library Selector renders with the dark theme aesthetic: cards with borders, accent-colored active indicator, matching inputs, correctly laid-out button groups. (Deferred to QA visual check)
- [ ] The Library Selector is also visually correct under the light theme (no hardcoded colors). (Deferred to QA visual check)
- [x] No new class names were introduced; `LibrarySelector.tsx` is unchanged.
- [x] `yarn build` compiles without SCSS errors; `yarn lint` errors are all pre-existing in other files.
