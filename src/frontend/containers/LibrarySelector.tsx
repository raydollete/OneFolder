import React, { useCallback, useEffect, useState } from 'react';
import { LibraryDTO } from 'src/api/library';
import { RendererMessenger } from 'src/ipc/renderer';
import { Button, ButtonGroup, IconSet } from 'widgets';

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

  const handleDelete = useCallback(
    async (id: string, name: string) => {
      if (libraries.length <= 1) {
        window.alert('You cannot delete the last library.');
        return;
      }
      if (
        !window.confirm(
          `Delete library "${name}"?\n\nThis will remove it from the list but will not delete the database or thumbnails on disk.`,
        )
      ) {
        return;
      }
      await RendererMessenger.deleteLibrary(id);
      setLibraries((prev) => prev.filter((l) => l.id !== id));
    },
    [libraries.length],
  );

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
                  onClick={() => handleDelete(lib.id, lib.name)}
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
    </div>
  );
};

export default LibrarySelector;
