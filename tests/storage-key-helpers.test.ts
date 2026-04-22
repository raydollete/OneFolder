import path from 'path';

import { getSqliteDbPath } from '../common/library-registry';
import { getFileStorageKey } from '../src/frontend/stores/FileStore';
import { getPreferencesStorageKey } from '../src/frontend/stores/UiStore';

// ---------------------------------------------------------------------------
// getSqliteDbPath
// ---------------------------------------------------------------------------

describe('getSqliteDbPath', () => {
  const uuid = '11111111-2222-3333-4444-555555555555';

  // 1. POSIX-style basePath with a UUID libraryId
  it('returns the correct path for a POSIX-style basePath', () => {
    const basePath = '/home/user/.config/OneFolder';
    const result = getSqliteDbPath(basePath, uuid);
    expect(result).toBe(path.join(basePath, 'libraries', uuid, 'onefolder.db'));
  });

  // 2. Windows-style basePath
  it('produces a path whose segments include libraries, the UUID, and onefolder.db on any platform', () => {
    const basePath = 'C:\\Users\\me\\AppData\\Roaming\\OneFolder';
    const result = getSqliteDbPath(basePath, uuid);
    const normalized = path.normalize(result);
    expect(normalized).toContain('libraries');
    expect(normalized).toContain(uuid);
    expect(normalized).toContain('onefolder.db');
  });

  // 3. Empty-string libraryId — document current behavior (no guard)
  it('produces a path with an empty segment when libraryId is an empty string', () => {
    // The function does NOT guard against empty strings; calling code is
    // responsible for passing a valid UUID. This test pins the current behavior
    // so that a future refactor adding a guard is a deliberate decision.
    const basePath = '/some/base';
    const result = getSqliteDbPath(basePath, '');
    expect(result).toBe(path.join(basePath, 'libraries', '', 'onefolder.db'));
  });
});

// ---------------------------------------------------------------------------
// getPreferencesStorageKey
// ---------------------------------------------------------------------------

describe('getPreferencesStorageKey', () => {
  // 4. undefined returns 'preferences'
  it('returns "preferences" when called with undefined', () => {
    expect(getPreferencesStorageKey(undefined)).toBe('preferences');
  });

  // 5. No argument (same as undefined)
  it('returns "preferences" when called with no argument', () => {
    expect(getPreferencesStorageKey()).toBe('preferences');
  });

  // 6. Empty-string libraryId — empty string is falsy, returns bare key
  it('returns "preferences" when called with an empty string (falsy guard)', () => {
    // The implementation uses `libraryId ? ... : 'preferences'`, so an empty
    // string falls through to the default. The migration in renderer.tsx relies
    // on this so that a caller who accidentally passes '' does not create a
    // ':preferences' orphan key.
    expect(getPreferencesStorageKey('')).toBe('preferences');
  });

  // 7. UUID libraryId returns namespaced key
  it('returns a namespaced key when called with a UUID libraryId', () => {
    expect(getPreferencesStorageKey('1234-abcd')).toBe('1234-abcd:preferences');
  });
});

// ---------------------------------------------------------------------------
// getFileStorageKey
// ---------------------------------------------------------------------------

describe('getFileStorageKey', () => {
  // 8. undefined returns 'OneFolder_File'
  it('returns "OneFolder_File" when called with undefined', () => {
    expect(getFileStorageKey(undefined)).toBe('OneFolder_File');
  });

  // 9. Empty-string libraryId — same falsy-check rationale as getPreferencesStorageKey
  it('returns "OneFolder_File" when called with an empty string (falsy guard)', () => {
    expect(getFileStorageKey('')).toBe('OneFolder_File');
  });

  // 10. UUID libraryId returns namespaced key
  it('returns a namespaced key when called with a UUID libraryId', () => {
    expect(getFileStorageKey('1234-abcd')).toBe('1234-abcd:OneFolder_File');
  });
});
