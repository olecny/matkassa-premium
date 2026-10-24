// Motion and native feel for Matkassa Premium. Plain CSS does most of it (see styles.css: transitions,
// @starting-style, the --ease-* tokens). This file only does what CSS can't: following a finger, the scroll edge
// of the top bar, the tab indicator, and the few exits that need to finish before the DOM changes.
// Principles: DESIGN.md. No library: CSS transitions with the drawer curve settle the sheet well enough.

export const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';
export const EASE_IN_OUT = 'cubic-bezier(0.77, 0, 0.175, 1)';
export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Apple's rubber band: the further past the edge, the less the element follows. */
export function rubberband(overshoot, dimension, constant = 0.55) {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

/** Should a sheet close when released? A flick is enough; a slow drag has to pass about a third of the height. */
export function shouldDismiss(distance, velocity, height) {
  return distance > 0 && (distance > height * 0.35 || (velocity > 0.11 && distance > 12));
}

/**
 * Release velocity in px/ms from recent pointer samples [{t, y}]: the movement over the last ~100 ms, not just the
 * last two events (one jittery event must not turn a slow drag into a flick). A finger that stopped more than
 * 80 ms before lifting has no velocity, however fast it moved before.
 */
export function releaseVelocity(samples, now, window = 100, stale = 80) {
  if (!samples.length || now - samples[samples.length - 1].t > stale) return 0;
  const last = samples[samples.length - 1];
  // Anchor on the newest sample at least `window` old (or the oldest we have), so the span is ~100 ms, never 2 events.
  let first = samples[0];
  for (const s of samples) if (last.t - s.t >= window) first = s;
  return last.t > first.t ? (last.y - first.y) / (last.t - first.t) : 0;
}

/**
 * Drag a bottom sheet down to close it. Starts on the grabber or the sheet's heading (never inside a form field or a
 * scrolling list, so typing and scrolling stay normal). Tracks the finger 1:1 from where it grabbed, captures the
 * pointer, ignores extra fingers, rubber-bands upwards, and on release either closes (CSS exit transition from the
 * current position) or snaps back with the drawer curve.
 */
export function enableSheetDrag(dlg) {
  let pid = null;
  let startY = 0;
  let samples = [];
  let dy = 0;
  dlg.addEventListener('pointerdown', (e) => {
    if (pid !== null || !dlg.open || (e.pointerType === 'mouse' && e.button !== 0)) return; // one finger only
    if (!e.target.closest('.grabber, h2')) return;
    pid = e.pointerId;
    try { dlg.setPointerCapture(pid); } catch (err) { /* synthetic events */ }
    startY = e.clientY;
    samples = [{ t: performance.now(), y: e.clientY }];
    dy = 0;
    dlg.classList.add('dragging');
  });
  dlg.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pid) return;
    const now = performance.now();
    samples.push({ t: now, y: e.clientY });
    if (samples.length > 20) samples.shift();
    const raw = e.clientY - startY;
    dy = raw >= 0 ? raw : -rubberband(-raw, dlg.offsetHeight);
    dlg.style.transform = `translateY(${dy}px)`; // on the element itself, not via an inherited CSS variable
  });
  const end = (e) => {
    if (e.pointerId !== pid) return;
    pid = null;
    dlg.classList.remove('dragging');
    const close = shouldDismiss(dy, releaseVelocity(samples, performance.now()), dlg.offsetHeight);
    dlg.style.transform = ''; // the CSS transition now runs from the finger's position: back up, or out on close
    if (close) dlg.close();
  };
  dlg.addEventListener('pointerup', end);
  dlg.addEventListener('pointercancel', end);
}

/** Hairline + small title in the top bar once the large title has scrolled under it (iOS large-title pattern). */
export function watchLargeTitle(largeTitle, bar) {
  if (!('IntersectionObserver' in window)) { bar.classList.add('scrolled'); return; }
  const io = new IntersectionObserver(([entry]) => bar.classList.toggle('scrolled', !entry.isIntersecting), {
    rootMargin: `-${bar.offsetHeight}px 0px 0px 0px`,
    threshold: 0,
  });
  io.observe(largeTitle.querySelector('h1'));
}

/** Slide the tab indicator under the current tab. Transform is set on the indicator itself. */
export function moveTabIndicator(indicator, index) {
  if (indicator) indicator.style.transform = `translateX(${index * 100}%)`;
}

/**
 * FLIP: re-render a list, then let rows that moved glide from their old place to the new one (on-screen movement:
 * ease-in-out, 300 ms, transform only). With reduced motion the rows simply appear in their new place.
 */
export function flip(container, render, key = 'item') {
  const before = new Map();
  for (const el of container.querySelectorAll(`[data-${key}]`)) before.set(el.dataset[key], el.getBoundingClientRect().top);
  render();
  if (reducedMotion() || !container.animate) return;
  for (const el of container.querySelectorAll(`[data-${key}]`)) {
    const was = before.get(el.dataset[key]);
    if (was == null) continue;
    const dy = was - el.getBoundingClientRect().top;
    if (Math.abs(dy) < 1) continue;
    el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 300, easing: EASE_IN_OUT });
  }
}

/** Fade a list row out before it is removed (exit faster than enter). Resolves at once with reduced motion. */
export function exitRow(el) {
  if (!el || !el.animate || reducedMotion()) return Promise.resolve();
  return el.animate(
    [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.97)' }],
    { duration: 160, easing: EASE_OUT, fill: 'forwards' },
  ).finished.catch(() => {});
}
