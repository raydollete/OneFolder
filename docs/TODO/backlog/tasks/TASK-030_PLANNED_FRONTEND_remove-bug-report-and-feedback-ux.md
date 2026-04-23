---
id: TASK-030
title: 'Remove bug-report / upstream-issues and canny.io feedback UX'
investigation: INV-006
status: PLANNED
priority: medium
blocked_by: []
date_created: 2026-04-23
date_completed:
files:
  - 'src/main.ts'
  - 'common/config.ts'
  - 'src/frontend/containers/ErrorBoundary.tsx'
  - 'src/frontend/containers/AppToolbar/SecondaryCommands.tsx'
  - 'src/frontend/components/ImageTools.tsx'
  - 'src/frontend/components/ImageDuplicates.tsx'
  - 'src/frontend/containers/Inspector/index.tsx'
  - 'src/frontend/containers/ContentView/MapView.tsx'
  - 'src/frontend/containers/ContentView/FaceGallery.tsx'
  - 'src/frontend/containers/ContentView/Placeholder.tsx'
  - 'src/frontend/containers/About.tsx'
---

## What

Strip every runtime UI that steers the user to file bugs in the upstream GitHub issues tracker or vote on the canny.io feedback portal, plus the `createBugReport` helper in `common/config.ts` and its `githubUrl` constant. Uncaught-exception dialogs and React ErrorBoundary fallbacks lose their "File bug report" / "Create Issue" button but keep all other recovery options (restart, keep running, quit, reload, DevTools, clear database). WIP placeholder panes (MapView, FaceGallery, ImageDuplicates, Inspector Tools) lose their canny.io "vote on our roadmap / let us know" buttons and gain neutral copy.

Provenance links to the upstream repo (e.g. the `github.com/OneFolderApp/OneFolder` ExternalLink in `About.tsx`) are preserved — this task removes the **primary bug-report UX**, not every upstream reference.

## Why

This fork is a personal single-user build. There are no upstream maintainers to file bugs against for fork-local code, and clicking the "File bug report" button in a fork build would open a pre-filled GitHub issue form at `OneFolderApp/OneFolder/issues/new` — noise for upstream maintainers and confusion for the fork user. The canny.io feedback links similarly point to an upstream product-management portal that does not exist for this fork.

Per INV-006 §UX Requirements, the user explicitly distinguished informational provenance links (fine to keep) from primary bug-report UX (remove). This task implements that split.

See [INV-006](../investigations/INV-006_MEDIUM_ELECTRON_strip-update-checks-bug-report-and-telemetry-for-personal-fork.md) for the full blast-radius enumeration.

## Implementation Steps

### `common/config.ts`

- [ ] 1. Remove `import os from 'os';` at line 1 (only used by `createBugReport`).

- [ ] 2. Remove `export const githubUrl = 'https://github.com/OneFolderApp/OneFolder';` at line 6.

- [ ] 3. Remove the entire `createBugReport` export (lines 28-56), including the preceding JSDoc block.

- [ ] 4. Verify the remaining exports (`SERVER_PORT`, `chromeExtensionUrl`, `firefoxExtensionUrl`, `RECURSIVE_DIR_WATCH_DEPTH`, `MAX_TAG_DEPTH`, `thumbnailFormat`, `thumbnailMaxSize`, `maxNumberOfExternalFilesBeforeWarning`) compile without the `os` import.

### `src/main.ts` uncaught-exception dialog

- [ ] 5. Remove the import at line 20: `import { createBugReport, githubUrl } from '../common/config';`

- [ ] 6. In the `process.on('uncaughtException', ...)` handler (currently lines 547-586):
  - Change the error message at line 550 from:
    ```ts
    const errorMessage = `An unexpected error occurred. Please file a bug report if you think this needs fixing!\n${...}`;
    ```
    to:
    ```ts
    const errorMessage = `An unexpected error occurred.\n${...}`;
    ```
    (Keep the rest of the template literal unchanged — the stack/message/name formatting is still useful.)
  - Change the `buttons` array at line 561 from:
    ```ts
    buttons: ['Try to keep running', 'File bug report', 'Restart OneFolder', 'Quit OneFolder'],
    ```
    to:
    ```ts
    buttons: ['Try to keep running', 'Restart OneFolder', 'Quit OneFolder'],
    ```
  - Renumber the response branches at lines 563-576:
    - `response === 0`: Keep running (unchanged)
    - `response === 1`: Restart (currently was response === 2)
    - `response === 2`: Quit (currently was response === 3)
    - Delete the `response === 1` "File bug report" branch entirely (the `createBugReport` + `encodeURIComponent` + `shell.openExternal(url)` block).

