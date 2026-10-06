// Regression guard for the exact bug class that shipped broken in v1.0.86.
//
// Two distinct failure modes bit that release, and neither is caught by a
// bundler:
//
//   1. DEFINED-BUT-NOT-BOUND. handleTimeUpdate / handleDurationChange /
//      handleEnded existed as useCallback()s but were never attached to the
//      <video>. The build was green; the UI just sat at "0:00 / 0:00" with the
//      progress bar frozen at 0%.
//
//   2. UNDECLARED. togglePlayPause was referenced four times and never
//      declared. The reference sat inside a useCallback dependency array, so it
//      threw ReferenceError *during render* and the whole React tree — the
//      <video> included — never mounted.
//
// These tests read the real source and assert both properties, so a future edit
// cannot silently reintroduce either.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This file is ESM, so `__dirname` is not defined.
const HERE = path.dirname(fileURLToPath(import.meta.url));

const SRC = path.resolve(HERE, '..', '..', 'src', 'components', 'VideoPlayer.jsx');
const source = fs.readFileSync(SRC, 'utf8');

/** Identifiers bound directly to a JSX prop: onXxx={someIdent} */
function jsxHandlerIdents(src) {
  const out = [];
  const re = /\bon[A-Z][A-Za-z0-9]*=\{\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\}/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const line = src.slice(0, m.index).split('\n').length;
    out.push({ prop: m[0].slice(0, m[0].indexOf('=')), ident: m[1], line });
  }
  return out;
}

/** Every identifier declared in the file (any scope). */
function declaredIdents(src) {
  const set = new Set();
  const re = /\b(?:const|let|var|function|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
  let m;
  while ((m = re.exec(src)) !== null) set.add(m[1]);
  // Destructured function params / component props.
  const destructure = /\{([^{}]*)\}\s*=\s*useState|\{([^{}]*)\}\s*=\s*useCallback/g;
  while ((m = destructure.exec(src)) !== null) {
    const body = m[1] || m[2] || '';
    for (const part of body.split(',')) {
      const name = part.split(':').pop().trim();
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) set.add(name);
    }
  }
  return set;
}

/**
 * Extract the full attribute list of a JSX tag.
 *
 * Two traps this has to survive:
 *
 * 1. The file's comments contain prose like "<video> without re-running
 *    yt-dlp". So a bare `<video` match is not enough — a real opening tag is
 *    followed by whitespace and at least one `prop={...}` assignment.
 *    `<video-player` also has to be rejected, hence the explicit lookahead
 *    rather than `\b` (a hyphen is a word boundary).
 *
 * 2. A naive /<video[\s\S]*?>/ stops at the first `>`, which lands INSIDE a JSX
 *    expression such as className={`video-player ${isFullscreen ? 'fullscreen' : ''}`}.
 *    So track brace depth and only treat `>` as the tag terminator at depth 0.
 */
