# Testing Patterns

**Analysis Date:** 2026-06-24

## Test Framework

**Runner:**
- Jest ^29.5.0
- Config: `jest.config.js` at project root
- Test environment: node (default) with optional `jsdom` for DOM tests
- Preset: `ts-jest` for TypeScript transpilation

**Assertion Library:**
- Jest's built-in `expect` matchers (no external library)

**Run Commands:**
```bash
yarn test              # Run all tests once
yarn test --watch     # Run in watch mode (re-run on file changes)
yarn test --coverage  # Generate coverage report
```

## Test File Organization

**Location:**
- Tests co-located in dedicated `tests/` directory at project root (separate from source)
- Test files: `tests/*.test.ts` or `tests/*.test.tsx`

**Naming Pattern:**
- `[system].test.ts` (e.g., `backend.test.ts`, `media-job.test.ts`, `library-registry.test.ts`)
- Tests match the functionality they cover; no directory mirroring of `src/`

**Current Test Files:**
- `tests/backend.test.ts` — Backend API and database operations
- `tests/library-registry.test.ts` — Multi-library registry
- `tests/tag-store.test.ts` — Tag store MobX operations
- `tests/media-job.test.ts` — Media encoding (ffmpeg argv assembly + integration)
- `tests/media-release-coordinator.test.ts` — Video element lifecycle
- `tests/media-release-coordinator-dom.test.ts` — DOM-based video element release (jsdom)
- `tests/media-queue-store.test.ts` — Media queue state management
- `tests/file-store-*.test.ts` — FileStore regression tests (multiple files for specific scenarios)
- `tests/video-freeze-recovery.test.ts` — Video freeze handling
- `tests/audio-args.test.ts` — FFmpeg audio argument generation
- `tests/path-resolver.test.ts` — Path resolution utilities
- `tests/utils.test.ts` — Utility functions

## Jest Configuration

**Key Setup:**
```javascript
// jest.config.js
{
  preset: 'ts-jest',
  testEnvironment: 'node',
  setupFiles: [
    'fake-indexeddb/auto',        // In-memory IndexedDB for testing
    '<rootDir>/tests/setup/jest.crypto.js',  // Crypto module polyfill
  ],
  moduleNameMapper: {
    '\\.(css|scss|sass)$': '<rootDir>/tests/setup/style-stub.js',  // Stub styles
    '^electron$': '<rootDir>/tests/setup/module-stubs.js',         // Stub Electron
    '^common/(.*)$': path.join(__dirname, 'common/$1'),            // Path aliases
    '^src/(.*)$': path.join(__dirname, 'src/$1'),
    '^widgets/(.*)$': path.join(__dirname, 'widgets/$1'),
  },
}
```

**Why This Setup:**
- `fake-indexeddb` — Replaces Dexie's real IndexedDB with in-memory implementation (jsdom doesn't support IndexedDB)
- `jest.crypto.js` — Provides Crypto API that Node doesn't expose by default
- `style-stub.js` — Prevents SCSS imports from failing (returns empty module)
- `module-stubs.js` — Stubs Electron IPC and native modules for Node environment
- Path aliases — Resolve `common/`, `src/`, `widgets/` imports in tests

**Setup Files Location:**
- `tests/setup/jest.crypto.js`
- `tests/setup/style-stub.js`
- `tests/setup/module-stubs.js`

## Test Structure

**Suite Organization Pattern:**
```typescript
describe('ComponentOrFeatureName', () => {
  // Shared setup/teardown
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fse.ensureDirSync(tmpDir);
  });

  afterEach(() => {
    fse.removeSync(tmpDir);
  });

  // Grouped tests with describe blocks
  describe('SubFeature', () => {
    it('should do X when condition Y holds', () => {
      // Test body
    });

    it('should do Z when condition W holds', () => {
      // Test body
    });
  });
});
```

**Patterns:**

### Basic Test Pattern (Synchronous)
```typescript
it('returns empty list on a fresh base directory', () => {
  const registry = new LibraryRegistry(tmpDir);
  expect(registry.getLibraries()).toEqual([]);
  expect(registry.getActiveLibraryId()).toBeNull();
});
```

### Async Test Pattern
```typescript
it('persists data across instances with Date objects', async () => {
  const registryA = new LibraryRegistry(tmpDir);
  registryA.createLibrary('Persistent Library');

  const registryB = new LibraryRegistry(tmpDir);
  const libs = registryB.getLibraries();
  expect(libs).toHaveLength(1);
  expect(libs[0].createdAt).toBeInstanceOf(Date);
});
```

