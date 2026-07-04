import { autorun, reaction } from 'mobx';
import { observer } from 'mobx-react-lite';
import React, { useCallback, useEffect, useMemo, useRef, RefObject } from 'react';
import { ClientFile } from 'src/frontend/entities/File';
import { useStore } from 'src/frontend/contexts/StoreContext';
import { useAction, useComputed } from 'src/frontend/hooks/mobx';
import platform from 'src/frontend/platform';
import { usePromise } from 'src/frontend/hooks/usePromise';
import { isFileExtensionVideo } from 'common/fs';
import { attachVideoFreezeRecovery } from 'src/frontend/image/videoFreezeRecovery';
import { Button, IconSet, Split } from 'widgets';
import { UpscaleMode } from '../../../stores/UiStore';
import Inspector from '../../Inspector';
import { CommandDispatcher } from '../Commands';
import ZoomPan, { CONTAINER_DEFAULT_STYLE, SlideTransform } from '../SlideMode/ZoomPan';
import { ContentRect } from '../utils';
import { Vec2, createDimension } from './utils';
import AnnotoriousWrapper from './AnnotoriousWrapper';
import { ToolbarButton } from 'widgets/toolbar';

const SlideMode = observer(({ contentRect }: { contentRect: ContentRect }) => {
  const { uiStore } = useStore();
  const isInspectorOpen = uiStore.isInspectorOpen;
  const inspectorWidth = uiStore.inspectorWidth;
  const isOutlineOpen = uiStore.isOutlinerOpen;
  const outlineWidth = uiStore.outlinerWidth;
  const contentWidth =
    contentRect.width - (isInspectorOpen ? inspectorWidth : 0) + (isOutlineOpen ? outlineWidth : 0);
  const contentHeight = contentRect.height;

  return (
    <Split
      id="slide-mode"
      className={uiStore.isSlideMode ? 'fade-in' : 'fade-out'}
      primary={<Inspector />}
      secondary={<SlideView width={contentWidth} height={contentHeight} />}
      axis="vertical"
      align="right"
      splitPoint={inspectorWidth}
      isExpanded={isInspectorOpen}
      onMove={uiStore.moveInspectorSplitter}
    />
  );
});

interface SlideViewProps {
  width: number;
  height: number;
}

