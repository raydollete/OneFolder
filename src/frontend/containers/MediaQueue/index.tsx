import { observer } from 'mobx-react-lite';
import React, { useState } from 'react';

import { IconSet } from 'widgets';
import { Collapse } from 'src/frontend/components/Collapse';
import { useStore } from 'src/frontend/contexts/StoreContext';
import { useAction } from 'src/frontend/hooks/mobx';
import { useTrashFile } from 'src/frontend/components/RemovalAlert';
import { ClientFile } from 'src/frontend/entities/File';
import { QueueItem, ResolutionKind } from 'src/frontend/stores/MediaQueueStore';

// Human-readable labels for the resolved-row status cell.
const RESOLUTION_LABELS: Record<ResolutionKind, string> = {
  'kept-new': 'Kept new',
  'kept-original': 'Kept original',
  'kept-both': 'Kept both',
  dismissed: 'Dismissed',
};

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

  // After "Keep New" the original source file is trashed — show its name as plain
  // text rather than a dead link (INV-036). All other states keep the link.
  const sourceTrashed = item.status === 'resolved' && item.resolution === 'kept-new';
  const filenameCell = (
    <td className="media-queue__col-filename">
      {sourceTrashed ? (
        <span className="media-queue__filename-text" title={item.source.absolutePath}>
          {item.source.name}
        </span>
      ) : (
        <button
          className="btn-minimal media-queue__filename-btn"
          type="button"
          onClick={() => mediaQueueStore.focusFileInViewer(item.source)}
          title={item.source.absolutePath}
        >
          {item.source.name}
        </button>
      )}
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
  } else if (item.status === 'failed') {
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
        {/* Dismiss resolves the failed row as "Dismissed" so it sinks to the
            bottom as history instead of being removed (INV-036). */}
        <button className="btn-minimal" type="button" onClick={() => mediaQueueStore.dismiss(item)}>
          Dismiss
        </button>
      </td>
    );
  } else {
    // resolved — a settled job kept as history at the bottom of the list. The
    // status cell shows the resolution label; when the NEW file still exists
    // (Keep New / Keep Both) the label is a link that opens it in the viewer
    // (INV-036). There are no row actions.
    const label = item.resolution !== null ? RESOLUTION_LABELS[item.resolution] : '';
    const outputKept = item.resolution === 'kept-new' || item.resolution === 'kept-both';
    statusCell = (
      <td className="media-queue__col-status media-queue__status--resolved">
        {outputKept && item.output !== null ? (
          <button
            className="btn-minimal media-queue__resolved-link"
            type="button"
            onClick={() => {
              if (item.output !== null) {
                mediaQueueStore.focusFileInViewer(item.output);
              }
            }}
          >
            {label}
          </button>
        ) : (
          label
        )}
      </td>
    );
    actionsCell = <td className="media-queue__col-actions" />;
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
 * as a four-column table: Original filename | Operation | Status | Actions.
 *
 * The drawer is ALWAYS present at the bottom of the window (default collapsed),
 * even when the queue is empty (INV-036) — the header bar shows live counts and
 * toggles the body open/closed via Collapse. Unresolved rows are listed oldest
 * on top; resolved (kept/dismissed) rows sink to the bottom as history until the
 * user clicks "Clear resolved".
 */
const MediaQueueDrawer = observer(() => {
  const { mediaQueueStore } = useStore();

  // useTrashFile is a React hook — must be called at the component level and
  // passed down to the store's keepNew/keepOriginal actions (INV-035 design).
  const trashFile = useTrashFile();

  // Wrap the toggle in an action so MobX strict-mode does not complain about
  // mutating an observable outside a tracked action context.
  const handleToggle = useAction(() => {
    mediaQueueStore.isDrawerOpen = !mediaQueueStore.isDrawerOpen;
  });

  const { pendingCount, runningItem, completedCount, resolvedCount, isDrawerOpen, items } =
    mediaQueueStore;

  const summary = `${pendingCount} queued · ${
    runningItem !== undefined ? '1 processing' : '0 processing'
  } · ${completedCount} done · ${resolvedCount} resolved`;

  // Render-time ordering (INV-036): two segments — unresolved rows on top,
  // resolved history below. WITHIN each segment rows are NEWEST-first by
  // requestedAt, so the most recent activity (processing / just-completed, and
  // most-recently-resolved) is at the top of its segment. The underlying items
  // array keeps insertion order, so FIFO processing is unaffected; only the view
  // reorders.
  const sortedItems = [...items].sort((a, b) => {
    const aResolved = a.status === 'resolved' ? 1 : 0;
    const bResolved = b.status === 'resolved' ? 1 : 0;
    if (aResolved !== bResolved) {
      return aResolved - bResolved;
    }
    return b.requestedAt - a.requestedAt;
  });

  return (
    <div className="media-queue">
      {/* Always-visible header bar */}
      <div className="media-queue__header">
        <span className="media-queue__title">Media queue</span>
        <span className="media-queue__summary">{summary}</span>
        {resolvedCount > 0 && (
          <button
            className="btn-minimal media-queue__clear-resolved"
            type="button"
            onClick={() => mediaQueueStore.clearResolved()}
          >
            Clear resolved
          </button>
        )}
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
          {items.length === 0 ? (
            <div className="media-queue__empty">No media jobs yet</div>
          ) : (
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
                {sortedItems.map((item) => (
                  <QueueRow key={item.id} item={item} trashFile={trashFile} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Collapse>
    </div>
  );
});

export default MediaQueueDrawer;