function jsxTag(src, tagName) {
  const open = new RegExp(`<${tagName}(?=[\\s/>])`, 'g');
  let m;
  while ((m = open.exec(src)) !== null) {
    let i = m.index + m[0].length;
    let depth = 0;
    let sawProp = false;
    let end = -1;
    for (let j = i; j < src.length; j += 1) {
      const ch = src[j];
      if (ch === '{') {
        depth += 1;
        sawProp = true;
      } else if (ch === '}') depth -= 1;
      else if (ch === '>' && depth === 0) {
        end = j;
        break;
      }
    }
    if (end === -1) continue;
    const tag = src.slice(m.index, end + 1);
    // Require a genuine prop assignment, which rules out `<video>` in prose.
    if (sawProp && /\b[A-Za-z][A-Za-z0-9-]*=\{/.test(tag)) return tag;
  }
  return null;
}

/** Prop names bound in a JSX tag, whether to a bare ident or an inline arrow. */
function jsxPropNames(tagSrc) {
  const names = new Set();
  const re = /\b(on[A-Z][A-Za-z0-9]*|[a-zA-Z][A-Za-z0-9-]*)=\{/g;
  let m;
  while ((m = re.exec(tagSrc)) !== null) names.add(m[1]);
  return names;
}

/** First tag of the given name whose className contains `classToken`. */
function findJsxTagByClass(src, tagName, classToken) {
  const open = new RegExp(`<${tagName}(?=[\\s/>])`, 'g');
  let m;
  while ((m = open.exec(src)) !== null) {
    let depth = 0;
    for (let j = m.index + m[0].length; j < src.length; j += 1) {
      const ch = src[j];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      else if (ch === '>' && depth === 0) {
        const tag = src.slice(m.index, j + 1);
        if (tag.includes(classToken)) return tag;
        break;
      }
    }
  }
  return null;
}

describe('VideoPlayer.jsx — JSX handler bindings', () => {
  it('binds every bare JSX handler prop to a declared identifier', () => {
    const declared = declaredIdents(source);
    const missing = jsxHandlerIdents(source).filter((h) => !declared.has(h.ident));
    expect(
      missing,
      `JSX handlers referencing undeclared identifiers (these throw ReferenceError at render):\n` +
        missing.map((m) => `  line ${m.line}: ${m.prop}={${m.ident}}`).join('\n')
    ).toEqual([]);
  });

  it('declares togglePlayPause (the v1.0.86 render-crashing ReferenceError)', () => {
    // Guard against the exact regression: referenced but never declared.
    expect(source).toMatch(/\b(?:const|let|var|function)\s+togglePlayPause\b/);
    // ...and it must not be an accidental global read anywhere.
    expect(source).not.toMatch(/^\s*togglePlayPause\s*[;,)]/m);
  });

  it('wires the media events that drive the clock and progress bar', () => {
    // These are the handlers that were defined-but-unbound in v1.0.86. If one
    // of these props goes missing, the timer/progress bar silently freezes.
    const required = [
      'onTimeUpdate',
      'onDurationChange',
      'onEnded',
      'onLoadedMetadata',
      'onError',
      'onPlay',
      'onPause',
      'onLoadedData',
      'onCanPlay',
    ];
    const present = jsxPropNames(jsxTag(source, 'video') || '');
    for (const prop of required) {
      expect(present.has(prop), `<video> is missing ${prop}`).toBe(true);
    }
  });

  it('binds handleTimeUpdate / handleDurationChange / handleEnded to the media element', () => {
    expect(source).toMatch(/onTimeUpdate=\{handleTimeUpdate\}/);
    expect(source).toMatch(/onDurationChange=\{handleDurationChange\}/);
    expect(source).toMatch(/onEnded=\{handleEnded\}/);
  });

  it('does not double-bind play/pause across the video and its container', () => {
    // <video onClick> plus a bubbling container onClick meant every click ran
    // two toggles and cancelled itself out — the play button looked inert.
    const videoTag = jsxTag(source, 'video');
    expect(videoTag, 'no <video> element found').not.toBeNull();
    const videoOnClick = /onClick=\{([A-Za-z_$][A-Za-z0-9_$]*)\}/.exec(videoTag);
    const containerTag = findJsxTagByClass(source, 'div', 'video-player-container');
    const containerOnClick = /onClick=\{([A-Za-z_$][A-Za-z0-9_$]*)\}/.exec(containerTag || '');

    expect(videoOnClick, '<video> has no onClick').not.toBeNull();
    expect(containerOnClick, 'container has no onClick').not.toBeNull();

    if (videoOnClick && containerOnClick) {
      // If both are bound, they MUST be the same handler AND that handler must
      // stop propagation, otherwise the click is counted twice.
      expect(
        videoOnClick[1],
        `<video onClick={${videoOnClick[1]}} bubbles into container onClick={${containerOnClick[1]}}`
      ).toBe(containerOnClick[1]);
      const handlerBody = new RegExp(
        `const\\s+${containerOnClick[1]}\\s*=\\s*useCallback\\(([\\s\\S]*?)\\n\\s*\\},`,
        'm'
      ).exec(source);
      expect(handlerBody, `could not locate ${containerOnClick[1]} body`).not.toBeNull();
      if (handlerBody) {
        expect(handlerBody[1]).toMatch(/stopPropagation/);
      }
    }
  });

  it('reads video.paused before acting, not after', () => {
    // The old togglePlay called play()/pause() and THEN read videoEl.paused to
    // set state, racing the async play() promise.
    const toggle = /const togglePlay = useCallback\(([\s\S]*?)\n\s{2}\}, \[/m.exec(source);
    expect(toggle, 'could not locate togglePlay').not.toBeNull();
    if (toggle) {
      const body = toggle[1];
      const pausedRead = body.indexOf('videoEl.paused');
      const actionIdx = Math.min(
        ...['videoEl.play()', 'videoEl.pause()']
          .map((c) => (body.indexOf(c) === -1 ? Infinity : body.indexOf(c)))
      );
      expect(pausedRead, 'togglePlay never inspects videoEl.paused').toBeGreaterThanOrEqual(0);
      expect(
        pausedRead,
        'togglePlay must sample videoEl.paused BEFORE calling play()/pause()'
      ).toBeLessThan(actionIdx);
    }
  });

  it('never renders an invalid `volume` attribute on <video>', () => {
    // React has no `volume` DOM prop; it leaked into the markup as an unknown
    // attribute. Volume is applied imperatively via the element property.
    const videoTag = jsxTag(source, 'video');
    expect(videoTag).not.toBeNull();
    if (videoTag) {
      expect(videoTag).not.toMatch(/\bvolume=\{/);
    }
  });
});