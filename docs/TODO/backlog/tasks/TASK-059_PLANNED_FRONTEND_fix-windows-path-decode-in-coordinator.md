---
id: TASK-059
title: 'Fix MediaReleaseCoordinator DOM-fallback path decoding to round-trip Windows file:// URLs'
investigation: INV-014
status: planned
priority: critical
blocked_by: []
date_created: 2026-05-04
date_completed:
files:
  - src/frontend/image/MediaReleaseCoordinator.ts
  - tests/media-release-coordinator.test.ts
---

## What

Repair `MediaReleaseCoordinator.decodeVideoSrcToPath` (and/or `normalizePath`) so that the
browser-resolved form of a Windows `<video>.src` URL — `file:///C:/Users/foo/bar.mp4` —
round-trips back to the same registry key the trash flow's `f.absolutePath` produces
(`c:\users\foo\bar.mp4` after normalization). Add a unit test that simulates the real
browser URL-resolution behavior (not just the `encodeFilePath`/`decodeVideoSrcToPath` round
trip the existing test exercises).

## Why

INV-014 Root Cause #2: when Chromium resolves `file://C:\Users\foo\bar.mp4` (the form
`encodeFilePath` produces with backslashes), it normalizes the URL to
`file:///C:/Users/foo/bar.mp4` (triple slash, forward slashes — verified empirically with
the Node WHATWG URL parser, which uses the same algorithm). `el.src` returns this
resolved form. The current `decodeVideoSrcToPath` strips `file://` leaving
`/C:/Users/foo/bar.mp4`, then `path.normalize(...)` on Windows native turns this into
`\C:\Users\foo\bar.mp4` (with a leading backslash). After lowercasing this becomes
`\c:\users\foo\bar.mp4` — which never matches the registry key
`c:\users\foo\bar.mp4` produced from `f.absolutePath`.

The DOM-fallback sweep (which was supposed to catch elements TASK-058 doesn't register)
silently misses every Windows match. This must be fixed even after TASK-058 lands so that
any future un-registered video (e.g., third-party React component, library code) is still
caught by the safety net.

The existing unit test `'matches paths case-insensitively'` does not exercise the DOM
fallback through a real `<video>.src` round trip — it constructs the registry key and
target path both from path strings, never going through URL parsing. The new test
must parse a real file URL exactly as Chromium would.

See [INV-014](../investigations/INV-014_HIGH_FRONTEND_video-delete-ebusy-recurs-fix-incomplete.md).

## Implementation Steps

- [ ] 1. In `src/frontend/image/MediaReleaseCoordinator.ts`, update `decodeVideoSrcToPath`:
  - After stripping `file://` and any query params, check if the result matches the regex
    `/^\/[A-Za-z]:[\/\\]/`. If yes (Windows drive-letter pattern with leading slash from
    the file:/// triple-slash form), strip the leading `/`.
  - Continue with `decodeURIComponent` on the remainder.
  - Example: `'file:///C:/Users/foo/bar.mp4'` → strip `file://` → `'/C:/Users/foo/bar.mp4'`
    → drive-letter regex matches → strip leading `/` → `'C:/Users/foo/bar.mp4'` →
    decodeURIComponent → `'C:/Users/foo/bar.mp4'`.
  - Then `normalizePath('C:/Users/foo/bar.mp4')` returns `c:\users\foo\bar.mp4` on
    Windows — matching the registry key shape.

- [ ] 2. Verify cross-platform safety:
  - On macOS / Linux, file URLs decode to absolute paths starting with `/Users/foo/bar`
    or `/home/foo/bar`. The drive-letter regex `/^\/[A-Za-z]:[\/\\]/` does NOT match
    these patterns, so the leading `/` is preserved (correct behavior for POSIX).
  - Confirm no behavior change for non-Windows by reading existing unit tests.

- [ ] 3. Add a new unit test in `tests/media-release-coordinator.test.ts` that simulates
      the real browser URL resolution. Two acceptable approaches:
  - **Preferred:** use Node's `URL` (WHATWG) parser directly to mimic Chromium:
    ```ts
    it('DOM-fallback matches a Windows path through real URL resolution', async () => {
      const coordinator = new MediaReleaseCoordinator();
      const el = makeMockVideo();
      const original = 'C:\\Users\\foo\\bar.mp4';
      coordinator.register(original, el);

      // Simulate what <video>.src returns after Chromium parses encodeFilePath's output
      const browserResolvedSrc = new URL(encodeFilePath(original)).href;
      // (Should be 'file:///C:/Users/foo/bar.mp4')
      expect(browserResolvedSrc).toMatch(/^file:\/\/\//);
      expect(browserResolvedSrc).toContain('C:');

      const decoded = decodeVideoSrcToPath(browserResolvedSrc);
      expect(decoded).toBeDefined();
      // The decoded path, after normalizePath, must produce the same key as the registered original
      // (we test this indirectly by calling releasePaths with the decoded path)
      await coordinator.releasePaths([decoded!], { timeoutMs: 0 });
      expect(el.pause).toHaveBeenCalledTimes(1);
    });
    ```
  - **Alternative:** use jsdom's `<video>` element and read `el.src` directly. Heavier
    setup; only do this if the URL approach is unreliable.

- [ ] 4. Add a complementary test for the DOM-fallback codepath itself (sweeping the
      document) so that we have coverage of the actual `querySelectorAll` path. Use
      jsdom (Jest's default test environment is jsdom; check `jest.config.js`):
  ```ts
  it('DOM-fallback sweep finds and releases an unregistered Windows video', async () => {
    const coordinator = new MediaReleaseCoordinator();
    const original = 'C:\\Users\\foo\\bar.mp4';
    const videoEl = document.createElement('video');
    videoEl.src = encodeFilePath(original);
    document.body.appendChild(videoEl);

    // Spy on pause/removeAttribute/load directly on the real element
    const pauseSpy = jest.spyOn(videoEl, 'pause');
    const removeAttrSpy = jest.spyOn(videoEl, 'removeAttribute');
    const loadSpy = jest.spyOn(videoEl, 'load');

    await coordinator.releasePaths([original], { timeoutMs: 0 });

    expect(pauseSpy).toHaveBeenCalled();
    expect(removeAttrSpy).toHaveBeenCalledWith('src');
    expect(loadSpy).toHaveBeenCalled();

    document.body.removeChild(videoEl);
  });
  ```

- [ ] 5. Run `yarn test` and verify the new tests pass on both Windows and (if accessible)
      a POSIX runner. The drive-letter regex must be path-platform-agnostic so the test
      passes regardless of where Jest runs.

- [ ] 6. Build (`yarn build` or `yarn dev`) and verify no TypeScript / lint errors.

## Done When

- [ ] `decodeVideoSrcToPath` correctly handles `file:///<DRIVE>:/...` Windows URL form
      (strips the leading `/` so subsequent `path.normalize` does not insert a
      leading separator).
- [ ] No regression on POSIX: a `file:///Users/foo/bar.mp4` URL still decodes to
      `/Users/foo/bar.mp4` and matches a registry entry registered as `/Users/foo/bar.mp4`.
- [ ] New unit test verifies the round-trip through real WHATWG URL parsing matches a
      registered absolute path.
- [ ] New unit test verifies the DOM-fallback sweep (querySelectorAll path) finds and
      releases an attached `<video>` element.
- [ ] `yarn test` passes; `yarn build` produces no errors.
