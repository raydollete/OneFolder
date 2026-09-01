import React, { ReactNode, useCallback, useEffect, useState } from 'react';

import { humanFileSize } from 'common/fmt';
import { isFileExtensionVideo } from 'common/fs';
import { RendererMessenger } from 'src/ipc/renderer';
import { useStore } from '../contexts/StoreContext';
import { ClientFile } from '../entities/File';
import { usePromise } from '../hooks/usePromise';
import ExternalLink from './ExternalLink';
import { AppToaster } from './Toaster';

type CommonMetadata = {
  name: string;
  folder: string;
  dimensions: string;
  frameRate?: string;
  size: string;
};

const commonMetadataLabels: Record<keyof CommonMetadata, string> = {
  name: 'Filename',
  folder: 'Folder Name',
  dimensions: 'Dimensions',
  frameRate: 'Frame Rate',
  size: 'Size',
};

/** Name of the immediate folder containing the file (not the full path). */
const immediateFolderName = (absolutePath: string): string => {
  const parts = absolutePath.split(/[/\\]+/).filter(Boolean);
  // The last part is the filename; the one before it is the immediate folder.
  return parts.length >= 2 ? parts[parts.length - 2] : '';
};

/**
 * Format an ExifTool VideoFrameRate value (e.g. "29.970030" or "30") into a
 * concise display string like "29.97" or "30". Returns '' for missing/non-numeric
 * input so nothing is appended.
 */
const formatFps = (raw: string | undefined): string => {
  if (!raw) {
    return '';
  }
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) {
    return '';
  }
  // Round to 2 decimals, then drop trailing zeros (and a trailing dot).
  return n.toFixed(2).replace(/\.?0+$/, '');
};

type ExifField = { label: string; modifiable?: boolean; format?: (val: string) => ReactNode };

// Details: https://www.vcode.no/web/resource.nsf/ii2lnug/642.htm
const exifFields: Record<string, ExifField> = {
  // PhotometricInterpretation: { label: 'Color Mode' },
  // BitsPerSample: { label: 'Bit Depth' },
  Software: { label: 'Creation Software', modifiable: true },
  Artist: { label: 'Creator', modifiable: true },
  CreatorWorkURL: {
    label: 'Creator URL',
    modifiable: true,
    format: function CreatorURL(url?: string) {
      if (!url) {
        return ' ';
      }
      return <ExternalLink url={url}>{url}</ExternalLink>;
    },
  },
  // ImageDescription: { label: 'Description', modifiable: true },
  Parameters: { label: 'Parameters' },
  Copyright: { label: 'Copyright', modifiable: true },
  Make: { label: 'Camera Manufacturer' },
  Model: { label: 'Camera Model' },
  // Megapixels: { label: 'Megapixels'  },
  // ExposureTime: { label: 'Exposure Time'  },
  // FNumber: { label: 'F-stop'  },
  // FocalLength: { label: 'Focal Length'  },
  GPSLatitude: { label: 'GPS Latitude' },
  GPSLongitude: { label: 'GPS Longitude' },
};

const exifTags = Object.keys(exifFields);

const stopPropagation = (e: React.KeyboardEvent<HTMLInputElement>) => e.stopPropagation();

interface ImageInfoProps {
  file: ClientFile;
}

