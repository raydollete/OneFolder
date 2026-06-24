# Coding Conventions

**Analysis Date:** 2026-06-24

## TypeScript Configuration

**Strict Mode:** Enabled globally via `tsconfig.json`
- `strict: true` — all strict type checking enabled
- `isolatedModules: true` — enables per-file compilation safety
- `useUnknownInCatchVariables: false` — allows untyped catch variables (pragmatic for error handling)
- Target: ES2022
- Module resolution: node with path aliases (`baseUrl: "./"`)

**Path Aliases:**
- `widgets/*` → `widgets/` directory
- `src/*` → `src/` directory
- `resources/*` → `resources/` directory
- `common/*` — shared utilities (ExifTool, filesystem, config)

## Naming Patterns

**Files:**
- Store files: `[CapitalizedName]Store.ts` (e.g., `FileStore.ts`, `TagStore.ts`, `LocationStore.ts`)
- React components: `[CapitalizedName].tsx` (e.g., `FileTag.tsx`, `ImageMap.tsx`)
- Entity classes: `[CapitalizedName].ts` (e.g., `File.ts`, `Tag.ts`, `Location.ts`)
- Test files: `*.test.ts` or `*.test.tsx` (co-located in `tests/` directory)
- Utilities: lowercase with hyphens (e.g., `fs.ts`, `promise.ts`, `timeout.ts`)

**Classes and Interfaces:**
- PascalCase for all class and interface names
- DTO interfaces: `[EntityName]DTO` (e.g., `FileDTO`, `TagDTO`, `LocationDTO`, `LibraryDTO`)
- Client-side entity classes: `Client[EntityName]` (e.g., `ClientFile`, `ClientTag`, `ClientLocation`)
- Store classes: `[EntityName]Store` (e.g., `FileStore`, `TagStore`)

**Functions and Variables:**
- camelCase for functions and variables
- SCREAMING_SNAKE_CASE for constants (e.g., `ROOT_TAG_ID`, `IMG_EXTENSIONS`, `FILE_STORAGE_KEY`)
- Private fields: prefixed with `#` (e.g., `#tags: Table<TagDTO, ID>`)
- Unused parameters: prefixed with `_` (e.g., `_error`, `_unused`)

## Code Style

**Formatting:**
- Tool: Prettier
- Single quotes for strings: `'text'`
- Double quotes for JSX: `"text"` in JSX attributes
- Trailing commas: always (`"trailingComma": "all"`)
- Tab width: 2 spaces
- Print width: 100 characters
- Arrow functions: always parentheses (`"arrowParens": "always"`)

**Linting:**
- Tool: ESLint with TypeScript support
- Rules enforced:
  - `@typescript-eslint/explicit-module-boundary-types: error` — for backend/frontend stores and entities (see `src/backend/*.ts`, `src/frontend/entities/*.ts`, `src/frontend/stores/*.ts`)
  - `@typescript-eslint/no-unused-vars: error` — with `argsIgnorePattern: ^_` to allow unused parameters prefixed with `_`
  - `react-hooks/rules-of-hooks: error` — strict React Hooks compliance
  - `react-hooks/exhaustive-deps: warn` — warns on missing dependencies (not an error)
  - `curly: error` — blocks elided braces in conditionals
  - `no-extra-boolean-cast: error` — prevents unnecessary boolean casts
  - `@typescript-eslint/prefer-string-starts-ends-with: error` — use `.startsWith()` over `.indexOf()`
  - Quotes: single (backticks allowed in template strings)

**Auto-fix:**
```bash
yarn lint  # Runs ESLint with --fix flag
```

## Import Organization

**Order (enforced by convention, not linter):**
1. External packages (React, mobx, Node builtins)
2. Relative imports from parent directories (`../`)
3. Alias imports (`common/`, `src/`, `widgets/`)
4. Styles (SCSS, CSS)

**Example:**
```typescript
import React, { useCallback } from 'react';
import { observer } from 'mobx-react-lite';

import fse from 'fs-extra';
import { DataStorage } from '../../api/data-storage';
import { ClientFile } from '../entities/File';
import { useStore } from '../contexts/StoreContext';

import styles from './Component.module.scss';
```

**Path Aliases in Frontend:**
Frontend code must import platform capabilities from `src/frontend/platform` — never directly from Node modules:
- DO: `import platform from 'src/frontend/platform'` → provides `path`, `fs`, `shell`, `RendererMessenger`
- DON'T: `import * as fs from 'fs-extra'` or `import { ipcRenderer } from 'electron'`

