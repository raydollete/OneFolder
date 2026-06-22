import { observer } from 'mobx-react-lite';
import React, { useState } from 'react';

import { IconSet } from 'widgets';
import { Collapse } from 'src/frontend/components/Collapse';
import { useStore } from 'src/frontend/contexts/StoreContext';
import { useAction } from 'src/frontend/hooks/mobx';
import { useTrashFile } from 'src/frontend/components/RemovalAlert';
import { ClientFile } from 'src/frontend/entities/File';
import { QueueItem } from 'src/frontend/stores/MediaQueueStore';

// ---------------------------------------------------------------------------
// Per-row sub-component: isolates useState for error-reveal so only the
// affected row re-renders on toggle.
// ---------------------------------------------------------------------------

interface QueueRowProps {
  item: QueueItem;
  trashFile: (file: ClientFile) => Promise<{ ok: boolean; isPermanent: boolean }>;
}

const QueueRow = observer(({ item, trashFile }: QueueRowProps) => {
  const { mediaQueueStore } = useStore();
  const [errorRevealed, setErrorRevealed] = useState(false);

  const filenameCell = (
    <td className="media-queue__col-filename">
      <button
        className="btn-minimal media-queue__filename-btn"
        type="button"
        onClick={() => mediaQueueStore.focusFileInViewer(item.source)}
        title={item.source.absolutePath}
      >
        {item.source.name}
      </button>
    </td>
  );

  const operationCell = <td className="media-queue__col-operation">{item.label}</td>;

  let statusCell: React.ReactNode;
  let actionsCell: React.ReactNode;

  if (item.status === 'pending') {
    statusCell = <td className="media-queue__col-status media-queue__status--queued">Queued</td>;
    actionsCell = (
      <td className="media-queue__col-actions">
        <button
          className="btn-minimal"
          type="button"
          onClick={() => mediaQueueStore.cancel(item.id)}
        >
          Cancel
        </button>
      </td>
    );
  } else if (item.status === 'running') {
    statusCell = (
      <td className="media-queue__col-status media-queue__status--running">
        <div className="media-queue__running-status">
          <div className="loading-spinner media-queue__spinner" />
          <span>Processing… {item.percent !== null ? item.percent : '…'}%</span>
        </div>
      </td>
    );
    actionsCell = (
      <td className="media-queue__col-actions">
        <button
          className="btn-minimal"
          type="button"
          onClick={() => mediaQueueStore.cancel(item.id)}
        >
          Cancel
        </button>
      </td>
    );
  } else if (item.status === 'completed') {
    statusCell = (
      <td className="media-queue__col-status media-queue__status--completed">
        <button
          className="btn-minimal media-queue__view-completed-btn"
          type="button"
          onClick={() => {
            if (item.output !== null) {
              mediaQueueStore.focusFileInViewer(item.output);
            }
          }}
          disabled={item.output === null}
        >
          View Completed
        </button>
      </td>
    );
    actionsCell = (
      <td className="media-queue__col-actions">
        <button
          className="btn-minimal"
          type="button"
          onClick={() => mediaQueueStore.keepNew(item, trashFile)}
        >
          Keep New
        </button>
        <button
          className="btn-minimal"
          type="button"
          onClick={() => mediaQueueStore.keepOriginal(item, trashFile)}
        >
          Keep Original
        </button>
        <button
          className="btn-minimal"
          type="button"
          onClick={() => mediaQueueStore.keepBoth(item)}
        >
          Keep Both
        </button>
      </td>
    );
  } else {
    // failed
    statusCell = (
      <td className="media-queue__col-status media-queue__status--failed">
        <button
          className="btn-minimal media-queue__failed-btn"
          type="button"
          onClick={() => setErrorRevealed((v) => !v)}
          title="Click to toggle error detail"
        >
          Failed
        </button>
        {errorRevealed && item.errorMessage !== null && (
          <pre className="media-queue__error-detail">{item.errorMessage}</pre>
        )}
      </td>
    );
    actionsCell = (
      <td className="media-queue__col-actions">
        <button
          className="btn-minimal"
          type="button"
          onClick={() => mediaQueueStore.retry(item.id)}
        >
          Retry
        </button>
        {/* Dismiss splices the failed row. keepBoth is a plain row-splice that
            works for any status; cancel() is a no-op on failed rows so we
            cannot use it here. */}
        <button
          className="btn-minimal"
          type="button"
          onClick={() => mediaQueueStore.keepBoth(item)}
        >
          Dismiss
        </button>
      </td>
    );
  }

  return (
    <tr className={`media-queue__row media-queue__row--${item.status}`}>
      {filenameCell}
      {operationCell}
      {statusCell}
      {actionsCell}
    </tr>
  );
});

// ---------------------------------------------------------------------------
// Main drawer component
// ---------------------------------------------------------------------------

/**
 * Persistent collapsible bottom drawer that renders all media-job queue items
 * (oldest on top) as a four-column table: Original filename | Operation |
 * Status | Actions.
 *
 * The header bar is always visible once there are items; the body animates
 * open/closed via Collapse. Renders nothing when the queue is empty.
 */
const MediaQueueDrawer = observer(() => {
  const { mediaQueueStore } = useStore();

  // useTrashFile is a React hook — must be called at the component level and
  // passed down to the store's keepNew/keepOriginal actions (INV-035 design).
  const trashFile = useTrashFile();

  // Wrap the toggle in an action so MobX strict-mode does not complain about
  // mutating an observable outside a tracked action context.
  // Must be called before any early return (Rules of Hooks).
  const handleToggle = useAction(() => {
    mediaQueueStore.isDrawerOpen = !mediaQueueStore.isDrawerOpen;
  });

  if (!mediaQueueStore.hasItems) {
    return null;
  }

  const { pendingCount, runningItem, completedCount, isDrawerOpen, items } = mediaQueueStore;

  const summary = `${pendingCount} queued · ${
    runningItem !== undefined ? '1 processing' : '0 processing'
  } · ${completedCount} done`;

  return (
    <div className="media-queue">
      {/* Always-visible header bar */}
      <div className="media-queue__header">
        <span className="media-queue__title">Media queue</span>
        <span className="media-queue__summary">{summary}</span>
        <button
          className="btn-icon media-queue__toggle"
          type="button"
          aria-expanded={isDrawerOpen}
          aria-label={isDrawerOpen ? 'Collapse media queue' : 'Expand media queue'}
          onClick={handleToggle}
        >
          {isDrawerOpen ? IconSet.ARROW_DOWN : IconSet.ARROW_UP}
        </button>
      </div>

      {/* Collapsible body */}
      <Collapse open={isDrawerOpen}>
        <div className="media-queue__body">
          <table className="media-queue__table">
            <thead>
              <tr>
                <th className="media-queue__col-filename">Original filename</th>
                <th className="media-queue__col-operation">Operation</th>
                <th className="media-queue__col-status">Status</th>
                <th className="media-queue__col-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <QueueRow key={item.id} item={item} trashFile={trashFile} />
              ))}
            </tbody>
          </table>
        </div>
      </Collapse>
    </div>
  );
});

export default MediaQueueDrawer;
