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
- **Hjem** (first tab): this month's spending against the same days last month, top categories, a 6-month mini trend,
  up to 4 open list items with offer badges and a compact "Tilbud for deg" row, in Premium's own style (a short,
  staggered rise once per visit; a fade only with reduced motion).
- **Account (optional):** the same Supabase account and project as Matkassa (`js/cloud.js`, `js/cloud-config.js`).
  "Logg inn" shows in Mer only when the config is filled in; without it everything stays on the device. Setup for
  Ole: `../mattilbud-app/SUPABASE.md`. The schema and RLS test are copied here (`supabase/`, `test/rls.sh`) and must
  stay identical to Matkassa's; the Edge Functions live only in the Matkassa repo.
- **Imports:** Trumf innsyn (JSON), Coop innsyn (CSV/JSON, guessed format), `spending.json`, backup. The same purchase
  from two sources is kept once.
- The Mac side (`ingest/`: REMA, Trumf, upload to the account, weekly sync) lives in the Matkassa repo.
- **Koble til REMA** (Mer → Kjeder, v0.7): on the Mac the button talks to the local helper
  (`../mattilbud-app/ingest/helper.py`, 127.0.0.1 only, paired once with a code) which opens REMA's own login in the
  browser and runs the sync; on a phone it says "Gjøres fra Mac-en". The chain connection is a module with a swappable
  login provider (`js/chains/index.js`: interface, `mac-helper.js`, `rema.js`), so a later iOS app only adds a provider.
  `js/chains/` is identical in both apps.

## Run locally / test
```bash
python3 -m http.server 8766      # http://localhost:8766/
node test/unit.test.mjs          # unit tests + isolation + "motion lint" (the never-ship rules from the skills)
node test/e2e.mjs                # headless Chrome 390×844 over CDP, fake network → test/tmp/e2e-report.md
node test/e2e.mjs --live         # the same against real Tjek offers (read-only)
test/privacy.sh                  # no tokens or personal data in this public repo
test/rls.sh                      # Supabase schema + RLS + FAKE seed (twice) on a throwaway local Postgres (brew install postgresql@17)
```
The e2e suite is Matkassa's suite (including the location flow) plus: storage isolation next to a seeded "original"
on the same origin, the one-way copy (no token), sheet drag/flick to dismiss with touch events, reduced motion, the
+ → ✓ morph in place, the toast exit and the scroll-edge bar. All test data is fake and marked `FAKE`.

## Deploy
GitHub Pages from `main` (root) in the public repo `olecny/matkassa-premium` (app code only, no data). When the app
shell changes, bump `VERSION` in `sw.js` and `APP_VERSION` in `js/app.js`.

## Status
0.6.0-premium.1: Hjem, optional account + two-way sync (tested against a fake Supabase in e2e, RLS on local Postgres),
Coop import, cross-source dedupe, and Maria's 0.5 findings (release velocity over ~100 ms, FLIP check-off, 16 px
inputs, large-text layout). Waiting for: Ole's Supabase project, Maria's test, Ole comparing on his iPhone.