This invariant enforces a build-time seam that allows the web bundle to substitute stubs. Violation breaks web compilation.

## React Component Patterns

**Observer Pattern (MobX):**
All components that read MobX observables MUST be wrapped with `@observer` (function decorator):
```typescript
import { observer } from 'mobx-react-lite';

const MyComponent = observer(({ file }: Props) => {
  // Component body — re-renders when observables change
  return <div>{file.name}</div>;
});
```

**Hooks Usage:**
- Use `const { store } = useStore()` to access global MobX stores
- Use `useCallback` for event handlers to preserve referential equality
- ESLint enforces React Hooks rules-of-hooks and exhaustive-deps

**Example Component:**
```typescript
interface IFileTagProp {
  file: ClientFile;
}

const FileTags = observer(({ file }: IFileTagProp) => {
  const { tagStore, uiStore } = useStore();

  const handleTagClick = useCallback(
    (tag: ClientTag) => {
      uiStore.addSearchCriteria(new ClientTagSearchCriteria('tags', tag.id));
    },
    [uiStore],
  );

  return <TagSelector onSelect={handleTagClick} />;
});
```

## State Management (MobX)

**Store Structure:**
All stores inherit a standard pattern:
```typescript
class FileStore {
  private readonly backend: DataStorage;
  private readonly rootStore: RootStore;

  @observable fileList = observable<ClientFile>([]);
  @observable orderDirection: OrderDirection = OrderDirection.Desc;

  constructor(backend: DataStorage, rootStore: RootStore) {
    this.backend = backend;
    this.rootStore = rootStore;
    makeObservable(this);  // Enable MobX decorators
  }

  @action refetch(): void { /* ... */ }
  @computed get isEmpty(): boolean { /* ... */ }
}
```

**Key Patterns:**
- `@observable` — marks fields that trigger re-renders when modified
- `@action` — wraps mutations to batch observable changes
- `@action.bound` — action that preserves `this` binding
- `@computed` — lazy-evaluated derived values (only recomputed when dependencies change)
- `makeObservable(this)` — enables all decorators at runtime (required in constructor)
- `reaction()` — side effects that respond to observable changes
- `runInAction()` — runs mutations outside async operations

**Entity Classes:**
Client-side entities wrap backend DTOs with MobX reactivity:
```typescript
export class ClientFile {
  @observable annotations: string;
  @observable thumbnailPath: string = '';
  @observable isBroken?: boolean;

  private saveHandler: IReactionDisposer;

  constructor(store: FileStore, fileProps: FileDTO, exifTool: ExifIO) {
    this.store = store;
    makeObservable(this);
    // Set up auto-save reaction
    this.saveHandler = reaction(/* ... */);
  }
}
```

## DTO Pattern (API Contracts)

**Data Transfer Objects** define all API contracts between backend and frontend. Every entity has a corresponding DTO:

**File Entity:**
- DTO: `FileDTO` (`src/api/file.ts`)
- Client class: `ClientFile` (`src/frontend/entities/File.ts`)
- Store: `FileStore` (`src/frontend/stores/FileStore.ts`)

**Tag Entity:**
- DTO: `TagDTO` (`src/api/tag.ts`)
- Client class: `ClientTag` (`src/frontend/entities/Tag.ts`)
- Store: `TagStore` (`src/frontend/stores/TagStore.ts`)

**Location Entity:**
- DTO: `LocationDTO` (`src/api/location.ts`)
- Client class: `ClientLocation` (`src/frontend/entities/Location.ts`)
- Store: `LocationStore` (`src/frontend/stores/LocationStore.ts`)

**Pattern:**
```typescript
// DTO in src/api/file.ts — pure data structure
export type FileDTO = {
  id: ID;
  name: string;
  tags: ID[];
  // ... other properties
};

// Client entity wraps DTO with MobX reactivity
export class ClientFile {
  readonly id: ID;
  @observable annotations: string;

  constructor(store: FileStore, fileProps: FileDTO, exifTool: ExifIO) {
    this.id = fileProps.id;
    // ... initialize other fields
    makeObservable(this);
  }

  async addTag(tag: ClientTag): Promise<void> {
    this.tags.add(tag);
    await this.saveMetadata();
  }
}

// Store aggregates client entities
class FileStore {
  readonly fileList = observable<ClientFile>([]);

  @action async refetch(): Promise<void> {
    const dtos = await this.backend.fetchFiles();
    runInAction(() => {
      this.fileList.replace(dtos.map(dto => new ClientFile(this, dto)));
    });
  }
}
```

