/**
 * @jest-environment jsdom
 *
 * Component tests for FileTagEditor multi-select tag fill behavior
 * (openspec change: fix-multi-select-tag-fill).
 *
 * Renders the REAL <FileTagEditor> into jsdom with a mock uiStore/tagStore and
 * fake ClientFiles whose addTag/removeTag mirror the real (idempotent) semantics.
 * Only the presentational TagOption / widgets are stubbed — the decision under
 * test (`selected = all-have-tag` and the fill-then-remove `toggleSelection`)
 * runs unmodified from the component.
 *
 * Spec scenarios exercised:
 *  - none have T   -> entering T adds it to all
 *  - some have T   -> entering T fills it into the rest, nobody loses it
 *  - all have T    -> entering T removes it from all
 *  - single file   -> plain toggle
 */

import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { configure, observable, runInAction } from 'mobx';

configure({ enforceActions: 'never' });
(global as any).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Widget / presentational stubs
// ---------------------------------------------------------------------------

// TagButton is the toolbar trigger; render nothing so we don't need IconSet SVGs.
jest.mock('../src/frontend/containers/AppToolbar/TagButton', () => ({
  TagButton: () => null,
}));

// IconSet from 'widgets' / 'widgets/icons' — proxy so any icon access yields null.
jest.mock('widgets', () => ({
  IconSet: new Proxy({}, { get: () => null }),
  // Tag chip used by TagSummary — render its label so we can read the summary.
  Tag: ({ text, onRemove }: any) => (
    <button data-testid={`summary-${text}`} onClick={onRemove}>
      {text}
    </button>
  ),
  Grid: React.forwardRef(({ children }: any, ref: any) => <div ref={ref}>{children}</div>),
}), { virtual: true });

jest.mock('widgets/icons', () => ({ IconSet: new Proxy({}, { get: () => null }) }), {
  virtual: true,
});

jest.mock('widgets/combobox/Grid', () => ({
  Grid: ({ children }: any) => <div>{children}</div>,
  Row: ({ value, onClick }: any) => (
    <div data-testid={`row-${value}`} onClick={onClick}>
      {value}
    </div>
  ),
  RowSeparator: () => null,
  useGridFocus: () => ['', () => undefined],
}), { virtual: true });

// TagOption: keep it thin but drive the REAL selected flag + REAL toggleSelection.
// data-selected exposes the component's derived "all files have this tag" state.
jest.mock('../src/frontend/components/TagSelector', () => ({
  TagOption: ({ id, tag, selected, toggleSelection }: any) => (
    <div
      data-testid={`opt-${tag.id}`}
      data-selected={String(Boolean(selected))}
      onClick={() => toggleSelection(selected ?? false, tag)}
    >
      {tag.name}
    </div>
  ),
}));

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeTag(id: string, name: string) {
  return observable({ id, name, viewColor: '#fff' });
}

// A ClientFile-ish object: observable tag set + idempotent add/remove mirroring File.ts.
function makeFile(id: string, tags: any[] = []) {
  const file: any = observable({
    id,
    tags: observable.set(tags),
    addTag(tag: any) {
      if (!file.tags.has(tag)) {
        file.tags.add(tag);
      }
    },
    removeTag(tag: any) {
      file.tags.delete(tag);
    },
  });
  return file;
}

async function renderEditor(files: any[], tagList: any[]) {
  const fileSelection = observable.set<any>(files);
  const uiStore: any = observable({
    fileSelection,
    isToolbarTagPopoverOpen: true,
    toggleToolbarTagPopover() {
      uiStore.isToolbarTagPopoverOpen = !uiStore.isToolbarTagPopoverOpen;
    },
    closeToolbarTagPopover() {
      uiStore.isToolbarTagPopoverOpen = false;
    },
  });
  const tagStore: any = observable({ tagList });
  const store: any = { uiStore, tagStore };

  const StoreProvider = (await import('../src/frontend/contexts/StoreContext')).default;
  const FileTagEditor = (await import('../src/frontend/containers/AppToolbar/FileTagEditor'))
    .default;

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  await act(async () => {
    root.render(
      React.createElement(StoreProvider, { value: store }, React.createElement(FileTagEditor)),
    );
  });

  return { container, root, uiStore, tagStore };
}

function clickTag(container: HTMLElement, tagId: string) {
  const opt = container.querySelector(`[data-testid="opt-${tagId}"]`) as HTMLElement;
  if (!opt) {
    throw new Error(`tag option opt-${tagId} not rendered`);
  }
  return opt;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FileTagEditor multi-select tag fill', () => {
  it('none have the tag -> entering it adds to all', async () => {
    const t = makeTag('t1', 'Beach');
    const f1 = makeFile('f1');
    const f2 = makeFile('f2');
    const { container, root } = await renderEditor([f1, f2], [t]);

    // Nobody has it -> option shows unselected.
    expect(clickTag(container, 't1').getAttribute('data-selected')).toBe('false');

    await act(async () => {
      clickTag(container, 't1').click();
    });

    expect(f1.tags.has(t)).toBe(true);
    expect(f2.tags.has(t)).toBe(true);

    await act(async () => root.unmount());
  });

  it('some (not all) have the tag -> entering it fills the rest, nobody loses it', async () => {
    const t = makeTag('t1', 'Beach');
    const f1 = makeFile('f1', [t]); // already has it
    const f2 = makeFile('f2'); // missing it
    const { container, root } = await renderEditor([f1, f2], [t]);

    // Partial coverage must read as NOT selected (so the click fills instead of clears).
    expect(clickTag(container, 't1').getAttribute('data-selected')).toBe('false');

    await act(async () => {
      clickTag(container, 't1').click();
    });

    // Fill: f2 gains the tag, f1 keeps it — this is the core bug fix.
    expect(f1.tags.has(t)).toBe(true);
    expect(f2.tags.has(t)).toBe(true);

    await act(async () => root.unmount());
  });

  it('all have the tag -> entering it removes from all', async () => {
    const t = makeTag('t1', 'Beach');
    const f1 = makeFile('f1', [t]);
    const f2 = makeFile('f2', [t]);
    const { container, root } = await renderEditor([f1, f2], [t]);

    // Full coverage reads as selected.
    expect(clickTag(container, 't1').getAttribute('data-selected')).toBe('true');

    await act(async () => {
      clickTag(container, 't1').click();
    });

    expect(f1.tags.has(t)).toBe(false);
    expect(f2.tags.has(t)).toBe(false);

    await act(async () => root.unmount());
  });

  it('single file -> plain toggle (add then remove)', async () => {
    const t = makeTag('t1', 'Beach');
    const f1 = makeFile('f1');
    const { container, root } = await renderEditor([f1], [t]);

    await act(async () => {
      clickTag(container, 't1').click();
    });
    expect(f1.tags.has(t)).toBe(true);

    await act(async () => {
      clickTag(container, 't1').click();
    });
    expect(f1.tags.has(t)).toBe(false);

    await act(async () => root.unmount());
  });
});
