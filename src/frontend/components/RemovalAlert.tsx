import { action } from 'mobx';
import { observer } from 'mobx-react-lite';
import React from 'react';

import { IconSet, Tag } from 'widgets';
import { Alert, DialogButton } from 'widgets/popovers';
import { RendererMessenger } from '../../ipc/renderer';
import { useStore } from '../contexts/StoreContext';
import { ClientLocation, ClientSubLocation } from '../entities/Location';
import { ClientFileSearchItem } from '../entities/SearchItem';
import { ClientTag } from '../entities/Tag';
import { AppToaster } from './Toaster';

interface IRemovalProps<T> {
  object: T;
  onClose: () => void;
}

export const LocationRemoval = (props: IRemovalProps<ClientLocation>) => (
  <RemovalAlert
    open
    title={`Are you sure you want to delete the location "${props.object.name}"?`}
    information="This will permanently remove the location and all data linked to its images in OneFolder."
    onCancel={props.onClose}
    onConfirm={() => {
      props.onClose();
      props.object.delete();
    }}
  />
);

export const SubLocationExclusion = (props: IRemovalProps<ClientSubLocation>) => {
  return (
    <Alert
      open
      title={`Are you sure you want to exclude the directory "${props.object.name}"?`}
      icon={IconSet.WARNING}
      type="warning"
      primaryButtonText="Exclude"
      defaultButton={DialogButton.PrimaryButton}
      onClick={(button) => {
        if (button !== DialogButton.CloseButton) {
          props.object.toggleExcluded();
        }
        props.onClose();
      }}
    >
      <p>Any tags saved on images in that directory will be lost.</p>
    </Alert>
  );
};

export const TagRemoval = observer((props: IRemovalProps<ClientTag>) => {
  const { uiStore } = useStore();
  const { object } = props;
  const tagsToRemove = Array.from(
    object.isSelected ? uiStore.tagSelection : object.getSubTree(),
    (t) => <Tag key={t.id} text={t.name} color={t.viewColor} />,
  );

  const text = `Are you sure you want to delete the tag "${object.name}"?`;

  return (
    <RemovalAlert
      open
      title={text}
      information="Deleting tags or collections will permanently remove them from OneFolder."
      body={
        tagsToRemove.length > 0 && (
          <div id="tag-remove-overview">
            <p>Selected Tags</p>
            {tagsToRemove}
          </div>
        )
      }
      onCancel={props.onClose}
      onConfirm={() => {
        props.onClose();
        object.isSelected ? uiStore.removeSelectedTags() : props.object.delete();
      }}
    />
  );
});

export const FileRemoval = observer(() => {
  const { fileStore, uiStore, mediaReleaseCoordinator } = useStore();
  const selection = uiStore.fileSelection;

  const handleConfirm = action(async () => {
    uiStore.closeToolbarFileRemover();
    const files = [];
    for (const file of selection) {
      if (file.isBroken === true) {
        files.push(file);
      }
    }
    // Release any video handles even for broken/missing files — defends against
    // the rare race where a file is marked broken but still held open. (INV-008)
    const paths = files.map((f) => f.absolutePath);
    await mediaReleaseCoordinator.releasePaths(paths);
    fileStore.deleteFiles(files);
  });

  return (
    <RemovalAlert
      open={uiStore.isToolbarFileRemoverOpen}
      title={`Are you sure you want to delete ${selection.size} missing file${
        selection.size > 1 ? 's' : ''
      }?`}
      information="Deleting files will permanently remove them from OneFolder, so any tags saved on them will be lost. If you move files back into their location, they will be automatically detected by OneFolder."
      body={
        <div className="deletion-confirmation-list">
          {Array.from(selection).map((f) => (
            <div key={f.id}>{f.absolutePath}</div>
          ))}
        </div>
      }
      onCancel={uiStore.closeToolbarFileRemover}
      onConfirm={handleConfirm}
    />
  );
});