## Error Handling

**Strategy:** Explicit error propagation (no silent swallows)

**Patterns:**
- `try/catch` for async operations; errors are logged or displayed to user
- `console.error()` for unexpected failures
- `AppToaster` for user-facing error notifications
- Async operations should explicitly handle failure states rather than returning null/undefined

**Example:**
```typescript
async create(parent: ClientTag, tagName: string): Promise<ClientTag> {
  try {
    const id = generateId();
    const tag = new ClientTag(this, id, tagName, new Date(), '', false);
    this.tagGraph.set(tag.id, tag);
    await this.backend.createTag(tag.serialize());
    return tag;
  } catch (err) {
    console.error('Failed to create tag:', err);
    AppToaster.show({ message: 'Failed to create tag', intent: 'danger' });
    throw err;  // Re-throw for caller to handle
  }
}
```

## Logging

**Framework:** `console` (native) — no external logging library

**Conventions:**
- `console.info()` — high-level operation start/success (e.g., "IndexedDB: Initializing database")
- `console.debug()` — detailed intermediate steps (e.g., "Filtering files...")
- `console.log()` — warnings/informational (e.g., "String operator not allowed")
- `console.error()` — exceptions and failures

**Pattern in Stores:**
```typescript
async fetchTags(): Promise<TagDTO[]> {
  console.info('IndexedDB: Fetching tags...');
  return this.#tags.toArray();
}

async createFilesFromPath(path: string, files: FileDTO[]): Promise<void> {
  console.info('IndexedDB: Creating files...', path, files);
  const existingFilePaths = new Set(
    await this.#files.where('absolutePath').startsWith(path).keys(),
  );
  console.debug('Filtering files...');
  // ... work
  console.debug('Done!');
}
```

## Comments

**When to Comment:**
- Complex algorithms or non-obvious logic
- Workarounds for known issues or bugs (reference issue numbers: `INV-NNN`, `TASK-NNN`)
- JSDoc for public API methods

**JSDoc/TSDoc Usage:**
- Document parameter types and return types (TypeScript often infers, so optional)
- Document side effects and mutation behavior
- Example:

```typescript
/**
 * Removes the tag from all files that have it, and deletes the tag itself.
 *
 * @param tags — Array of tag IDs to remove
 * @throws Error if tag does not exist in graph
 */
async removeTags(tags: ID[]): Promise<void> {
  // Implementation...
}
```

**Development Comments:**
- Mark regressions and design decisions with issue references: `// INV-007 regression`
- Comment explaining WHY, not WHAT (code shows what, comments explain intent)

## Module Design

**Private Fields:**
- Use `#` prefix for all private fields (e.g., `#backend`, `#tags`)
- Makes privacy explicit and prevents accidental external access

**Exports:**
- Named exports for classes, types, and functions
- Default export discouraged (use named imports for clarity)

**Barrel Files:**
- Not used in this codebase — import directly from source file paths

**Public API:**
- Store getters are public; mutation methods are @action (e.g., `.get(id)` vs `.create(...)`)
- Backend interfaces (`DataStorage`) define API contracts for all stores
- Frontend code accesses data exclusively through store methods, never by mutating directly

## Special Patterns

**Web Platform Seam:**
Frontend must use `src/frontend/platform` which provides:
- `platform.path` — path operations (forward-slash normalized)
- `platform.fs` — filesystem stubs (empty in web, full in Electron)
- `platform.shell` — shell operations (empty in web)
- `platform.RendererMessenger` — IPC (stubs in web)

The seam is selected at webpack build time via `moduleNameMapper` alias.

**Web Workers:**
Heavy processing (file watching, thumbnail generation) runs in Web Workers:
- `common/worker.ts` — base worker setup
- Workers communicate via `postMessage` and `onmessage`
- Used for file indexing and image processing

**TypeScript Exhaustiveness Checks:**
```typescript
// Pattern: catch unhandled case in switch/union
const handleOperator = (op: 'add' | 'remove'): void => {
  switch (op) {
    case 'add': /* ... */ break;
    case 'remove': /* ... */ break;
    default:
      const _exhaustiveCheck: never = op;  // Compile error if cases not exhausted
  }
};
```

---

*Convention analysis: 2026-06-24*