const SlideView = observer(({ width, height }: SlideViewProps) => {
  const { uiStore, fileStore, imageLoader, mediaReleaseCoordinator } = useStore();
  // In slide mode this resolves by identity anchor (uiStore.slideFileId), so the
  // open file is stable across fileList re-sorts/inserts; `undefined` means the
  // anchored file left the list and we render an explicit empty state below.
  const file = uiStore.slideFile;
  const eventManager = useMemo(() => (file ? new CommandDispatcher(file) : undefined), [file]);
  const isFirst = useComputed(() => uiStore.firstItem === 0);
  const isLast = useComputed(() => uiStore.firstItem === fileStore.fileList.length - 1);

  // Go to the first selected image on load
  useEffect(() => {
    return reaction(
      () => uiStore.firstSelectedFile?.id,
      (id, _, reaction) => {
        if (id !== undefined) {
          const index = fileStore.getIndex(id);
          uiStore.setFirstItem(index);

          // Also, select only this file: makes more sense for the TagEditor overlay: shows tags on selected images
          if (index !== undefined) {
            uiStore.selectFile(fileStore.fileList[index], true);
          }

          reaction.dispose();
        }
      },
      { fireImmediately: true },
    );
  }, [fileStore, uiStore]);

  // Go back to previous view when pressing the back button (mouse button 5)
  useEffect(() => {
    // Push a dummy state, so that a pop-state event can be activated
    // TODO: would be nice to also open SlideMode again when pressing forward button: actually store the open image in the window.location?
    history.pushState(null, document.title, location.href);
    const popStateHandler = uiStore.disableSlideMode;
    window.addEventListener('popstate', popStateHandler);
    return () => window.removeEventListener('popstate', popStateHandler);
  }, [uiStore]);

  // Prev/next move relative to the *anchored* file's current position, then
  // re-anchor to the newly shown file via setSlideFile so the viewer follows by
  // identity. Missing-anchor fallback: if the anchored file has left the list
  // (viewer is in its empty state), step relative to the retained firstItem so
  // the user can navigate back into a valid file instead of deadlocking.
  const currentNavIndex = (): number => {
    const anchorIndex =
      uiStore.slideFileId !== undefined ? fileStore.getIndex(uiStore.slideFileId) : undefined;
    return anchorIndex ?? uiStore.firstItem;
  };
  const decrImgIndex = useAction(() => {
    if (fileStore.fileList.length === 0) {
      return;
    }
    const index = Math.max(0, currentNavIndex() - 1);
    const target = fileStore.fileList[index];
    uiStore.setSlideFile(target);
    // Select only this file: TagEditor overlay shows tags on selected images
    uiStore.selectFile(target, true);
  });
  const incrImgIndex = useAction(() => {
    if (fileStore.fileList.length === 0) {
      return;
    }
    const index = Math.min(currentNavIndex() + 1, fileStore.fileList.length - 1);
    const target = fileStore.fileList[index];
    uiStore.setSlideFile(target);
    uiStore.selectFile(target, true);
  });

  // Detect left/right arrow keys to scroll between images. Top/down is already handled in the layout that's open in the background
  useEffect(() => {
    const handleUserKeyPress = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') {
        decrImgIndex();
        event.stopPropagation();
      } else if (event.key === 'ArrowRight') {
        incrImgIndex();
        event.stopPropagation();
      } else if (event.key === 'Escape' || event.key === 'Backspace') {
        if (event.target instanceof HTMLInputElement) {
          return;
        }
        uiStore.disableSlideMode();
        event.stopPropagation();
      }
    };
    window.addEventListener('keydown', handleUserKeyPress);
    return () => {
      window.removeEventListener('keydown', handleUserKeyPress);
    };
  }, [decrImgIndex, incrImgIndex, uiStore]);

  // Preload next and previous image for better UX.
  // Orphan video elements are tracked in preloadVideosRef so the coordinator
  // can release their OS handles before a trash/move op (INV-008), and so we
  // can tear them down immediately on unmount rather than waiting for GC.
  const preloadVideosRef = useRef<Map<string, { el: HTMLVideoElement; unregister: () => void }>>(
    new Map(),
  );
  useEffect(() => {
    let isEffectRunning = true;
    const dispose = autorun(() => {
      if (!isLast.get() && uiStore.firstItem + 1 < fileStore.fileList.length) {
        const nextFile = fileStore.fileList[uiStore.firstItem + 1];
        if (isFileExtensionVideo(nextFile.extension)) {
          // Reuse or create a preload video element for this path
          if (!preloadVideosRef.current.has(nextFile.absolutePath)) {
            const el = document.createElement('video');
            const unregister = mediaReleaseCoordinator.register(nextFile.absolutePath, el);
            preloadVideosRef.current.set(nextFile.absolutePath, { el, unregister });
            imageLoader
              .getImageSrc(nextFile)
              .then((src) => isEffectRunning && src && (el.src = platform.encodeFilePath(src)));
          }
        } else {
          const nextImg = new Image();
          imageLoader
            .getImageSrc(nextFile)
            .then((src) => isEffectRunning && src && (nextImg.src = platform.encodeFilePath(src)));
        }
      }
      if (!isFirst.get() && fileStore.fileList.length > 0) {
        const prevFile = fileStore.fileList[uiStore.firstItem - 1];
        if (isFileExtensionVideo(prevFile.extension)) {
          if (!preloadVideosRef.current.has(prevFile.absolutePath)) {
            const el = document.createElement('video');
            const unregister = mediaReleaseCoordinator.register(prevFile.absolutePath, el);
            preloadVideosRef.current.set(prevFile.absolutePath, { el, unregister });
            imageLoader
              .getImageSrc(prevFile)
              .then((src) => isEffectRunning && src && (el.src = platform.encodeFilePath(src)));
          }
        } else {
          const prevImg = new Image();
          imageLoader
            .getImageSrc(prevFile)
            .then((src) => isEffectRunning && src && (prevImg.src = platform.encodeFilePath(src)));
        }
      }
    });
    // Capture the map reference at effect-creation time so the cleanup closure
    // operates on the correct Map instance even if the ref is reassigned.
    const preloadVideos = preloadVideosRef.current;
    return () => {
      isEffectRunning = false;
      dispose();
      // Explicitly release all orphan preload video elements rather than
      // waiting for GC — this closes the OS handles immediately.
      for (const { el, unregister } of preloadVideos.values()) {
        unregister();
        el.pause();
        el.removeAttribute('src');
        el.load();
      }
      preloadVideos.clear();
    };
  }, [fileStore, isFirst, isLast, uiStore, imageLoader, mediaReleaseCoordinator]);

  const transitionStart: SlideTransform | undefined = useMemo(() => {
    return undefined;
    // if (!file) {
    //   return undefined;
    // }
    // const thumbEl = document.querySelector(`[data-file-id="${file.id}"]`);
    // const container = document.querySelector('#gallery-content');
    // if (thumbEl && container) {
    //   const thumbElRect = thumbEl.getBoundingClientRect();
    //   const containerRect = container.getBoundingClientRect();
    //   return createTransform(
    //     thumbElRect.top - containerRect.top,
    //     thumbElRect.left - containerRect.left,
    //     thumbElRect.height / file.height,
    //   );
    // }
    // return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.id]);

  return (
    <div
      id="zoomable-image"
      style={{ width, height }}
      onContextMenu={eventManager?.showSlideContextMenu}
      onDrop={eventManager?.drop}
      tabIndex={-1}
    >
      <nav className="preview__nav">
        <ToolbarButton
          isCollapsible={false}
          icon={IconSet.ARROW_LEFT}
          onClick={uiStore.disableSlideMode}
          text="Back"
          tooltip="Back (space bar)"
        />
        <ToolbarButton
          icon={IconSet.EYE}
          onClick={uiStore.toggleInspector}
          checked={uiStore.isInspectorOpen}
          tooltip="Toggle the inspector panel"
          text=""
        />
      </nav>

      {file ? (
        <ZoomableImage
          file={file}
          thumbnailSrc={file.thumbnailPath}
          width={width}
          height={height}
          transitionStart={transitionStart}
          transitionEnd={uiStore.isSlideMode ? undefined : transitionStart}
          onClose={uiStore.disableSlideMode}
          upscaleMode={uiStore.upscaleMode}
        />
      ) : (
        // Explicit empty state: the anchored file has left the list (deleted or
        // filtered out). Fail loud rather than silently surfacing whatever file
        // now occupies the old index. Nav buttons remain so the user can step to
        // an adjacent file (missing-anchor fallback) or use Back to exit.
        <div id="slide-mode-empty" style={{ ...CONTAINER_DEFAULT_STYLE, textAlign: 'center' }}>
          <span className="custom-icon-128">{IconSet.MEDIA}</span>
          <h2 className="dialog-title">File no longer available</h2>
          <p>The file you were viewing is no longer in the current view.</p>
        </div>
      )}
      <NavigationButtons
        isStart={isFirst.get()}
        isEnd={isLast.get()}
        prevImage={decrImgIndex}
        nextImage={incrImgIndex}
      />
    </div>
  );
});

