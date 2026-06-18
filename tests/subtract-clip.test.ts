/**
 * Tests for buildSubtractClipArgs — the pure arg builder behind the "Subtract Clip" tool.
 *
 * These lock in the two correctness fixes vs. a naive xfade command:
 *   - the xfade `offset` is COMPUTED (start − crossfade), not a hardcoded constant, and
 *   - the audio is cross-faded (acrossfade), not dropped.
 */

import { buildSubtractClipArgs, SUBTRACT_CLIP_CROSSFADE_SEC } from '../src/media/subtractClip';

describe('buildSubtractClipArgs', () => {
  it('emits a -filter_complex graph as a single argv element, then the stream maps and codecs', () => {
    const args = buildSubtractClipArgs(10, 20);

    const fcIdx = args.indexOf('-filter_complex');
    expect(fcIdx).toBe(0);
    // The whole graph is one argument (no shell, no splitting).
    const graph = args[fcIdx + 1];
    expect(typeof graph).toBe('string');

    // Maps and codecs follow the graph.
    expect(args).toEqual([
      '-filter_complex',
      graph,
      '-map',
      '[v]',
      '-map',
      '[a]',
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
    ]);
  });

  it('trims clip A [0:start] and clip B [end:eof] for both video and audio', () => {
    const graph = buildSubtractClipArgs(10, 20)[1];

    // Video segments.
    expect(graph).toContain('[0:v]trim=0:10,setpts=PTS-STARTPTS[va]');
    expect(graph).toContain('[0:v]trim=start=20,setpts=PTS-STARTPTS[vb]');
    // Audio segments (proves audio is kept, not dropped).
    expect(graph).toContain('[0:a]atrim=0:10,asetpts=N/SR/TB[aa]');
    expect(graph).toContain('[0:a]atrim=start=20,asetpts=N/SR/TB[ab]');
  });

  it('computes the xfade offset as start − crossfade (NOT a hardcoded value)', () => {
    const graph = buildSubtractClipArgs(10, 20)[1];
    // crossfade defaults to 1s, clip A is 10s long -> blend begins at t=9.
    expect(graph).toContain('[va][vb]xfade=transition=fade:duration=1:offset=9[v]');
    expect(graph).toContain('[aa][ab]acrossfade=d=1[a]');
  });

  it('honors a custom crossfade duration in both offset and acrossfade', () => {
    const graph = buildSubtractClipArgs(30, 45, 2)[1];
    expect(graph).toContain('xfade=transition=fade:duration=2:offset=28[v]');
    expect(graph).toContain('acrossfade=d=2[a]');
  });

  it('defaults the crossfade to the shared 1-second constant', () => {
    expect(SUBTRACT_CLIP_CROSSFADE_SEC).toBe(1);
    const graph = buildSubtractClipArgs(5, 8)[1];
    expect(graph).toContain(`duration=${SUBTRACT_CLIP_CROSSFADE_SEC}`);
    expect(graph).toContain(`offset=${5 - SUBTRACT_CLIP_CROSSFADE_SEC}`);
  });
});