export const MoveFilesToTrashBin = observer(() => {
  const { fileStore, uiStore, mediaReleaseCoordinator } = useStore();
  const selection = uiStore.fileSelection;
  const isOpen = uiStore.isMoveFilesToTrashOpen;

  // Paths whose drive has no Recycle Bin — these will be PERMANENTLY deleted.
  // Determined up-front (the main process checks for a `$Recycle.Bin` folder on
  // the volume) so the confirmation dialog can warn before the user commits.
  // INV-014 found that the long-standing "can't delete" reports were caused by
  // `shell.trashItem` failing on Recycle-Bin-less drives — not a held <video>
  // file handle, which is what INV-008 had assumed.
  const [nonRecyclable, setNonRecyclable] = React.useState<Set<string>>(new Set());

  React.useEffect(() => {
    if (!isOpen) {
      setNonRecyclable(new Set());
      return;
    }
    let cancelled = false;
    const paths = Array.from(uiStore.fileSelection, (f) => f.absolutePath);
    RendererMessenger.checkRecyclable(paths)
      .then((nonRecyclablePaths) => {
        if (!cancelled) {
          setNonRecyclable(new Set(nonRecyclablePaths));
        }
      })
      .catch(() => {
        // If the check fails, assume everything is recyclable and let
        // shell.trashItem surface any real failure as it did before.
        if (!cancelled) {
          setNonRecyclable(new Set());
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, uiStore]);

  const handleConfirm = action(async () => {
    uiStore.closeMoveFilesToTrash();

    // Release any <video> handles for the selected files before touching them
    // on disk. (INV-008; kept as harmless defence-in-depth — INV-014 showed it
    // is not what fixes the actual "can't delete" failure.)
    const paths = Array.from(selection, (f) => f.absolutePath);
    await mediaReleaseCoordinator.releasePaths(paths);

    const deleted = [];
    let permanentCount = 0;
    for (const file of selection) {
      const isPermanent = nonRecyclable.has(file.absolutePath);
      const error = isPermanent
        ? await RendererMessenger.deleteFilePermanently(file.absolutePath)
        : await RendererMessenger.trashFile(file.absolutePath);
      if (!error) {
        deleted.push(file);
        if (isPermanent) {
          permanentCount++;
        }
      } else {
        console.warn(
          isPermanent ? 'Could not permanently delete file' : 'Could not move file to trash',
          file.absolutePath,
          error,
        );
      }
    }
    fileStore.deleteFiles(deleted);
    if (deleted.length !== selection.size) {
      AppToaster.show({
        message: 'Some files could not be deleted.',
        clickAction: {
          onClick: () => RendererMessenger.toggleDevTools(),
          label: 'More info',
        },
        timeout: 8000,
      });
    } else if (permanentCount > 0) {
      AppToaster.show({
        message:
          permanentCount === deleted.length
            ? `Permanently deleted ${permanentCount} file${
                permanentCount > 1 ? 's' : ''
              } (no Recycle Bin on that drive).`
            : `${permanentCount} file${
                permanentCount > 1 ? 's' : ''
              } permanently deleted (no Recycle Bin); the rest went to the Recycle Bin.`,
        timeout: 6000,
      });
    }
  });

  const isMulti = selection.size > 1;
  const allPermanent = nonRecyclable.size > 0 && nonRecyclable.size >= selection.size;
  const somePermanent = nonRecyclable.size > 0 && !allPermanent;

  let information: string;
  if (allPermanent) {
    information = `${
      isMulti ? 'These files are' : 'This file is'
    } on a drive with no Recycle Bin and will be PERMANENTLY deleted. This cannot be undone. All assigned tags in OneFolder will also be lost.`;
  } else if (somePermanent) {
    information = `${nonRecyclable.size} of these files ${
      nonRecyclable.size > 1 ? 'are' : 'is'
    } on a drive with no Recycle Bin and will be PERMANENTLY deleted (this cannot be undone); the rest will be moved to your Recycle Bin. All assigned tags in OneFolder will be lost.`;
  } else {
    information = `You will be able to recover ${
      isMulti ? 'them' : 'it'
    } from your system's trash bin, but all assigned tags to ${
      isMulti ? 'them' : 'it'
    } in OneFolder will be lost.`;
  }

  return (
    <RemovalAlert
      open={isOpen}
      title={`Are you sure you want to delete ${selection.size} file${isMulti ? 's' : ''}?`}
      information={information}
      primaryButtonText={allPermanent ? 'Permanently Delete' : undefined}
      body={
        <div className="deletion-confirmation-list">
          {Array.from(selection).map((f) => (
            <div key={f.id}>
              {f.absolutePath}
              {nonRecyclable.has(f.absolutePath) && ' — permanent'}
            </div>
          ))}
        </div>
      }
      onCancel={uiStore.closeMoveFilesToTrash}
      onConfirm={handleConfirm}
    />
  );
});

/**
 * Modal that appears after a successful re-encode, asking whether to delete
 * the original source file. Mirrors MoveFilesToTrashBin's handle-release ->
 * recyclable-check -> trashFile/deleteFilePermanently -> fileStore.deleteFiles
 * flow (INV-008, INV-014) so the deletion behaviour is exactly consistent with
 * the regular trash flow. (TASK-079 / INV-018)
 */
export const ReEncodeDeleteOriginal = observer(() => {
  const { fileStore, uiStore, mediaReleaseCoordinator } = useStore();
  const source = uiStore.reEncodeDeleteOriginalFile;
  const isOpen = source !== null;

  // Determine recyclability as soon as the modal opens.
  const [isPermanent, setIsPermanent] = React.useState(false);

  React.useEffect(() => {
    if (!isOpen || source === null) {
      setIsPermanent(false);
      return;
    }
    let cancelled = false;
    RendererMessenger.checkRecyclable([source.absolutePath])
      .then((nonRecyclablePaths) => {
        if (!cancelled) {
          setIsPermanent(nonRecyclablePaths.includes(source.absolutePath));
        }
      })
      .catch(() => {
        // If the check fails, fall back to the recyclable path and let
        // shell.trashItem surface any real failure, matching MoveFilesToTrashBin.
        if (!cancelled) {
          setIsPermanent(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, source]);

  const handleConfirm = action(async () => {
    if (source === null) {
      uiStore.closeReEncodeDeleteOriginal();
      return;
    }
    uiStore.closeReEncodeDeleteOriginal();

    // Release any open <video> handles before touching the file (INV-008).
    await mediaReleaseCoordinator.releasePaths([source.absolutePath]);

    const error = isPermanent
      ? await RendererMessenger.deleteFilePermanently(source.absolutePath)
      : await RendererMessenger.trashFile(source.absolutePath);

    if (!error) {
      // In-place splice — no refetch — consistent with INV-015.
      fileStore.deleteFiles([source]);
      if (isPermanent) {
        AppToaster.show({
          message: `Original permanently deleted (no Recycle Bin on that drive).`,
          timeout: 5000,
        });
      }
    } else {
      console.warn(
        isPermanent ? 'Could not permanently delete original' : 'Could not move original to trash',
        source.absolutePath,
        error,
      );
      AppToaster.show({
        message: 'Could not delete the original file.',
        clickAction: {
          onClick: () => RendererMessenger.toggleDevTools(),
          label: 'More info',
        },
        timeout: 8000,
      });
    }
  });

  const bodyText = isPermanent
    ? `The re-encoded copy was saved. Permanently delete the original "${
        source?.name ?? ''
      }"? (This drive has no Recycle Bin — this cannot be undone.)`
    : `The re-encoded copy was saved. Delete the original "${
        source?.name ?? ''
      }"? It will be moved to the Recycle Bin.`;

  return (
    <Alert
      open={isOpen}
      title="Delete original?"
      icon={IconSet.WARNING}
      type="warning"
      primaryButtonText={isPermanent ? 'Permanently Delete' : 'Delete Original'}
      closeButtonText="Keep Original"
      defaultButton={DialogButton.PrimaryButton}
      onClick={(button) => {
        if (button === DialogButton.PrimaryButton) {
          handleConfirm();
        } else {
          uiStore.closeReEncodeDeleteOriginal();
        }
      }}
    >
      <p>{bodyText}</p>
    </Alert>
  );
});

export const SavedSearchRemoval = observer((props: IRemovalProps<ClientFileSearchItem>) => {
  const { searchStore } = useStore();
  return (
    <RemovalAlert
      open
      title="Search item removal"
      information={`Are you sure you want to delete the search item "${props.object.name}"?`}
      onCancel={props.onClose}
      onConfirm={() => {
        props.onClose();
        searchStore.remove(props.object);
      }}
    />
  );
});

interface IRemovalAlertProps {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  title: string;
  information: string;
  primaryButtonText?: string;
  body?: React.ReactNode;
}

const RemovalAlert = (props: IRemovalAlertProps) => (
  <Alert
    open={props.open}
    title={props.title}
    icon={IconSet.WARNING}
    type="danger"
    primaryButtonText={props.primaryButtonText ?? 'Delete'}
    defaultButton={DialogButton.PrimaryButton}
    onClick={(button) =>
      button === DialogButton.CloseButton ? props.onCancel() : props.onConfirm()
    }
  >
    <p>{props.information}</p>
    {props.body}
  </Alert>
);
