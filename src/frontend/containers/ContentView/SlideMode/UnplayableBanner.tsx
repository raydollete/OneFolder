import React from 'react';
import { observer } from 'mobx-react-lite';

import { ClientFile } from 'src/frontend/entities/File';
import { derivePlayability, usesContainerReason } from 'src/frontend/image/playability';

interface UnplayableBannerProps {
  file: ClientFile;
}

const BANNER_STYLE: React.CSSProperties = {
  // Inline banner over the letterboxed video area — NOT a blocking overlay:
  // it occupies only its own box, the <video> stays mounted and interactive.
  position: 'fixed',
  bottom: '24px',
  left: '50%',
  transform: 'translateX(-50%)',
  maxWidth: 'min(70vw, 640px)',
  display: 'flex',
  alignItems: 'center',
  gap: '12px',
  padding: '10px 16px',
  borderRadius: '8px',
  background: 'rgba(255, 171, 0, 0.95)',
  color: '#1d1d1d',
  boxShadow: '0 2px 12px rgba(0, 0, 0, 0.35)',
  zIndex: 20,
};

/**
 * Inline banner shown when the selected file's STORED codec/container facts
 * derive an unplayable verdict (changes: support-mov-playback,
 * support-mkv-ts-playback). Vocabulary is fixed across surfaces: title
 * `<Reason> — not playable here`, where Reason is the probed codec or
 * `MPEG-TS` for the container-driven verdict; the body names the remedy —
 * the inspector Tools panel's existing `Re-encode (x264)` tool (owner
 * decision 2026-10-27: no separate `Create playable copy` button). The
 * banner is an inline disclosure, never a blocking overlay, and is mounted
 * only when the derivation says unplayable — error/unprobed files never see
 * it (never badge an unknown).
 */
export const UnplayableBanner = observer(function UnplayableBanner({
  file,
}: UnplayableBannerProps) {
  if (derivePlayability(file.videoCodec, file.audioCodec, file.formatName) !== 'unplayable') {
    return null;
  }
  // Reason token: the container for an MPEG-TS verdict (the derivation's own
  // predicate — banner and verdict can never drift), the probed codec otherwise.
  const containerDriven = usesContainerReason(file.formatName);
  const reason = containerDriven ? 'MPEG-TS' : (file.videoCodec ?? '').trim().toUpperCase();
  const cause = containerDriven
    ? 'MPEG-TS is not demuxable in this app'
    : `${reason} is not decodable in this app`;
  const isDesktop = !IS_WEB_BUILD;

  return (
    <div className="unplayable-banner" role="status" style={BANNER_STYLE}>
      <div>
        <div className="unplayable-banner__title">
          <strong>{`${reason} — not playable here`}</strong>
        </div>
        <div className="unplayable-banner__body">
          {isDesktop
            ? `${cause}. Use "Re-encode (x264)" in the Tools panel to create a playable H.264 .mp4 copy next to the original — the original is never modified.`
            : 'Not playable in this browser'}
        </div>
      </div>
    </div>
  );
});
