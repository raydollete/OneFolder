/**
 * Regression tests for the DB-based probe-pass trigger helpers
 * (support-mov-playback defect: the renderer trigger built candidates from
 * fileStore.fileList at a point where it was still empty — every codec fact
 * stayed NULL in a live library). The candidates must come from the DB rows
 * and updates must be persistable for rows no ClientFile holds yet.
 */
import {
  applyProbeUpdatesToRows,
  buildProbeCandidatesFromRows,
  ProbeRowSource,
} from '../src/ipc/videoProbePass';
import type { VideoProbeUpdate } from '../src/ipc/messages';

function row(overrides: Partial<ProbeRowSource> & { id: string; extension: string }): ProbeRowSource {
  return {
    locationId: 'loc1',
    relativePath: `${overrides.id}.bin`,
    codecVersion: null,
    ...overrides,
  };
}

const resolvePath = (r: ProbeRowSource): string | undefined =>
  r.locationId === 'loc1' ? `/library/${r.relativePath}` : undefined;

describe('buildProbeCandidatesFromRows', () => {
  it('selects recognized-video rows from the DB rows, not from any materialized list', () => {
    const rows = [
      row({ id: 'a', extension: 'mkv' }),
      row({ id: 'b', extension: 'ts' }),
      row({ id: 'c', extension: 'mov' }),
      row({ id: 'd', extension: 'jpg' }),
    ];
    const candidates = buildProbeCandidatesFromRows(rows, resolvePath);
    expect(candidates.map((c) => c.id).sort()).toEqual(['a', 'b', 'c']);
    expect(candidates.find((c) => c.id === 'a')).toEqual({
      id: 'a',
      absolutePath: '/library/a.bin',
      codecVersion: null,
    });
  });

  it('carries the stored stamp so fresh rows spawn nothing downstream', () => {
    const rows = [row({ id: 'a', extension: 'mp4', codecVersion: '1:123:456' })];
    expect(buildProbeCandidatesFromRows(rows, resolvePath)[0].codecVersion).toBe('1:123:456');
  });

  it('skips rows whose location cannot be resolved (unstat-able path)', () => {
    const rows = [row({ id: 'a', extension: 'mkv' }), row({ id: 'z', extension: 'mkv', locationId: 'gone' })];
    expect(buildProbeCandidatesFromRows(rows, resolvePath).map((c) => c.id)).toEqual(['a']);
  });

  it('returns no candidates for an image-only library (zero spawns for images)', () => {
    const rows = [row({ id: 'a', extension: 'png' }), row({ id: 'b', extension: 'jpg' })];
    expect(buildProbeCandidatesFromRows(rows, resolvePath)).toEqual([]);
  });
});

describe('applyProbeUpdatesToRows', () => {
  const updates: VideoProbeUpdate[] = [
    { id: 'a', videoCodec: 'h264', audioCodec: 'aac', formatName: 'matroska,webm', codecVersion: '1:10:20' },
    { id: 'b', videoCodec: 'hevc', audioCodec: null, formatName: 'mov,mp4,m4a,3gp,3g2,mj2', codecVersion: '1:30:40' },
  ];

  it('patches only updated rows and writes all four facts incl. explicit nulls', () => {
    const rows = [row({ id: 'a', extension: 'mkv' }), row({ id: 'b', extension: 'mov' }), row({ id: 'c', extension: 'ts' })];
    const patched = applyProbeUpdatesToRows(rows, updates);
    expect(patched.map((r) => r.id)).toEqual(['a', 'b']);
    expect(patched[0]).toMatchObject({
      videoCodec: 'h264',
      audioCodec: 'aac',
      formatName: 'matroska,webm',
      codecVersion: '1:10:20',
    });
    expect(patched[1]).toMatchObject({ videoCodec: 'hevc', audioCodec: null });
  });

  it('leaves untouched rows out of the persistence set entirely', () => {
    const rows = [row({ id: 'c', extension: 'ts' })];
    expect(applyProbeUpdatesToRows(rows, updates)).toEqual([]);
  });

  it('ignores updates for concurrently deleted rows', () => {
    const rows: ProbeRowSource[] = [];
    expect(applyProbeUpdatesToRows(rows, updates)).toEqual([]);
  });

  it('returns nothing when the pass produced no updates (all fresh/error)', () => {
    const rows = [row({ id: 'a', extension: 'mkv' })];
    expect(applyProbeUpdatesToRows(rows, [])).toEqual([]);
  });
});
