/**
 * Nekofal Android TV — Spatial (D-Pad) Navigation Engine (v1.0.58)
 *
 * Android TV remotes send ArrowLeft/Right/Up/Down (D-Pad) and DPAD_CENTER
 * (arrives as Enter/Space or virtual keyCode 23/66/160). The WebView does NOT
 * provide automatic spatial navigation like Android's native focus system, so
 * this module implements it:
 *
 *   - Arrow keys: move focus to the geometrically nearest focusable element in
 *     that direction (bounding-box center math, with a perpendicular-distance
 *     penalty so left/right keys don't teleport to rows that merely overlap).
 *   - Enter/Space/DPAD_CENTER: activates the focused element. Native controls
 *     (button/a/input/select/textare) keep their default behavior; plain divs
 *     with role="button"/tabIndex get a dispatched .click().
 *   - Text inputs, textareas and contenteditable are never hijacked: arrows
 *     move the caret, and navigation pauses while one is focused.
 *   - A `tv-focused` class is toggled on the active element so a strong,
 *     visible focus ring shows exactly what the remote is selecting.
 *
 * Enabled automatically when running under Capacitor (mobile) or when the
 * URL/location flag `tv=1` / localStorage `nekofal-tv-nav=1` is set (lets
 * desktop devs simulate). It leaves normal desktop keyboard usage untouched.
 */
(function createSpatialNav() {
  if (typeof window === 'undefined') return;
  if (window.__NEKOFAL_SPATIAL_NAV__) return;
  window.__NEKOFAL_SPATIAL_NAV__ = true;

  const FOCUS_SELECTOR = [
    'a[href]',
    'button:not([disabled])',
    'input:not([type="hidden"]):not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
    '[role="button"][tabindex]',
    '[data-tv-focus]',
  ].join(',');

  // Virtual keycodes used by Android TV remotes for the center/OK button.
  const ACTIVATE_KEYS = new Set(['Enter', ' ', 'NumpadEnter']);
  const ACTIVATE_CODES = new Set([13, 32, 23, 66, 160, 962]); // Enter, Space, DPAD_CENTER, KEYCODE_ENTER, KEYCODE_NUMPAD_ENTER, DPAD_CENTER_ALT

  let enabled = false;
  let lastFocused = null;

  function isEditable(el) {
    if (!el) return false;
    const tag = (el.tagName || '').toLowerCase();
    return (
      tag === 'input' ||
      tag === 'textarea' ||
      tag === 'select' ||
      el.isContentEditable === true
    );
  }

  function isNativeInteractive(el) {
    if (!el) return false;
    const tag = (el.tagName || '').toLowerCase();
    return (
      tag === 'a' ||
      tag === 'button' ||
      tag === 'input' ||
      tag === 'select' ||
      tag === 'textarea' ||
      tag === 'summary' ||
      el.getAttribute && el.getAttribute('contenteditable') === 'true'
    );
  }

  function visible(el) {
    if (!el || !el.getClientRects || !el.getClientRects().length) return false;
    const s = window.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    return true;
  }

  function getFocusables() {
    const nodes = Array.from(document.querySelectorAll(FOCUS_SELECTOR));
    return nodes.filter(visible);
  }

  function center(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, r };
  }

  // Nearest-neighbour pick in `dir` (dx, dy in [-1,0,1]). Candidates must lie
  // in the requested half-plane (dot > 0). Score = perpendicular distance * 2
  // + projected distance, so adjacent same-row/column items win over far or
  // off-axis ones; ties resolve by raw euclidean distance.
  function nearest(cands, cur, dir) {
    if (!cands.length) return null;
    const c0 = center(cur);
    let best = null;
    let bestScore = Infinity;
    for (const c of cands) {
      if (c === cur) continue;
      // Don't skip containment when starting "unfocused" (body) — body contains
      // everything, so a containment check would veto every candidate.
      if (cur !== document.body && (c.contains(cur) || cur.contains(c))) continue;
      const cc = center(c);
      const dx = cc.x - c0.x;
      const dy = cc.y - c0.y;
      const proj = dx * dir.x + dy * dir.y;
      if (proj <= 0.5) continue; // half-plane guard (tiny epsilon for grid jitter)
      const perp = Math.abs(dir.x === 0 ? dx : dy);
      const score = perp * 2 + proj;
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return best;
  }

  function setTvFocus(el) {
    if (lastFocused && lastFocused !== el) lastFocused.classList.remove('tv-focused');
    if (el) {
      el.classList.add('tv-focused');
      lastFocused = el;
    }
  }

  const DIRS = {
    ArrowUp: { x: 0, y: -1 },
    ArrowDown: { x: 0, y: 1 },
    ArrowLeft: { x: -1, y: 0 },
    ArrowRight: { x: 1, y: 0 },
  };

  function onKeyDown(e) {
    // Navigation never steals caret/keys while an editable control is focused.
    const ae = document.activeElement;
    if (isEditable(ae)) return;

    const dir = DIRS[e.key];
    const isActivate = ACTIVATE_KEYS.has(e.key) || ACTIVATE_CODES.has(e.keyCode);

    if (dir) {
      e.preventDefault();
      const start = ae && ae !== document.body ? ae : document.body;
      const cands = getFocusables();
      const next = nearest(cands, start, dir);
      if (next) {
        next.focus();
        setTvFocus(next);
        try {
          next.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
        } catch { /* older engines */ }
      } else if (ae !== document.body) {
        // Nothing in that direction: keep focus where it is.
      }
      return;
    }

    if (isActivate && ae && ae !== document.body && !isNativeInteractive(ae)) {
      // role="button"/tabIndex divs need an explicit click for OK press.
      e.preventDefault();
      ae.click();
      return;
    }
  }

  // Keep the ring attached to whatever currently has focus (mouse clicks too).
  function onFocusIn(e) {
    const t = e.target;
    if (t && t.classList) setTvFocus(t);
  }
  function onFocusOut() {
    if (lastFocused) lastFocused.classList.remove('tv-focused');
    lastFocused = null;
  }

  // Enable when Capacitor native (Android phone/TV) or an explicit flag.
  function evaluateEnabled() {
    try {
      const params = new URLSearchParams(window.location.search);
      const flag =
        window.__NEKOFAL_MOBILE__ === true ||
        localStorage.getItem('nekofal-tv-nav') === '1' ||
        params.get('tv') === '1';
      return !!flag;
    } catch {
      return window.__NEKOFAL_MOBILE__ === true;
    }
  }

  function attach() {
    if (enabled) return;
    enabled = true;
    document.body.setAttribute('data-tv-nav', '1');
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', onFocusOut, true);
    // First D-pad press starts navigation from an explicitly focused element
    // (usually the first visible interactive control) instead of the body.
    requestAnimationFrame(() => {
      const ae = document.activeElement;
      if (!ae || ae === document.body) {
        const first = getFocusables()[0];
        if (first) {
          first.focus();
          setTvFocus(first);
          try {
            first.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          } catch { /* older engines */ }
        }
      }
    });
    if (window.__NEKOFAL_MOBILE__ === true) {
      console.info('[spatialNav] D-Pad spatial navigation enabled (Capacitor native).');
    }
  }

  // Retry until the app root exists; ALSO re-evaluate on route changes (some
  // in-app navigations push URL params, not React Router state that we see).
  if (evaluateEnabled()) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', attach, { once: true });
    } else {
      attach();
    }
  }

  // Re-evaluate later in case the polyfill/mobile flag is set asynchronously.
  setTimeout(() => {
    if (!enabled && evaluateEnabled()) attach();
  }, 800);
})();