interface AnnotoriousImageProps {
  file: ClientFile;
  src: string;
}

const AnnotoriousImage = ({ file, src }: AnnotoriousImageProps) => {
  const { tagStore, exifTool } = useStore();
  const imgEl: RefObject<HTMLImageElement> = useRef<HTMLImageElement>(null);

  useEffect(() => {
    let annotorious: AnnotoriousWrapper | undefined;
    if (imgEl.current) {
      annotorious = new AnnotoriousWrapper(imgEl.current, file, tagStore, exifTool);
    }
    return () => annotorious?.destroy();
  }, [imgEl, file, tagStore, exifTool]);

  return (
    <div className="image_preview__wrapper">
      <img src={platform.encodeFilePath(src)} alt="" ref={imgEl} className="image_preview" />
    </div>
  );
};

interface ZoomableImageProps {
  file: ClientFile;
  thumbnailSrc: string;
  width: number;
  height: number;
  transitionStart?: SlideTransform;
  transitionEnd?: SlideTransform;
  onClose: () => void;
  upscaleMode: UpscaleMode;
}

const ZoomableImage: React.FC<ZoomableImageProps> = observer(
  ({
    file,
    thumbnailSrc,
    width,
    height,
    transitionStart,
    transitionEnd,
    onClose,
    upscaleMode,
  }: ZoomableImageProps) => {
    const { imageLoader, uiStore, mediaReleaseCoordinator } = useStore();
    const { absolutePath, width: imgWidth, height: imgHeight } = file;

    // Stable ref so the usePromise async closure can always read the current
    // coordinator without being listed in usePromise's dependency array.
    // Option A from INV-014 Task-060: minimal-refactor capture via ref.
    const coordinatorRef = useRef(mediaReleaseCoordinator);
    coordinatorRef.current = mediaReleaseCoordinator;

    // Image src can be set asynchronously: keep track of it in a state
    // Needed for image formats not natively supported by the browser (e.g. tiff): will be converted to another format
    const source = usePromise(file, thumbnailSrc, async (file, thumbnailPath) => {
      const src = await imageLoader.getImageSrc(file);
      return src ?? thumbnailPath;
    });

    const image = usePromise(
      source,
      absolutePath,
      thumbnailSrc,
      imgWidth,
      imgHeight,
      file.extension,
      async (source, absolutePath, thumbnailSrc, imgWidth, imgHeight, fileExtension) => {
        if (source.tag === 'ready') {
          if ('ok' in source.value) {
            const src = source.value.ok;
            const dimension = await new Promise<{ src: string; dimension: Vec2 }>(
              (resolve, reject) => {
                let img: HTMLVideoElement | HTMLImageElement;
                if (isFileExtensionVideo(fileExtension)) {
                  // Use a typed constant so that closures below close over a
                  // HTMLVideoElement rather than the outer `let img` (whose type
                  // TypeScript cannot narrow inside closures in strict mode).
                  const probeVideo = document.createElement('video');
                  img = probeVideo;

                  // The probe element holds a Chromium media-pipeline handle on
                  // the file for as long as it lives in the JS heap. Without
                  // explicit teardown, V8 GC alone may not release the handle
                  // in time for a fast delete-after-open scenario on Windows.
                  // Register with the coordinator so a concurrent delete picks
                  // it up; tear down explicitly after metadata read so the
                  // steady-state case does not depend on GC. (INV-014 Root Cause #3)
                  const unregisterProbe = coordinatorRef.current.register(src, probeVideo);

                  probeVideo.onloadedmetadata = function (this: any) {
                    // Videos fire 'loadedmetadata' event, not 'onload'
                    // Use videoWidth/videoHeight for actual video dimensions.
                    // Sample dimensions into locals BEFORE teardown so the values
                    // are captured regardless of what load() does to the element.
                    const videoWidth = this.videoWidth || imgWidth || 1920;
                    const videoHeight = this.videoHeight || imgHeight || 1080;
                    // Release the OS handle immediately — don't wait for GC.
                    try {
                      probeVideo.pause();
                    } catch (_) {
                      /* defensive: pause throws on some Chromium builds for never-played elements */
                    }
                    probeVideo.removeAttribute('src');
                    probeVideo.load();
                    unregisterProbe();
                    resolve({
                      src,
                      dimension: createDimension(videoWidth, videoHeight),
                    });
                  };
                  probeVideo.onerror = (error) => {
                    // Fallback to stored dimensions if video metadata loading fails
                    console.warn('Video metadata loading failed, using stored dimensions:', error);
                    // Still release the handle even on error — the element may
                    // have opened the file before the error fired.
                    try {
                      probeVideo.pause();
                    } catch (_) {
                      /* defensive */
                    }
                    probeVideo.removeAttribute('src');
                    probeVideo.load();
                    unregisterProbe();
                    resolve({
                      src,
                      dimension: createDimension(imgWidth || 1920, imgHeight || 1080),
                    });
                  };
                  // Only load metadata, not the full video content
                  probeVideo.preload = 'metadata';
                } else {
                  img = new Image();
                  img.onload = function (this: any) {
                    // TODO: would be better to resolve once transition is complete: for large resolution images, the transition freezes for ~.4s bc of a re-paint task when the image changes
                    resolve({
                      src,
                      dimension: createDimension(this.naturalWidth, this.naturalHeight),
                    });
                  };
                  img.onerror = reject;
                }

                img.src = platform.encodeFilePath(src);
              },
            );
            return dimension;
          } else {
            throw source.value.err;
          }
        } else {
          // Fallback for when source is not ready - provide reasonable defaults for videos
          const fallbackWidth = isFileExtensionVideo(fileExtension)
            ? imgWidth || 1920
            : imgWidth || 0;
          const fallbackHeight = isFileExtensionVideo(fileExtension)
            ? imgHeight || 1080
            : imgHeight || 0;

          return {
            src: thumbnailSrc || absolutePath,
            dimension: createDimension(fallbackWidth, fallbackHeight),
          };
        }
      },
    );

    // Ref for the SlideMode video element so the MediaReleaseCoordinator can
    // release its OS handle before a trash/move op. See INV-014.
    //
    // Same fix as GalleryItem.Thumbnail: the prior useEffect-based registration
    // was a no-op because the <video> is conditionally rendered on
    // image.tag === 'ready', so slideVideoRef.current was null when the effect
    // first ran and the dep list never changed to trigger a re-run.
    // A callback ref fires synchronously on attach/detach.
    //
    // ZoomPan's children render-prop passes only event handlers and style —
    // no ref — so no composed-ref is required here.
    const slideVideoRef = useRef<HTMLVideoElement | null>(null);
    const slideUnregisterRef = useRef<(() => void) | null>(null);
    // Cleanup for the freeze-recovery watchdog (solution #2): detects a stuck
    // <video> and self-heals it in place instead of requiring the user to switch
    // videos and back. See src/frontend/image/videoFreezeRecovery.ts.
    const freezeRecoveryCleanupRef = useRef<(() => void) | null>(null);
    const setSlideVideoRef = useCallback(
      (el: HTMLVideoElement | null) => {
        if (slideUnregisterRef.current) {
          slideUnregisterRef.current();
          slideUnregisterRef.current = null;
        }
        if (freezeRecoveryCleanupRef.current) {
          freezeRecoveryCleanupRef.current();
          freezeRecoveryCleanupRef.current = null;
        }
        slideVideoRef.current = el;
        if (el && isFileExtensionVideo(file.extension)) {
          slideUnregisterRef.current = mediaReleaseCoordinator.register(file.absolutePath, el);
          freezeRecoveryCleanupRef.current = attachVideoFreezeRecovery(el);
          // Apply the persisted mute preference imperatively: React's `muted` JSX prop
          // is not reliably reflected to the DOM, so we set it here on the freshly-
          // remounted element before autoplay begins. (INV-027)
          el.muted = uiStore.videoMuted;
          // Expose this element to the global shortcut dispatcher so Spacebar can
          // toggle its playback (video-spacebar-toggle-playback).
          uiStore.setActiveVideoElement(el);
        } else {
          // Detached, or not a video — stop advertising a stale/irrelevant element.
          uiStore.setActiveVideoElement(null);
        }
      },
      [file.absolutePath, file.extension, mediaReleaseCoordinator, uiStore],
    );
    // Ensure unregistration + watchdog teardown on unmount regardless of React's
    // ref-callback order.
    useEffect(
      () => () => {
        slideUnregisterRef.current?.();
        slideUnregisterRef.current = null;
        freezeRecoveryCleanupRef.current?.();
        freezeRecoveryCleanupRef.current = null;
        uiStore.setActiveVideoElement(null);
      },
      [uiStore],
    );

    if (image.tag === 'ready' && 'err' in image.value) {
      const isVideo = isFileExtensionVideo(file.extension);
      console.log(image.value.err);
      return (
        <ImageFallback
          error={image.value.err}
          absolutePath={absolutePath}
          isVideo={isVideo}
          customMessage={isVideo ? 'Video metadata could not be read' : undefined}
        />
      );
    } else {
      const { src, dimension } =
        image.tag === 'ready' && 'ok' in image.value
          ? image.value.ok
          : {
              src: thumbnailSrc || absolutePath,
              dimension: createDimension(imgWidth, imgHeight),
            };
      const minScale = Math.min(0.1, Math.min(width / dimension[0], height / dimension[1]));

      // Alternative case for videos
      if (isFileExtensionVideo(file.extension)) {
        return (
          <ZoomPan
            position="center"
            initialScale="fit"
            mediaType="video"
            doubleTapBehavior="zoomOrReset"
            imageDimension={dimension}
            containerDimension={createDimension(width, height)}
            minScale={minScale}
            maxScale={5}
            transitionStart={transitionStart}
            transitionEnd={transitionEnd}
            onClose={onClose}
            upscaleMode={upscaleMode}
          >
            {(props) => (
              <video
                {...props}
                // Key by the media resource so React REMOUNTS the element when the file changes
                // (e.g. the source -> freshly-encoded-output swap after a media job). Without a
                // key, React reuses the same already-playing <video> and only mutates `src`, which
                // a buffered/looping element does not reliably reload — it keeps presenting the
                // previous file. This is most visible for Compress & Normalize Audio, whose output
                // has identical video frames (-c:v copy), so a stale element looks exactly like the
                // original. Remounting guarantees a fresh load of the new file. (INV-026 follow-up)
                key={file.absolutePath}
                ref={setSlideVideoRef}
                src={platform.encodeFilePath(src)}
                width={dimension[0]}
                height={dimension[1]}
                controls
                autoPlay
                loop
                muted={uiStore.videoMuted}
                onVolumeChange={(e) => uiStore.setVideoMuted(e.currentTarget.muted)}
              />
            )}
          </ZoomPan>
        );
      }

      if (uiStore.isFaceModuleEnabled) {
        return <AnnotoriousImage file={file} src={src} />;
      }

      return (
        <ZoomPan
          position="center"
          initialScale="auto"
          doubleTapBehavior="zoomOrReset"
          imageDimension={dimension}
          containerDimension={createDimension(width, height)}
          minScale={minScale}
          maxScale={5}
          transitionStart={transitionStart}
          transitionEnd={transitionEnd}
          onClose={onClose}
          upscaleMode={upscaleMode}
        >
          {(props) => (
            <img
              {...props}
              src={platform.encodeFilePath(src)}
              width={dimension[0]}
              height={dimension[1]}
              alt=""
            />
          )}
        </ZoomPan>
      );
    }
  },
);