### Custom Test Helper Pattern (Higher-Order Test)
```typescript
// Instead of duplicating setup, create a helper that receives test function
function test(name: string, test: (backend: Backend) => Promise<void>) {
  it(name, async () => {
    const db = dbInit(`Test_${TEST_DATABASE_ID_COUNTER++}`);
    const backend = await Backend.init(db, () => {});
    await test(backend);
  });
}

// Use it:
test('should create a file when conditions are met', async (backend) => {
  const file = createMockFile();
  await backend.createFilesFromPath('/test', [file]);
  const files = await backend.fetchFiles('id', OrderDirection.Desc);
  expect(files).toHaveLength(1);
});
```

## Mocking

**Mocking Framework:** Jest's built-in `jest.mock()` and `jest.spyOn()`

**Module Mocking Pattern:**
```typescript
jest.mock('child_process', () => {
  const real = jest.requireActual<typeof import('child_process')>('child_process');
  return {
    ...real,
    spawn: (cmd: string, args: string[], opts?: object) => {
      if (cmd === '/fake/ffmpeg') {
        // Return mock process for ffmpeg
        return createMockProcess();
      }
      return real.spawn(cmd, args, opts);  // Forward real calls
    },
  };
});
```

**Spy Pattern:**
```typescript
let existsSpy: jest.SpyInstance;

beforeEach(() => {
  existsSpy = jest.spyOn(fse, 'existsSync');
});

afterEach(() => {
  existsSpy.mockRestore();
});

it('calls existsSync when resolving paths', () => {
  existsSpy.mockReturnValue(false);
  expect(getUniqueSiblingPath(dir, 'clip', 'mp4')).toBe(path.join(dir, 'clip.mp4'));
});
```

**What to Mock:**
- External processes (ffmpeg, ffprobe via spawn mock)
- Filesystem calls (fse operations for path resolution testing)
- Environment-dependent behavior (crypto, date generation)

**What NOT to Mock:**
- Database operations (use real in-memory IndexedDB via `fake-indexeddb`)
- Core application logic (stores, entities)
- API/DTO serialization (test the real transformation)

## Fixtures and Factories

**Test Data Pattern:**
```typescript
const mockTag: TagDTO = {
  id: 'tag1',
  name: 'tag1 name',
  dateAdded: new Date(),
  color: '',
  subTags: [],
  isHidden: false,
};

function createMockFiles(count: number) {
  const mockFiles: FileDTO[] = [];
  for (let index = 0; index < count; index++) {
    mockFiles.push({
      absolutePath: `${mockLocationPath}/test (${index}).jpg`,
      relativePath: `test (${index}).jpg`,
      locationId: 'Default location',
      name: `test (${index}).jpg`,
      size: 42,
      width: 640,
      height: 480,
      dateAdded: new Date(),
      dateModified: new Date(),
      dateCreated: new Date(),
      dateLastIndexed: new Date(),
      extension: 'jpg',
      ino: index.toString(),
      id: index.toString(),
      tags: [],
      annotations: '',
    });
  }
  return mockFiles;
}
```

**Location:**
- Inline in test file (if small, one-off)
- In dedicated `tests/fixtures/` directory (if reused across multiple test files)

**Pattern:**
- Create minimal valid DTOs with required fields
- Use spread operator to override specific fields: `{ ...mockTag, id: 'custom-id' }`
- Factories should be pure functions that return fresh instances

## Testing Rendered Components

**jsdom Environment:**
For tests that need DOM, add a JSDoc comment:
```typescript
/**
 * @jest-environment jsdom
 *
 * Tests for MediaReleaseCoordinator DOM-fallback sweep...
 */

import { MediaReleaseCoordinator } from '../src/frontend/image/MediaReleaseCoordinator';

describe('MediaReleaseCoordinator DOM-fallback sweep (jsdom)', () => {
  afterEach(() => {
    // Clean up DOM elements
    document.querySelectorAll('video').forEach((v) => v.remove());
  });

  it('DOM-fallback sweep finds and releases an unregistered video element', async () => {
    const coordinator = new MediaReleaseCoordinator();
    const videoEl = document.createElement('video');
    videoEl.setAttribute('src', encodeFilePath('C:/Users/foo/bar.mp4'));
    document.body.appendChild(videoEl);

    const pauseSpy = jest.spyOn(videoEl, 'pause').mockImplementation(() => undefined);
    const removeAttrSpy = jest.spyOn(videoEl, 'removeAttribute');
    const loadSpy = jest.spyOn(videoEl, 'load').mockImplementation(() => undefined);

    await coordinator.releasePaths(['C:/Users/foo/bar.mp4'], { timeoutMs: 0 });

    expect(pauseSpy).toHaveBeenCalled();
    expect(removeAttrSpy).toHaveBeenCalledWith('src');
    expect(loadSpy).toHaveBeenCalled();

    document.body.removeChild(videoEl);
  });
});
```