### `src/frontend/containers/ErrorBoundary.tsx`

- [ ] 7. Remove unused imports:
  - Line 2: `import { shell } from 'electron';` (only used by `openIssueURL`).
  - Line 6: `import { createBugReport, githubUrl } from 'common/config';`

- [ ] 8. Remove the `openIssueURL` method and its binding:
  - Line 71 (in constructor): `this.openIssueURL = this.openIssueURL.bind(this);`
  - Lines 97-103 (method body).

- [ ] 9. Remove the "Create Issue" `<Button>` in the render method (lines 129-134):
  ```tsx
  <Button
    styling="outlined"
    onClick={this.openIssueURL}
    icon={IconSet.GITHUB}
    text="Create Issue"
  />
  ```
  The `ButtonGroup` continues to contain Reload, Toggle DevTools, Clear Database.

- [ ] 10. Soften the copy at line 114 from:
  ```tsx
  <p>You can try one of the following options or contact the maintainers.</p>
  ```
  to:
  ```tsx
  <p>You can try one of the following options.</p>
  ```

### `src/frontend/containers/AppToolbar/SecondaryCommands.tsx`

- [ ] 11. Remove the "💡ideas + 🐞bugs" MenuItem at lines 38-44:
  ```tsx
  <MenuItem
    icon={IconSet.THUMB_BG}
    onClick={() => {
      shell.openExternal('https://onefolder.canny.io/feedback');
    }}
    text="💡ideas + 🐞bugs"
  />
  ```

- [ ] 12. If after step 11 and TASK-029's step 9 the `shell` import is unused, remove `import { shell } from 'electron';` at line 8. (Verify first — the "help center" MenuItem at lines 45-53 also uses `shell.openExternal`, so it is likely still needed.)

### `src/frontend/components/ImageTools.tsx`

- [ ] 13. Remove the `import { shell } from 'electron';` at line 5.

- [ ] 14. Replace the "Ideas on what we should add? ... Let us know" block (lines 20-30) with a neutral single-line caption, or remove the paragraph entirely. Minimal-diff option (remove entirely):
  ```tsx
  // Before:
  <p className="text-center">
    Ideas on what we should add? <br /> Which one should we do first? <br />
    <button ...>Let us know</button>
  </p>
  <p className="text-center"></p>
  // After: (delete both <p> elements)
  ```
  Leave the four disabled tool buttons (HEIC → JPEG, Optimize JPEG, Fix red eyes, Colorize) in place — they are the informative placeholder.

### `src/frontend/components/ImageDuplicates.tsx` and `src/frontend/containers/Inspector/index.tsx`

- [ ] 15. The `ImageDuplicates` component is imported in `Inspector/index.tsx:9` but the `<InspectorToggleSection ...>` that mounts it at lines 70-76 is commented out. Two options:
  - **Option A (preferred, smaller source tree):** Delete the file `src/frontend/components/ImageDuplicates.tsx`. Remove the import at `Inspector/index.tsx:9`. Leave the commented-out InspectorToggleSection block as-is (future contributor can re-add the component with the new name/behavior they want).
  - **Option B (keep stub):** Replace the canny.io button (lines 18-29) with a neutral `<p className="text-center">This feature is not ready yet.</p>` and remove the `shell` import. Keeps the file but neutralizes the feedback link.

  Use Option A. It matches the "remove, do not flag-disable" principle.

### `src/frontend/containers/ContentView/MapView.tsx`

- [ ] 16. Remove `import { shell } from 'electron';` at line 3.

- [ ] 17. Replace the `<div className="wip-container">...</div>` block (lines 33-52) with a simpler WIP message that has no canny.io button:
  ```tsx
  <div className="wip-container">
    The map view is not yet implemented.
  </div>
  ```
  (Adjust HTML to match the `.wip-container` styling expected — check whether it renders correctly with just text; the CSS likely just styles it as centered content.)

### `src/frontend/containers/ContentView/FaceGallery.tsx`

- [ ] 18. Remove `import { shell } from 'electron';` at line 29.

