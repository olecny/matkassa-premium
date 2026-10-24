# Matkassa Premium: design notes

Same features as [Matkassa](https://olecny.github.io/matkassa/). The look and feel follow Emil Kowalski's
design-engineering skills ([github.com/emilkowalski/skill](https://github.com/emilkowalski/skill), read as reference
only): `emil-design-eng`, `animate`, `apple-design`, `mobile-native`, `find-animation-opportunities`,
`animation-performance`, `review-animations` and `break-ui`. No library was needed. The skills say to use the cheapest
tool that works, and CSS transitions plus a little Pointer Events code cover everything here. There is still no build step.

## Principles applied

| Principle (skill) | Where | Before → after |
|---|---|---|
| Strong custom easing, never `ease-in` (animate, emil-design-eng) | `styles.css` `:root` tokens | Built-in or no easing → `--ease-out (0.23,1,0.32,1)`, `--ease-in-out (0.77,0,0.175,1)`, `--ease-drawer (0.32,0.72,0,1)` used everywhere |
| Durations from the table; UI under 300 ms | all transitions | none → press 160 ms, UI 200 ms, tab indicator 250 ms, sheet 400 ms in / 250 ms out, toast 400 ms (Sonner) |
| Press feedback on `:active` | `.btn`, `.chip`, `.add`, `.icon-btn`, tab icons, receipts, category picks | no feedback → `scale(0.97)` (0.92–0.95 on small round controls), 160 ms ease-out |
| Exit faster than enter (asymmetric timing) | sheets, toast, deleted list rows | instant → sheet in 400 ms on the drawer curve, out 250 ms; toast out 250 ms; row fades out in 160 ms |
| Spatial consistency: leave the way you came | sheets, toast | pop in/out → both slide from and back to the bottom edge |
| Modals are not anchored, so they stay centred | `dialog.sheet` ≥ 600 px | → on wide screens a centred modal scales from 0.96 + fade (never from `scale(0)`) |
| Direct manipulation, flick to dismiss (apple-design §2–3, 9) | `js/motion.js` `enableSheetDrag` | sheets only closed by button → drag the grabber or title: follows the finger 1:1, pointer capture, one finger only, flick > 0.11 px/ms or a third of the height closes, dragging up rubber-bands; release hands off to the CSS transition from the current position |
| Morph state in place, blur bridges the crossfade | `+` button on offers | full list re-render, `+` swapped for `✓` text → same button keeps its node, two SVG icons crossfade with scale 0.6 → 1 and a 2 px blur, background tints |
| Tab indicator: one element moves (state indication) | `.tab-indicator`, `moveTabIndicator` | colour only → a pill slides under the current tab, 250 ms ease-in-out, transform set on the element itself (no inherited CSS variable) |
| Frequency gate: frequent actions barely animate | tab switches, chips, search | tabs only fade in (180 ms opacity, no movement); chips have no motion apart from the press |
| Rare moments may have more presence | first-run "Finn tilbud nær deg" card, new list row | → card arrives with `@starting-style` (8 px, 0.98, 300 ms); the row you just added slides in from the top (250 ms); only that row |
| Show the result, then move (Reminders) | list check-off | row re-sorted at once → round check fills (200 ms), the row moves down after 650 ms |
| Accordion is the one allowed height animation | "+N til" offer details | snaps open → `::details-content` block-size + opacity 200 ms, where supported (`interpolate-size`) |
| Perceived performance | refresh spinner | 1 s → 700 ms per turn |
| Materials and depth (apple-design §12) | top bar, tab bar, toast | flat bars with borders → translucent material `blur(20px) saturate(180%)`; heavier shadow on floating surfaces than on cards |
| Scroll edge, not hard dividers | top bar | permanent border → hairline and compact title only once the large title has scrolled under the bar (IntersectionObserver) |
| iOS large title + size-specific type (apple-design §15) | `h1`, headings, body | 1.6 rem title in a bar → 34 px large title, tracking −0.022 em; 20 px −0.018 em; body −0.011 em; small labels +0.005–0.04 em; SF Display/Text with optical sizing; tabular numbers for all prices and sums |
| Refined colour, shape and space | everywhere | bordered cards → borderless white cards on a warm grouped background, 0.5 px rings and soft shadows; concentric radii (card 20, inner 12, controls 14); fills instead of outlines for inputs and chips; 4-pt spacing; discount badge (−26 %) next to the price |
| Mobile baseline (mobile-native) | `index.html`, `styles.css` | → `-webkit-tap-highlight-color: transparent`, `touch-action: manipulation`, no text selection on controls, 16 px inputs (no zoom), `dvh`, safe areas, `interactive-widget=resizes-content`, `theme-color` per scheme, `overscroll-behavior: contain` on inner scrollers, scroll-snap on "Tilbud for deg" |
| Hover only where hover exists | `styles.css` | → every `:hover` is inside `@media (hover: hover) and (pointer: fine)` (checked by a unit test) |
| Reduced motion = gentler, not zero; reduced transparency; more contrast | `styles.css` end | → no movement (sheets and toast fade, no press scale, spinner pulses); solid bars without blur; stronger separators |
| Only transform/opacity (animation-performance) | all transitions | → no layout properties animated (unit test); no `transition: all`; transforms set on elements directly |
| Break the UI with real data (break-ui) | e2e at 320 px, 3 000 receipts, long Norwegian product names | → `minmax(0, 1fr)` text columns, `overflow-wrap: anywhere`, no sideways scroll at 320 px |

## Deliberately not animated (find-animation-opportunities: restraint)
- **Offer list, search results, chips:** seen many times a day. No stagger and no entrance.
- **Spending numbers and bars:** data you read. Numbers shouldn't move for style.
- **Badge count:** a keyframe pulse on something you can trigger rapidly would restart each time.
- **Keyboard actions** (search, Enter in the list): none.

## Same origin as Matkassa
Both apps live on `olecny.github.io`, so they share IndexedDB, Cache Storage, localStorage and permissions.
**Decision: isolate, plus an explicit one-way copy.**
- Own database `matkassa-premium`, own caches `matkassa-premium-v*` / `matkassa-premium-img`, no localStorage at all.
  Each service worker deletes only caches with its own prefix (Matkassa 0.5.0 was changed to do the same, because its
  old cleanup deleted *every* other cache on the origin). The scopes `/matkassa/` and `/matkassa-premium/` don't overlap.
- **Why not share one database:** two apps with different versions writing one store would sooner or later break
  each other (schema/version changes, `onupgradeneeded`). An A/B comparison also needs to try things in one app without
  changing the other.
- **Mer → Data → "Hent data fra Matkassa"** copies receipts, list, categories, rules and area, read-only from the
  original. It never creates or upgrades the original database, and **never copies the GitHub token**: paste it again
  in Premium (it stays on the device and out of backups, as before). Backups have the same format in both apps.
- Geolocation permission is per origin, so a "yes" in one app counts for the other too.
- On iPhone every home-screen app has its own storage anyway. There the copy button only helps in Safari itself;
  use a backup file to move data between the installed apps.

## What needs a real iPhone
Emulation can't prove these: how the sheet drag feels, the toast's and sheet's feel at 120 Hz, safe areas in the
installed app, the material blur over real photos, and that iOS doesn't zoom any input.