**jsdom Capabilities:**
- Creates real `window`, `document`, `HTMLElement` objects
- Supports event listeners, DOM queries, DOM mutations
- Useful for testing:
  - URL encoding/decoding (jsdom implements WHATWG algorithms)
  - Video element state (pause, load, removeAttribute)
  - Document queries (querySelectorAll)
- Limitations: `HTMLVideoElement.pause/load` are stubs (mock them with `jest.spyOn`)

## Test Coverage

**Requirements:** None enforced (no threshold in CI)

**View Coverage:**
```bash
yarn test --coverage
```

Coverage report is generated in the console and can be extended to file-based reports if needed.

## Common Test Patterns

### Async Testing
```typescript
it('fetches data from backend', async () => {
  const backend = await Backend.init(db, () => {});
  const tags = await backend.fetchTags();
  expect(tags).toHaveLength(2);
  expect(tags[0].id).toBe(ROOT_TAG_ID);
});
```

### Error Testing
```typescript
it('should throw when tag does not exist', async () => {
  const registry = new LibraryRegistry(tmpDir);
  // No explicit error expectation needed if we just want to verify it throws
  expect(() => registry.renameLibrary('non-existent-id', 'New Name')).not.toThrow();
});

// Or with specific error message:
// expect(() => { /* code */ }).toThrow('expected message');
```

### Date/Timestamp Testing
```typescript
it('updates timestamp to a strictly later value', async () => {
  const registryA = new LibraryRegistry(tmpDir);
  const lib = registryA.createLibrary('Opened Library');
  const originalTimestamp = registryA.getLibraries()[0].lastOpenedAt.getTime();

  // Wait to guarantee time passage
  await new Promise((resolve) => setTimeout(resolve, 15));
  registryA.updateLastOpened(lib.id);

  const updatedTimestamp = registryA.getLibraries()[0].lastOpenedAt.getTime();
  expect(updatedTimestamp).toBeGreaterThan(originalTimestamp);
});
```

### Persistence Testing (Across Instances)
```typescript
it('persists data across registry instances', () => {
  const registryA = new LibraryRegistry(tmpDir);
  registryA.createLibrary('Persistent Library');

  // Create a new instance to verify data survives
  const registryB = new LibraryRegistry(tmpDir);
  const libs = registryB.getLibraries();
  expect(libs).toHaveLength(1);
  expect(libs[0].name).toBe('Persistent Library');
});
```

### Testing with Generated Test Data
```typescript
function testWithBackend(
  name: string,
  fn: (backend: Backend) => Promise<void>,
): void {
  it(name, async () => {
    const db = dbInit(`Test_${TEST_DATABASE_ID_COUNTER++}`);
    const backend = await Backend.init(db, () => {});
    await fn(backend);
  });
}

// Usage:
testWithBackend('removes tag from all tagged files', async (backend) => {
  await backend.createTag(mockTag);
  const files = createMockFiles(2);
  await backend.createFilesFromPath(mockLocationPath, files);
  await backend.removeTags([mockTag.id]);

  const dbFiles = await backend.fetchFiles('id', OrderDirection.Desc);
  expect(dbFiles.every((f) => f.tags.length === 0)).toBe(true);
});
```

## Development Regressions & Known Issues

**Tests document known bugs and regressions:**
- Comments like `// INV-007 regression` mark code paths that caused past issues
- See `tests/backend.test.ts`, `tests/file-store-*.test.ts` for examples
- These tests prevent re-introduction of fixed bugs

**Video Freeze Recovery:**
- `tests/video-freeze-recovery.test.ts` — prevents video element from becoming unresponsive during media operations

**Media Release:**
- `tests/media-release-coordinator.test.ts` — ensures video/audio elements are properly cleaned up
- `tests/media-release-coordinator-dom.test.ts` — DOM fallback sweep for unregistered video elements

## Test Organization Notes

**Regression Tests:**
- Located in dedicated test files when covering a specific bug
- Named descriptively: `file-store-firstitem-scroll-during-fetch.test.ts`, `file-store-slidemode-delete-reselect.test.ts`
- Prevent re-introduction of fixed issues

**Feature Tests:**
- Located in feature-scoped test file: `backend.test.ts`, `tag-store.test.ts`
- Use nested `describe()` blocks to organize related tests

**Integration Tests (partial):**
- `media-job.test.ts` spawns real ffmpeg when binary is available (skipped if not)
- Most tests use mocks and fixtures rather than full integration

---

*Testing analysis: 2026-06-24*