- [ ] 19. Replace the `<div className="wip-container">...</div>` block (lines 48-67) with a simpler WIP message:
  ```tsx
  <div className="wip-container">
    Face view is not yet implemented.
  </div>
  ```
  Leave the `ProfilePic` placeholders below (they are sample content and harmless).

### `src/frontend/containers/ContentView/Placeholder.tsx`

- [ ] 20. Soften the `BugReport` component (lines 182-188):
  ```tsx
  // Before:
  const BugReport = () => {
    return (
      <ContentPlaceholder title="You encountered a bug!" icon={IconSet.WARNING_FILL}>
        <p>Please report this bug to the maintainers!</p>
      </ContentPlaceholder>
    );
  };
  // After:
  const BugReport = () => {
    return (
      <ContentPlaceholder title="Something went wrong" icon={IconSet.WARNING_FILL}>
        <p>Try selecting a different view from the sidebar.</p>
      </ContentPlaceholder>
    );
  };
  ```
  Keep the function name `BugReport` for minimal diff — it is still the catch-all placeholder, and renaming it would touch line 26 (`return <BugReport />;`) for no user-visible benefit.

### `src/frontend/containers/About.tsx`

- [ ] 21. In the bullet list under the `github.com/OneFolderApp/OneFolder` ExternalLink (lines 37-41):
  ```tsx
  <ul>
    <li>🤓 View the source code</li>
    <li>🐛 Provide feedback and report bugs</li>
    <li>👥 Learn about contributing</li>
  </ul>
  ```
  Remove the middle bullet ("🐛 Provide feedback and report bugs"). Keep the two others — they are informational about the upstream repo, not primary bug-report UX.

### Verification

- [ ] 22. Run `yarn build`. Expect zero TypeScript errors. Any remaining errors are likely unused-import cleanup (remove the orphan imports).

- [ ] 23. Run `yarn start`. Trigger the ErrorBoundary by forcing a React render error (easiest: add a temporary `throw new Error('test')` in a component, then revert). Verify the fallback shows Reload / Toggle DevTools / Clear Database — no Create Issue button.

- [ ] 24. Open the toolbar "More" (three-dots) menu. Verify no "💡ideas + 🐞bugs" item. (If TASK-029 has also landed, verify no "check for updates" item.)

- [ ] 25. Open the Inspector on any image. Expand the Tools section. Verify the feedback button is gone; only the four disabled tool buttons remain.

- [ ] 26. Switch the content view to Map (if enabled via a location with GPS data or similar) and Faces (via the Face module if enabled). Verify the WIP message has no canny.io link.

- [ ] 27. Run `yarn package:portable`. Verify the build succeeds.

- [ ] 28. Commit with a message like "Remove bug-report and canny.io feedback UX for personal fork (INV-006)".

## Done When

- [ ] `common/config.ts` contains no `createBugReport` function, no `githubUrl` constant, and no `import os from 'os'`.
- [ ] `src/main.ts` has no `createBugReport` / `githubUrl` imports and its uncaughtException dialog has three buttons ("Try to keep running", "Restart OneFolder", "Quit OneFolder") with correctly renumbered response branches.
- [ ] `src/frontend/containers/ErrorBoundary.tsx` has no "Create Issue" button, no `openIssueURL` method, no `createBugReport`/`githubUrl` imports, and no "contact the maintainers" copy.
- [ ] `src/frontend/containers/AppToolbar/SecondaryCommands.tsx` has no "💡ideas + 🐞bugs" MenuItem.
- [ ] `src/frontend/components/ImageTools.tsx` has no "Let us know" button and no `shell` import.
- [ ] `src/frontend/components/ImageDuplicates.tsx` is deleted, and its import in `src/frontend/containers/Inspector/index.tsx` is removed.
- [ ] `src/frontend/containers/ContentView/MapView.tsx` and `FaceGallery.tsx` have no canny.io "vote on roadmap" buttons and no unused `shell` imports.
- [ ] `src/frontend/containers/ContentView/Placeholder.tsx` `BugReport` component has softened copy (no "maintainers" reference).
- [ ] `src/frontend/containers/About.tsx` bullet list has no "Provide feedback and report bugs" line (repo link itself preserved).
- [ ] `grep -rn "canny.io\|createBugReport\|issues/new\|githubUrl\|File bug report\|Create Issue" src/ common/ --include="*.ts" --include="*.tsx"` returns only comments or zero matches.
- [ ] `yarn build`, `yarn start`, and `yarn package:portable` all succeed.
