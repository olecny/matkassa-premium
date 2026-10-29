// v0.7 Neon figures (DESIGN.md § 3): the Forbruk donut, the Hjem savings meter and the tilting offer cards.
// Plain SVG + CSS + Pointer Events, no library. Only transform, opacity and stroke-dash* are animated; with
// prefers-reduced-motion everything is shown in its final state (CSS turns the transitions off).
// The pure parts (layout, hit-testing, goal steps, best offers) are unit-tested in test/unit.test.mjs.

export const DONUT = Object.freeze({ CX: 100, CY: 100, R: 73, W: 22, GAP: 2, C: 2 * Math.PI * 73 });
export const reducedMotion = () => !!(globalThis.matchMedia && globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Arcs for the values, clockwise from 12 o'clock: {frac, start, len} with a 2 px gap between arcs. */
export function arcLayout(values) {
  const total = values.reduce((a, v) => a + Math.max(0, v), 0);
  let acc = 0;
  return values.map((v) => {
    const frac = total ? Math.max(0, v) / total : 0;
    const start = acc;
    acc += frac;
    return { frac, start, len: Math.max(0, frac * DONUT.C - (frac < 1 ? DONUT.GAP : 0)) };
  });
}
/** stroke-dasharray / stroke-dashoffset for one arc (the circle is rotated -90° so 0 is at the top). */
export const dash = ({ len, start }) => ({ array: `${len.toFixed(2)} ${(DONUT.C - len + 0.01).toFixed(2)}`, offset: (-start * DONUT.C).toFixed(2) });

/** The arc under a point in viewBox coordinates (-1 if none): angle from the centre, clockwise from the top. */
export function arcAt(layout, x, y) {
  let a = Math.atan2(x - DONUT.CX, -(y - DONUT.CY)) / (2 * Math.PI);
  if (a < 0) a += 1;
  return layout.findIndex((s) => s.frac > 0 && a >= s.start && a < s.start + s.frac);
}

/** Savings meter: fill fraction 0–1. */
export const meterFraction = (saved, goal) => (goal > 0 && saved > 0 ? clamp(saved / goal, 0, 1) : 0);
/** The meter's scale (kr at the right end): room above the goal so the "Mål" marker sits ~80 % along. */
export const meterScale = (saved, goal) => Math.ceil((Math.max(goal, saved, 50) * 1.25) / 50) * 50;
/** The goal under a finger at fraction f (0–1) of a meter with that scale: 50 kr steps, within 50–20 000. */
export const goalAt = (f, scale) => clamp(Math.round((clamp(f, 0, 1) * scale) / 50) * 50, 50, 20000);

/** Ids of the best offers (highest discount, at least minDiscount), at most n. */
export function bestOfferIds(items, discountOf, n = 3, minDiscount = 0.2) {
  return new Set(items.map((x) => ({ id: x.o.id, d: discountOf(x.o) })).filter((x) => x.d >= minDiscount)
    .sort((a, b) => b.d - a.d).slice(0, n).map((x) => x.id));
}

/** The tilt transform for a finger at (nx, ny) ∈ [-1, 1]² from the card's centre: max 5°, pressed in a little. */
export const tiltTransform = (nx, ny) => `perspective(700px) rotateX(${(clamp(ny, -1, 1) * -5).toFixed(2)}deg) rotateY(${(clamp(nx, -1, 1) * 5).toFixed(2)}deg) scale(0.985)`;

/**
 * Tilt + parallax on the offer cards. One delegated listener set on the list; only the active card moves.
 * A tilt starts after the finger rests ~120 ms or moves sideways, and gives way at once to vertical scrolling.
 */
export function enableTilt(list) {
  if (!list || list._tilt) return;
  list._tilt = true;
  let st = null;
  let raf = 0;
  const write = () => {
    raf = 0;
    if (!st || !st.on) return;
    st.card.style.transform = tiltTransform(st.nx, st.ny);
    if (st.thumb) st.thumb.style.transform = `translate3d(${(st.nx * 6).toFixed(1)}px, ${(st.ny * 6).toFixed(1)}px, 0)`;
    st.card.style.setProperty('--lx', `${((st.nx + 1) * 50).toFixed(1)}%`);
    st.card.style.setProperty('--ly', `${((st.ny + 1) * 50).toFixed(1)}%`);
  };
  const place = (x, y) => {
    st.nx = clamp((x - (st.r.left + st.r.width / 2)) / (st.r.width / 2), -1, 1);
    st.ny = clamp((y - (st.r.top + st.r.height / 2)) / (st.r.height / 2), -1, 1);
    if (!raf) raf = requestAnimationFrame(write);
  };
  const start = () => {
    if (!st || st.on) return;
    st.on = true;
    st.card.classList.remove('tilt-rest');
    st.card.classList.add('tilting');
    place(st.x, st.y);
  };
  const end = () => {
    if (!st) return;
    clearTimeout(st.timer);
    if (st.on) {
      const { card, thumb } = st;
      card.classList.remove('tilting');
      card.classList.add('tilt-rest');
      card.style.transform = '';
      if (thumb) thumb.style.transform = '';
      const done = () => card.classList.remove('tilt-rest');
      card.addEventListener('transitionend', done, { once: true });
      setTimeout(done, 400);
    }
    st = null;
  };
  list.addEventListener('pointerdown', (e) => {
    if (reducedMotion() || e.button > 0) return;
    const card = e.target.closest('.offer');
    if (!card || e.target.closest('button, a, input, summary')) return;
    end();
    st = { card, thumb: card.querySelector('.thumb'), r: card.getBoundingClientRect(), x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, id: e.pointerId, on: false, nx: 0, ny: 0 };
    st.timer = setTimeout(start, 120);
  });
  list.addEventListener('pointermove', (e) => {
    if (!st || e.pointerId !== st.id) return;
    const dx = e.clientX - st.x0;
    const dy = e.clientY - st.y0;
    st.x = e.clientX;
    st.y = e.clientY;
    if (!st.on) {
      if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) { end(); return; } // the user is scrolling
      if (Math.abs(dx) > 4 && Math.abs(dx) > Math.abs(dy)) start();
      return;
    }
    place(e.clientX, e.clientY);
  });
  for (const t of ['pointerup', 'pointercancel', 'pointerleave', 'lostpointercapture']) list.addEventListener(t, (e) => { if (st && e.pointerId === st.id) end(); });
}

/** The edge shine on the best offers runs once per card per session, when the card scrolls into view. */
const shone = new Set();
let shineObs = null;
export function shineBestOffers(list) {
  if (!list || reducedMotion() || typeof IntersectionObserver === 'undefined') return;
  shineObs = shineObs || new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const id = en.target.dataset.offer;
      shineObs.unobserve(en.target);
      if (shone.has(id)) continue;
      shone.add(id);
      en.target.classList.add('shine');
    }
  }, { threshold: 0.6 });
  for (const card of list.querySelectorAll('.offer.best')) if (!shone.has(card.dataset.offer)) shineObs.observe(card);
}