const ImageInfo = ({ file }: ImageInfoProps) => {
  const { exifTool } = useStore();

  const [isEditing, setIsEditing] = useState(false);
  const [viewAllExifTool, setViewAllExifTool] = useState(false);
  const [exifStats, setExifStats] = useState<Record<string, string>>({});
  const [exifAll, setExifAll] = useState<string>('');

  // Frame rate is only meaningful for videos. Read it through usePromise so the
  // async read is stale-guarded (a resolution for a previously selected file is
  // ignored) and its error branch is explicit instead of silently swallowed.
  const framePoll = usePromise(
    file.absolutePath,
    file.extension,
    async (path, ext): Promise<string | undefined> =>
      isFileExtensionVideo(ext)
        ? (await exifTool.readExifTags(path, ['VideoFrameRate']))[0]
        : undefined,
  );

  let frameRate = '';
  if (framePoll.tag === 'ready') {
    if ('ok' in framePoll.value) {
      const fps = formatFps(framePoll.value.ok);
      frameRate = fps ? `${fps} fps` : '';
    } else {
      // Fail loud: distinguish "read failed" from "video has no frame rate".
      console.warn('[ImageInfo] frame-rate read failed', file.absolutePath, framePoll.value.err);
    }
  }

  const fileStats: CommonMetadata = {
    name: file.name,
    folder: immediateFolderName(file.absolutePath),
    dimensions: `${file.width || '?'} x ${file.height || '?'}`,
    frameRate: frameRate || undefined,
    size: humanFileSize(file.size),
  };

  useEffect(() => {
    // When the file changes, update the exif stats
    let cancelled = false;
    setIsEditing(false);
    // Reset previous fields to empty string, so the re-render doesn't flicker as when setting it to {}
    setExifStats(
      Object.entries(exifStats).reduce(
        (acc, [key, val]) => ({ ...acc, [key]: val ? ' ' : '' }),
        {},
      ),
    );

    // Stale-guard both reads: a late resolution from a previously selected file must
    // never seed the display (exifAll) or the editable inputs (exifStats + write-back).
    exifTool
      .readAllExifTags(file.absolutePath)
      .then((values) => {
        if (!cancelled) {
          setExifAll(JSON.stringify(values, null, 2));
        }
      })
      .catch((err) => {
        if (!cancelled) {
          console.warn('[ImageInfo] readAll failed', file.absolutePath, err);
        }
      });

    exifTool
      .readExifTags(file.absolutePath, exifTags)
      .then((tagValues) => {
        if (cancelled) {
          return;
        }
        const stats: Record<string, string> = {};
        tagValues.forEach((val, i) => {
          const key = exifTags[i];
          stats[key] = val || '';
        });
        setExifStats(stats);
      })
      .catch((err) => {
        if (!cancelled) {
          console.warn('[ImageInfo] exif read failed', file.absolutePath, err);
        }
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.absolutePath]);

  const handleEditSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();

      const form = e.currentTarget as HTMLFormElement;

      const data: Record<string, string> = {};
      const newExifStats = { ...exifStats };
      for (const [key, field] of Object.entries(exifFields)) {
        if (field.modifiable) {
          const value = (form.elements.namedItem(key) as HTMLInputElement).value;
          if (value) {
            // Set value to store in exif data
            data[key] = value;

            // Update data for in view, lil bit hacky
            newExifStats[key] = value;
          }
        }
      }

      setIsEditing(false);
      setExifStats(newExifStats);

      // TODO: also update filename here?

      // TODO: this doesn't update the modified time of the file. Maybe it should? See ExifIO internals
      exifTool
        .writeData(file.absolutePath, data)
        .then(() => AppToaster.show({ message: 'Image file saved!', timeout: 3000 }))
        .catch((err) => {
          AppToaster.show({
            message: 'Could not save image file',
            clickAction: { label: 'View', onClick: RendererMessenger.toggleDevTools },
            timeout: 6000,
          });
          console.error('Could not update file', err);
        });
    },
    [exifStats, exifTool, file.absolutePath],
  );

  // Todo: Would be nice to also add tooltips explaining what these mean (e.g. diff between dimensions & resolution)
  // Or add the units: pixels vs DPI
  return (
    <div className="inspector-section">
      <form onSubmit={handleEditSubmit} onReset={() => setIsEditing(false)}>
        <table id="file-info">
          <tbody>
            {Object.entries(commonMetadataLabels).map(([field, label]) => {
              const value = fileStats[field as keyof CommonMetadata];
              // Frame Rate is optional: hide the row entirely for images and for
              // videos that report no frame rate (rather than showing '?'/blank).
              if (field === 'frameRate' && !value) {
                return null;
              }
              return (
                <tr key={field}>
                  <th scope="row">{label}</th>
                  <td>{value}</td>
                </tr>
              );
            })}
            {Object.entries(exifFields).map(([key, field]) => {
              const value = exifStats[key];
              const isEditingMode = isEditing && field.modifiable;
              if (!value && !isEditingMode) {
                return null;
              }
              return (
                <tr key={key}>
                  <th scope="row">{field.label}</th>

                  <td>
                    {!isEditingMode ? (
                      field.format?.(value || '') || value
                    ) : (
                      <input defaultValue={value || ''} name={key} onKeyDown={stopPropagation} />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <button
          className="show-exiftool"
          onClick={(e) => {
            e.preventDefault();
            setViewAllExifTool(!viewAllExifTool);
          }}
        >
          {viewAllExifTool ? 'hide' : 'show'} exiftool values ...
        </button>
        {viewAllExifTool && (
          <>
            <textarea
              name="exifToolAllFile"
              id=""
              cols={30}
              rows={10}
              value={exifAll}
              readOnly
            ></textarea>
            <br />
          </>
        )}
        <div className={'inspector-section__action-buttons '}>
          {isEditing ? (
            <>
              <button type="reset">cancel</button>
              <button className="highlight-save" type="submit">
                save
              </button>
            </>
          ) : (
            <button
              className="edit-button"
              onClick={(e) => {
                e.preventDefault();
                setIsEditing(true);
              }}
            >
              edit
            </button>
          )}
        </div>
      </form>
    </div>
  );
};

export default React.memo(ImageInfo);
