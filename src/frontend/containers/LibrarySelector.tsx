import React, { useCallback, useEffect, useState } from 'react';
import { LibraryDTO } from 'src/api/library';
import { RendererMessenger } from 'src/ipc/renderer';
import { LibraryDiskPaths } from 'src/ipc/messages';
import { Button, ButtonGroup, IconSet } from 'widgets';
import { Checkbox } from 'widgets/checkbox';
import { Dialog } from 'widgets/popovers';

const MAX_LIBRARY_NAME_LENGTH = 50;

function formatDate(date: Date): string {
  try {
    return new Date(date).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Delete-confirmation dialog
// ---------------------------------------------------------------------------

interface DeleteDialogProps {
  /** The library being deleted (null = dialog is closed) */
  library: LibraryDTO | null;
  onCancel: () => void;
  onConfirmRegistryOnly: () => void;
  onConfirmWithFiles: () => void;
}

/**
 * Two-stage confirmation dialog for library deletion.
 *
 * Stage 1 — checkbox unchecked: one click of "Delete" removes the registry
 *   entry only (today's behavior).
 * Stage 1 — checkbox checked:  fetches the disk paths that will be removed
 *   and shows them, then requires a second click of "Delete files" to commit.
 * Stage 2 — shows absolute paths and requires a final "Delete files" click.
 *
 * Cancel / Escape always dismisses without action.
 */
const DeleteDialog = ({
  library,
  onCancel,
  onConfirmRegistryOnly,
  onConfirmWithFiles,
}: DeleteDialogProps) => {
  const [deleteFiles, setDeleteFiles] = useState(false);
  // stage: 'confirm-paths' appears after the user checks the box and clicks Delete once
  const [stage, setStage] = useState<'initial' | 'confirm-paths'>('initial');
  const [diskPaths, setDiskPaths] = useState<LibraryDiskPaths | null>(null);
  const [pathsLoading, setPathsLoading] = useState(false);
  const [pathsError, setPathsError] = useState<string | null>(null);

  // Reset internal state whenever the target library changes (dialog re-opens).
  // We depend on the full library object so ESLint's exhaustive-deps rule is satisfied;
  // the effect only runs when a different library is selected (i.e. library.id changes).
  useEffect(() => {
    if (library !== null) {
      setDeleteFiles(false);
      setStage('initial');
      setDiskPaths(null);
      setPathsError(null);
    }
  }, [library]);

  // Pre-fetch disk paths as soon as the checkbox is checked so we can show them
  // immediately when the user reaches stage 2.
  useEffect(() => {
    if (!deleteFiles || library === null) {
      return;
    }
    let cancelled = false;
    setPathsLoading(true);
    setPathsError(null);
    RendererMessenger.getLibraryDiskPaths(library.id)
      .then((paths) => {
        if (!cancelled) {
          setDiskPaths(paths);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setPathsError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setPathsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [deleteFiles, library]);

  const handlePrimaryAction = () => {
    if (!deleteFiles) {
      // Checkbox unchecked — registry-only removal, single click.
      onConfirmRegistryOnly();
    } else if (stage === 'initial') {
      // Checkbox checked, first click — advance to confirmation stage.
      setStage('confirm-paths');
    } else {
      // Checkbox checked, second click — commit the destructive removal.
      onConfirmWithFiles();
    }
  };

  const handleCancel = () => {
    setStage('initial');
    onCancel();
  };

  if (library === null) {
    return null;
  }

  const primaryLabel = !deleteFiles ? 'Delete' : stage === 'initial' ? 'Delete' : 'Delete files';

  return (
    <Dialog
      open
      title={`Delete library "${library.name}"?`}
      icon={IconSet.DELETE}
      describedby="delete-library-info"
      onCancel={handleCancel}
    >
      <div id="delete-library-info">
        {stage === 'initial' ? (
          <>
            <p>This will remove the library from the list.</p>
            <div className="delete-library-checkbox-row">
              <Checkbox checked={deleteFiles} onChange={setDeleteFiles}>
                Also permanently delete this library&apos;s database, backups, and thumbnail cache
                (default location only) from disk. This cannot be undone.
              </Checkbox>
            </div>
          </>
        ) : (
          <>
            <p>
              The following directories will be <strong>permanently deleted</strong>. This cannot be
              undone.
            </p>
            {pathsLoading && <p className="delete-library-paths-loading">Loading paths…</p>}
            {pathsError && (
              <p className="delete-library-paths-error">Could not resolve paths: {pathsError}</p>
            )}
            {diskPaths !== null && !pathsLoading && (
              <ul className="delete-library-paths-list">
                <li>
                  <strong>Library directory</strong> (database, backups):
                  <br />
                  <code>{diskPaths.libraryDir}</code>
                </li>
                <li>
                  <strong>Thumbnail cache</strong> (default location):
                  <br />
                  <code>{diskPaths.thumbnailDir}</code>
                </li>
              </ul>
            )}
          </>
        )}
      </div>
      <fieldset className="dialog-actions">
        {/* Cancel is first in DOM order so it receives focus when showModal() is called */}
        <Button styling="outlined" text="Cancel" onClick={handleCancel} />
        <Button
          styling="outlined"
          icon={IconSet.DELETE}
          text={primaryLabel}
          onClick={handlePrimaryAction}
          // Disable the destructive button while paths are loading in stage 2
          disabled={stage === 'confirm-paths' && pathsLoading}
        />
      </fieldset>
    </Dialog>
  );
};

// ---------------------------------------------------------------------------
// Error dialog shown when deleteLibraryAndFiles returns failedPaths
// ---------------------------------------------------------------------------

interface DeleteErrorDialogProps {
  libraryName: string | null;
  failedPaths: { path: string; error: string }[];
  onClose: () => void;
}

const DeleteErrorDialog = ({ libraryName, failedPaths, onClose }: DeleteErrorDialogProps) => {
  if (libraryName === null || failedPaths.length === 0) {
    return null;
  }
  return (
    <Dialog
      open
      title={`Could not fully delete "${libraryName}"`}
      icon={IconSet.WARNING}
      describedby="delete-error-info"
      onCancel={onClose}
    >
      <div id="delete-error-info">
        <p>
          Could not delete some files for library &quot;{libraryName}&quot;. The library has been
          kept in the list so you can retry after resolving the issue.
        </p>
        <ul className="delete-library-paths-list">
          {failedPaths.map(({ path: p, error }) => (
            <li key={p}>
              <code>{p}</code>
              <br />
              <span className="delete-library-paths-error">{error}</span>
            </li>
          ))}
        </ul>
      </div>
      <fieldset className="dialog-actions">
        <Button styling="filled" text="OK" onClick={onClose} />
      </fieldset>
    </Dialog>
  );
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/**
 * Library Selector screen rendered before the main app when multiple libraries
 * exist, or when the user explicitly requests to switch libraries.
 *
 * On selection the active library is persisted via IPC and the window reloads
 * with the new library ID in the URL query string.
 */
const LibrarySelector = () => {
  const [libraries, setLibraries] = useState<LibraryDTO[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  // Inline-create state
  const [isCreating, setIsCreating] = useState(false);
  const [createName, setCreateName] = useState('');

  // Inline-rename state: maps library ID to the draft name while editing
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  // Delete confirmation dialog state
  const [deletingLibrary, setDeletingLibrary] = useState<LibraryDTO | null>(null);

  // Delete error dialog state
  const [deleteErrorLibraryName, setDeleteErrorLibraryName] = useState<string | null>(null);
  const [deleteErrorPaths, setDeleteErrorPaths] = useState<{ path: string; error: string }[]>([]);

  useEffect(() => {
    Promise.all([RendererMessenger.getLibraries(), RendererMessenger.getActiveLibraryId()]).then(
      ([libs, id]) => {
        setLibraries(libs);
        setActiveId(id);
      },
    );
  }, []);

  const openLibrary = useCallback(async (id: string) => {
    await RendererMessenger.switchLibrary(id);
  }, []);

  const handleCreate = useCallback(async () => {
    const name = createName.trim();
    if (!name) {
      return;
    }
    const lib = await RendererMessenger.createLibrary(name);
    // Switch to the newly created library immediately
    await RendererMessenger.switchLibrary(lib.id);
  }, [createName]);

  const handleRenameCommit = useCallback(
    async (id: string) => {
      const name = renameDraft.trim();
      if (name && name.length <= MAX_LIBRARY_NAME_LENGTH) {
        await RendererMessenger.renameLibrary(id, name);
        setLibraries((prev) => prev.map((l) => (l.id === id ? { ...l, name } : l)));
      }
      setRenamingId(null);
    },
    [renameDraft],
  );

  // Open the delete confirmation dialog (after the last-library guard).
  const handleDelete = useCallback(
    (id: string) => {
      if (libraries.length <= 1) {
        window.alert('You cannot delete the last library.');
        return;
      }
      const lib = libraries.find((l) => l.id === id);
      if (lib) {
        setDeletingLibrary(lib);
      }
    },
    [libraries],
  );

  // Registry-only removal — checkbox was unchecked.
  const handleConfirmRegistryOnly = useCallback(async () => {
    if (deletingLibrary === null) {
      return;
    }
    const { id } = deletingLibrary;
    setDeletingLibrary(null);
    await RendererMessenger.deleteLibrary(id);
    setLibraries((prev) => prev.filter((l) => l.id !== id));
  }, [deletingLibrary]);

  // Destructive removal — checkbox was checked and the user confirmed paths.
  const handleConfirmWithFiles = useCallback(async () => {
    if (deletingLibrary === null) {
      return;
    }
    const { id, name } = deletingLibrary;
    setDeletingLibrary(null);

    const result = await RendererMessenger.deleteLibraryAndFiles(id);

    if (result.failedPaths.length === 0) {
      // All removals succeeded; remove from local state.
      setLibraries((prev) => prev.filter((l) => l.id !== id));
    } else {
      // Some paths could not be removed; the registry entry was NOT updated by the
      // handler (per the atomicity contract), so we keep the library in the list.
      setDeleteErrorLibraryName(name);
      setDeleteErrorPaths(result.failedPaths);
    }
  }, [deletingLibrary]);

  return (
    <div className="library-selector">
      <div className="library-selector-header">
        <h1>Choose a Library</h1>
        <p>Select the library you want to work with, or create a new one.</p>
      </div>

      <div className="library-selector-list">
        {libraries.map((lib) => (
          <div
            key={lib.id}
            className={`library-card${lib.id === activeId ? ' library-card--active' : ''}`}
          >
            <div className="library-card-info">
              {renamingId === lib.id ? (
                <input
                  autoFocus
                  className="library-card-rename-input"
                  value={renameDraft}
                  maxLength={MAX_LIBRARY_NAME_LENGTH}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleRenameCommit(lib.id);
                    } else if (e.key === 'Escape') {
                      setRenamingId(null);
                    }
                  }}
                  onBlur={() => handleRenameCommit(lib.id)}
                />
              ) : (
                <span className="library-card-name">{lib.name}</span>
              )}
              <span className="library-card-date">Last opened: {formatDate(lib.lastOpenedAt)}</span>
            </div>
            <div className="library-card-actions">
              <Button text="Open" styling="filled" onClick={() => openLibrary(lib.id)} />
              {renamingId !== lib.id && (
                <Button
                  text="Rename"
                  styling="outlined"
                  onClick={() => {
                    setRenamingId(lib.id);
                    setRenameDraft(lib.name);
                  }}
                />
              )}
              {lib.id !== activeId && (
                <Button
                  text="Delete"
                  styling="outlined"
                  icon={IconSet.DELETE}
                  onClick={() => handleDelete(lib.id)}
                />
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="library-selector-footer">
        {isCreating ? (
          <div className="library-create-form">
            <input
              autoFocus
              className="library-create-input"
              placeholder="Library name"
              value={createName}
              maxLength={MAX_LIBRARY_NAME_LENGTH}
              onChange={(e) => setCreateName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleCreate();
                } else if (e.key === 'Escape') {
                  setIsCreating(false);
                  setCreateName('');
                }
              }}
            />
            <ButtonGroup>
              <Button
                text="Create"
                styling="filled"
                onClick={handleCreate}
                disabled={!createName.trim()}
              />
              <Button
                text="Cancel"
                styling="outlined"
                onClick={() => {
                  setIsCreating(false);
                  setCreateName('');
                }}
              />
            </ButtonGroup>
          </div>
        ) : (
          <Button
            text="New Library"
            styling="outlined"
            icon={IconSet.ADD}
            onClick={() => setIsCreating(true)}
          />
        )}
      </div>

      {/* Delete confirmation dialog (portal-rendered by the Dialog widget) */}
      <DeleteDialog
        library={deletingLibrary}
        onCancel={() => setDeletingLibrary(null)}
        onConfirmRegistryOnly={handleConfirmRegistryOnly}
        onConfirmWithFiles={handleConfirmWithFiles}
      />

      {/* Error dialog when on-disk removal fails */}
      <DeleteErrorDialog
        libraryName={deleteErrorLibraryName}
        failedPaths={deleteErrorPaths}
        onClose={() => {
          setDeleteErrorLibraryName(null);
          setDeleteErrorPaths([]);
        }}
      />
    </div>
  );
};

export default LibrarySelector;