export default SlideMode;

interface NavigationButtonsProps {
  isStart: boolean;
  isEnd: boolean;
  prevImage: () => void;
  nextImage: () => void;
}

const NavigationButtons = ({ isStart, isEnd, prevImage, nextImage }: NavigationButtonsProps) => {
  const none = { display: 'none' };
  const initial = { display: 'initial' };
  return (
    <>
      <button
        style={isStart ? none : initial}
        aria-label="previous image"
        className="side-button-left"
        onClick={prevImage}
      >
        {IconSet.ARROW_LEFT}
      </button>
      <button
        style={isEnd ? none : initial}
        aria-label="next image"
        className="side-button-right"
        onClick={nextImage}
      >
        {IconSet.ARROW_RIGHT}
      </button>
    </>
  );
};

interface ImageFallbackProps {
  error: any;
  absolutePath: string;
  isVideo?: boolean;
  customMessage?: string;
}

const ImageFallback = ({ error, absolutePath, isVideo, customMessage }: ImageFallbackProps) => {
  const fileExtension = platform.path.extname(absolutePath).toLowerCase();
  const isVideoFile = isVideo || isFileExtensionVideo(fileExtension.slice(1));

  const getErrorMessage = () => {
    if (customMessage) {
      return customMessage;
    }

    if (isVideoFile) {
      return 'Could not load video';
    }

    return `Could not load ${error ? '' : 'full '}image`;
  };

  const getHelpText = () => {
    if (isVideoFile) {
      return 'This may be due to video metadata issues or unsupported codec. Try opening in an external video player.';
    }

    return 'Try opening in an external application to verify the file is not corrupted.';
  };

  return (
    <div style={CONTAINER_DEFAULT_STYLE} className="image-fallback">
      <div style={{ maxHeight: 360, maxWidth: 360 }} className="image-error" />
      <br />
      <span>{getErrorMessage()}</span>
      <pre
        title={absolutePath}
        style={{ maxWidth: '40ch', overflow: 'hidden', textOverflow: 'ellipsis' }}
      >
        {platform.path.basename(absolutePath)}
      </pre>
      <p style={{ fontSize: '0.9em', color: '#888', maxWidth: '50ch', textAlign: 'center' }}>
        {getHelpText()}
      </p>
      <Button
        onClick={() =>
          platform.desktop
            .openExternal(platform.encodeFilePath(absolutePath))
            .catch((e) => console.error(e, absolutePath))
        }
        text={isVideoFile ? 'Open in external video player' : 'Open in external application'}
      />
    </div>
  );
};
