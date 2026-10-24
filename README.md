# Matkassa Premium (matkassa-premium)

A duplicate of [Matkassa](https://olecny.github.io/matkassa/) (`../mattilbud-app/`) with **the same features** and a
more premium look and feel, built from Emil Kowalski's design-engineering skills. What changed and why:
[`DESIGN.md`](DESIGN.md).

**Live:** https://olecny.github.io/matkassa-premium/ (compare with https://olecny.github.io/matkassa/)

## Use
- Install: open the link in Safari → Share → *Add to Home Screen* (it is called **Matkassa+**, with a dark icon).
- Everything works as in Matkassa: offers (Tjek, location on first start with Trondheim as the fallback), shopping
  list, spending, sync from your own private data repo, backup.
- **Your data:** Premium has its own storage. In the same browser: Mer → Data → **Hent data fra Matkassa** (a one-way
  copy, without the GitHub token). Between installed iPhone apps: export a backup in one and import it in the other.
- The Mac side (`ingest/`, REMA, weekly sync) lives in the Matkassa repo; both apps sync from the same private repo.

## Run locally / test
```bash
python3 -m http.server 8766      # http://localhost:8766/
node test/unit.test.mjs          # unit tests + isolation + "motion lint" (the never-ship rules from the skills)
node test/e2e.mjs                # headless Chrome 390×844 over CDP, fake network → test/tmp/e2e-report.md
node test/e2e.mjs --live         # the same against real Tjek offers (read-only)
test/privacy.sh                  # no tokens or personal data in this public repo
```
The e2e suite is Matkassa's suite (including the location flow) plus: storage isolation next to a seeded "original"
on the same origin, the one-way copy (no token), sheet drag/flick to dismiss with touch events, reduced motion, the
+ → ✓ morph in place, the toast exit and the scroll-edge bar. All test data is fake and marked `FAKE`.

## Deploy
GitHub Pages from `main` (root) in the public repo `olecny/matkassa-premium` (app code only, no data). When the app
shell changes, bump `VERSION` in `sw.js` and `APP_VERSION` in `js/app.js`.

## Status
0.5.0-premium.1: built and tested headless (unit, e2e fake + live, privacy). Waiting for: Maria's test, and Ole
comparing it with Matkassa on his iPhone.
