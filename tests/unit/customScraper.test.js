// Deterministic coverage for the YouTube URL helpers in customScraper.js.
//
// These are the functions that decide whether a saved favorite/history item can
// still be re-extracted. YouTube rotates signed googlevideo CDN URLs constantly,
// so `recoveredYouTubeWatchUrl` rebuilding a canonical watch page is what keeps
// old favorites playable. A silent regex regression here does NOT break the
// build - it only shows up as "this old video stopped working", which is exactly
// the class of bug that is invisible until users report it.
//
// All expectations below were verified against the implementation's actual
// output before being written.

import { describe, it, expect } from 'vitest';
import {
  getYouTubeVideoId,
  isYouTubeUrl,
  pickBestStream,
  recoveredYouTubeWatchUrl,
} from '../../src/services/customScraper.js';

describe('isYouTubeUrl', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', true],
    ['https://youtu.be/dQw4w9WgXcQ', true],
    ['https://rr1---sn-abc.googlevideo.com/videoplayback?id=1', true],
    ['https://YOUTUBE.COM/watch?v=x', true],
    ['https://WWW.Googlevideo.COM/videoplayback', true],
    ['https://example.com/video.mp4', false],
    ['https://pornhub.com/view_video.php?viewkey=x', false],
    ['', false],
    [null, false],
    [undefined, false],
  ])('classifies %s as %s', (input, expected) => {
    expect(isYouTubeUrl(input)).toBe(expected);
  });
});

describe('getYouTubeVideoId', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ#section', 'dQw4w9WgXcQ'],
    // v= is not the first query param
    ['https://www.youtube.com/watch?list=PLxxxxxxxxxxxxxxxxxxxx&v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/watch?feature=share&v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ?t=42', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/live/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/v/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    // dashes and underscores are legal ID characters
    ['https://www.youtube.com/watch?v=dQw4w9WgXc-', 'dQw4w9WgXc-'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXc_', 'dQw4w9WgXc_'],
    // 11 chars exactly, all legal
    ['https://youtu.be/abcdefghijk', 'abcdefghijk'],
  ])('extracts the video id from %s', (input, expected) => {
    expect(getYouTubeVideoId(input)).toBe(expected);
  });

  it('refuses to truncate a longer token into a bogus 11-char id', () => {
    // The (?![\w-]) guard. Without it, `v=<12 chars>` or a long CDN hash would
    // be silently chopped to 11 characters and re-extracted as a DIFFERENT
    // video - a very confusing failure mode.
    expect(getYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQr')).toBe('');
    expect(getYouTubeVideoId('https://youtu.be/dQw4w9WgXcQr')).toBe('');
    expect(getYouTubeVideoId('https://youtu.be/abcdefghijklmnop')).toBe('');
  });

  it.each([
    ['https://example.com/video.mp4'],
    ['not a url at all'],
    [''],
    [null],
    [undefined],
    [12345],
  ])('returns empty string for non-YouTube input %s', (input) => {
    expect(getYouTubeVideoId(input)).toBe('');
  });

  it('round-trips: isYouTubeUrl + getYouTubeVideoId on every supported shape', () => {
    const urls = [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
      'https://www.youtube.com/live/dQw4w9WgXcQ',
      'https://www.youtube.com/v/dQw4w9WgXcQ',
    ];
    for (const u of urls) {
      expect(isYouTubeUrl(u), `${u} should be recognised as YouTube`).toBe(true);
      expect(getYouTubeVideoId(u), `${u} should yield the id`).toBe('dQw4w9WgXcQ');
    }
  });
});

describe('recoveredYouTubeWatchUrl', () => {
  it('rebuilds a canonical watch page from a docid CDN url', () => {
    expect(
      recoveredYouTubeWatchUrl(
        'https://rr1---sn-abc.googlevideo.com/videoplayback?docid=dQw4w9WgXcQ&expire=1'
      )
    ).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  it('rebuilds from a plain id= CDN url', () => {
    expect(
      recoveredYouTubeWatchUrl(
        'https://rr3---sn-xyz.googlevideo.com/videoplayback?id=dQw4w9WgXcQ&itag=22'
      )
    ).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  it('handles redirector.googlevideo.com', () => {
    expect(
      recoveredYouTubeWatchUrl('https://redirector.googlevideo.com/videoplayback?docid=dQw4w9WgXcQ')
    ).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  it('ignores o- CDN hash ids (they are not video ids)', () => {
    expect(
      recoveredYouTubeWatchUrl('https://rr1---sn-abc.googlevideo.com/videoplayback?id=o-AKaidmBocDE1')
    ).toBe('');
  });

  it('does not touch non-googlevideo urls', () => {
    expect(recoveredYouTubeWatchUrl('https://example.com/video.mp4?docid=dQw4w9WgXcQ')).toBe('');
    // Already-canonical watch pages must pass through untouched.
    expect(recoveredYouTubeWatchUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('');
  });

  it.each([[''], [null], [undefined], ['https://rr1---sn-abc.googlevideo.com/videoplayback']])(
    'returns empty string for %s',
    (input) => {
      expect(recoveredYouTubeWatchUrl(input)).toBe('');
    }
  );

  it('recovers old saved favorites: recovered url is itself a valid YouTube url', () => {
    const dead = 'https://rr5---sn-dead.googlevideo.com/videoplayback?expire=1&id=dQw4w9WgXcQ';
    const recovered = recoveredYouTubeWatchUrl(dead);
    expect(recovered).toBeTruthy();
    // The whole point: the recovered value must survive the other helpers.
    expect(isYouTubeUrl(recovered)).toBe(true);
    expect(getYouTubeVideoId(recovered)).toBe('dQw4w9WgXcQ');
  });
});

describe('pickBestStream', () => {
  it('returns null for empty / non-array input', () => {
    expect(pickBestStream([])).toBeNull();
    expect(pickBestStream(null)).toBeNull();
    expect(pickBestStream(undefined)).toBeNull();
    expect(pickBestStream('not an array')).toBeNull();
  });

  it('prefers the HLS master playlist over progressive mp4', () => {
    expect(
      pickBestStream(['https://cdn/720p.mp4', 'https://cdn/master.m3u8'])
    ).toBe('https://cdn/master.m3u8');
  });

  it('matches the master playlist case-insensitively and by path', () => {
    expect(pickBestStream(['https://cdn/a.mp4', 'https://cdn/MASTER.M3U8'])).toBe(
      'https://cdn/MASTER.M3U8'
    );
    expect(pickBestStream(['https://cdn/a.mp4', 'https://cdn/v4/master.m3u8'])).toBe(
      'https://cdn/v4/master.m3u8'
    );
  });

  it('falls back to the first stream when nothing looks like a master playlist', () => {
    expect(pickBestStream(['https://cdn/720p.mp4', 'https://cdn/1080p.mp4'])).toBe(
      'https://cdn/720p.mp4'
    );
  });

  it('accepts a single-element list', () => {
    expect(pickBestStream(['https://cdn/only.m3u8'])).toBe('https://cdn/only.m3u8');
    expect(pickBestStream(['https://cdn/only.mp4'])).toBe('https://cdn/only.mp4');
  });
});
