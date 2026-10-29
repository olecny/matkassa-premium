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

## v0.7 Neon

*Forslag fra Nora, 2026-10-29. Kun design, ingen kodeendringer. David bygger. All data i eksemplene er FAKE.*

**Retning:** svart og grafitt som bunn, én elektrisk cyan/blå aksent, én varm oransje kun for tilbud og spar, og en fargekodet kategoripalett. Neon er krydder: aksent, store flater og figurer, aldri brødtekst. Lyst tema beholdes og bruker en dypere elektrisk blå, slik at kontrasten holder. Alle kontrastverdier under er regnet med WCAG 2.1-formelen (relativ luminans) i et skript, ikke anslått. Krav: tekst ≥ 4.5:1, grafikk og UI-komponenter ≥ 3:1.

### 1. Fargetokens

Eksisterende navn i `styles.css` beholdes (`--bg`, `--surface`, `--text`, `--accent` osv.), så verdiene kan byttes uten å røre resten. Nye navn er markert med *ny*. Mørkt er standard: `:root` får mørke verdier, og `[data-theme="light"]` / `prefers-color-scheme: light` får de lyse. `color-scheme` følger med.

**Mørkt (standard)**

| Token | Verdi | Rolle |
|---|---|---|
| `--bg` | `#05070A` | Side (nesten svart, svak blåtone, ikke ren `#000`) |
| `--surface` | `#0E1218` | Kort |
| `--surface-2` | `#151B23` | Inni kort, felt, hevet |
| `--fill` / `--fill-strong` | `rgb(140 160 185 / 14%)` / `rgb(140 160 185 / 24%)` | Chips, inputs |
| `--separator` | `rgb(140 160 185 / 16%)` | Skillelinjer |
| `--text` | `#F2F5F8` | Brødtekst |
| `--text-2` | `#B4BDC8` | Sekundær |
| `--text-3` | `#8C97A5` | Hint, etiketter |
| `--accent` | `#00E5FF` | Neon cyan: knapper, aktiv fane, figurer |
| `--accent-ink` | `#00181C` | Tekst på `--accent`-flater |
| `--accent-soft` | `rgb(0 229 255 / 14%)` (≈ `#0C3038` på kort) | Tint bak aksent |
| `--accent-2` *ny* | `#3D7BFF` | Dypere blå, andre stopp i gradient |
| `--sale` | `#FF9A55` | Tilbud/spar (varm oransje) |
| `--sale-soft` | `rgb(255 154 85 / 16%)` (≈ `#352822`) | Tint bak tilbud |
| `--badge` | `#FF7B6B` | Rabattmerke, varsel |
| `--danger` | `#FF8472` | Slett, feil |
| `--focus` | `#00E5FF` | Fokusring |
| `--glow` *ny* | `0 0 24px rgb(0 229 255 / 35%)` | Kun på figurer og primærknapp |
| `--glow-sale` *ny* | `0 0 20px rgb(255 154 85 / 35%)` | Kun beste tilbud og spar-måler |
| `--material` / `--material-tab` | `rgb(5 7 10 / 72%)` / `rgb(14 18 24 / 72%)` | Topp- og fanelinje (blur som før) |
| `--shadow-card` | `0 0 0 0.5px rgb(255 255 255 / 7%)` | Ring i stedet for skygge |
| `--thumb-bg` | `#E9EEF3` | Produktbilder får lys bunn, som i dag |

**Lyst**

| Token | Verdi |
|---|---|
| `--bg` / `--surface` / `--surface-2` | `#F1F4F7` / `#FFFFFF` / `#E9EEF3` |
| `--text` / `--text-2` / `--text-3` | `#0B1016` / `#434F5B` / `#586470` |
| `--accent` / `--accent-ink` | `#0A5CE0` / `#FFFFFF` |
| `--accent-soft` | `rgb(10 92 224 / 10%)` (≈ `#E6EFFC`) |
| `--accent-2` | `#00A3C4` (kun grafikk) |
| `--sale` / `--sale-soft` | `#A8420A` / `rgb(168 66 10 / 12%)` (≈ `#F5E8E2`) |
| `--badge` / `--danger` | `#C62B1D` / `#B3261E` |
| `--glow`, `--glow-sale` | `none` (glød er et mørkt-tema-virkemiddel; lyst får tydeligere ring i stedet) |
| `--shadow-card` | uendret fra v0.6 |

**Kontrast (tekst, WCAG, beregnet)**

| Par | Mørkt | Lyst |
|---|---|---|
| `--text` på `--bg` / `--surface` / `--surface-2` | 18.43 / 17.16 / 15.82 | 17.30 / 19.09 / 16.35 |
| `--text-2` på `--bg` / `--surface` / `--surface-2` | 10.62 / 9.88 / 9.11 | 7.58 / 8.37 / 7.17 |
| `--text-3` på `--bg` / `--surface` / `--surface-2` | 6.80 / 6.34 / 5.84 | 5.48 / 6.05 / 5.18 |
| `--accent` som tekst/lenke på `--bg` / `--surface` / `--surface-2` | 13.11 / 12.21 / 11.26 | 5.25 / 5.80 / 4.97 |
| `--accent-ink` på `--accent` (knapp) | 11.90 | 5.80 |
| `--accent` på `--accent-soft` | 9.13 | 5.00 |
| `--text` på `--accent-soft` | 12.83 | 15.46 |
| `--sale` på `--bg` / `--surface` / `--surface-2` | 9.61 / 8.95 / 8.25 | 5.52 / 6.09 / 5.22 |
| `--sale` på `--sale-soft` | 6.77 | 5.08 |
| `--badge` på `--bg` / `--surface` / `--surface-2` | 7.97 / 7.42 / 6.84 | 5.05 / 5.58 / 4.78 |
| `--danger` på `--bg` / `--surface` / `--surface-2` | 8.45 / 7.86 / 7.25 | 5.92 / 6.54 / 5.60 |

Alle par er ≥ 4.5:1. Svakeste lyse par er `--badge` på `--surface-2` (4.78); bruk merket helst på `--surface`. Neon-cyan `#00E5FF` brukes i mørkt som tekst bare i korte etiketter og lenker (kontrast over 11:1), men aldri i brødtekst. I lyst tema er aksenten mørkere nettopp av kontrasthensyn. `#00E5FF` på hvit ville gitt kun omtrent 1.3:1, så den brukes aldri på lyst.

**Kategorifarger (10)** (figurer, prikker, kantlinjer; mørk mot `--surface`, lys mot `--surface`; grafikkkrav 3:1 er oppfylt med stor margin)

| Kategori | `--cat-*` mørk | Kontrast | `--cat-*` lys | Kontrast |
|---|---|---|---|---|
| meieri | `#7CB8FF` | 9.08 | `#1F6FD1` | 4.94 |
| kjott | `#FF6F7D` | 6.99 | `#C7283C` | 5.53 |
| frukt | `#F2E35B` | 14.23 | `#7D6B00` | 5.28 |
| brod | `#E0A96D` | 9.00 | `#8A5A24` | 5.88 |
| torr | `#B7A6FF` | 8.86 | `#6A4FD6` | 5.67 |
| snacks | `#FF7EDB` | 8.28 | `#B8228F` | 5.73 |
| drikke | `#35E0C2` | 11.26 | `#00796B` | 5.32 |
| frossen | `#9BE8FF` | 13.75 | `#00799A` | 5.00 |
| hus | `#9AD65A` | 10.86 | `#4B7A0F` | 5.13 |
| annet | `#98A2B3` | 7.29 | `#5F6B7A` | 5.43 |

Frukt er bevisst gul, slik at den ikke forveksles med `--sale` (oransje). Meieri og frossen er begge kalde blåtoner. Skille dem alltid med etikett og to piksler mellomrom mellom buer, aldri med farge alene. Tekst som skal stå ved en kategori bruker `--text`/`--text-2`, ikke kategorifargen. Fargene kobles til eksisterende `--c` på `.dot`. Brukerens egne kategorier med egen farge (fargevelgeren i Mer) beholder den.

### 2. Typografi og flater

- **Skrift:** uendret systemskrift (SF), samme størrelsestabell og tracking som v0.6. Tall (priser, summer, måler) i `font-variant-numeric: tabular-nums`. Store tall i figurene bruker `--font-display` 600 på 34 px og −0.022 em. Ingen ny webfont, siden den ville kostet en ekstra last og FOUT.
- **Hierarki i mørkt:** vekt og lysstyrke, ikke størrelse. `--text` for det som leses, `--text-2` for støtte, `--text-3` for etiketter. Etiketter (store bokstaver ikke nødvendig) 12 px, +0.04 em.
- **Høyde uten skygger:** i mørkt UI synes ikke skygge. Høyde vises med lysere flate: `--bg` (0) → `--surface` (1) → `--surface-2` (2) → flytende ark `#1A212B` (3), pluss en 0.5 px ring `rgb(255 255 255 / 7%)` og, på det øverste nivået, en `inset 0 1px 0 rgb(255 255 255 / 6%)` som fanger lys fra oversiden. Flytende ark beholder en dyp skygge (`0 12px 40px rgb(0 0 0 / 60%)`).
- **Kanter:** hårfin ring, ikke tykk outline. Aktive/valgte elementer får `--accent` som 1 px ring (`box-shadow: 0 0 0 1px var(--accent)`), ikke fylt neon-kasse.
- **Glød (billig, men ikke billig-utseende):** maks tre steder i hele appen: (1) primærknapp (`--glow`, svak), (2) figurene under, (3) beste tilbud (`--glow-sale`). Glød er alltid en myk, stor radius ved lav alfa (≤ 35 %), aldri en hard `text-shadow` rundt tekst. Fargen på gløden er samme farge som elementet.
- **Primærknapp:** flat `--accent`-fylling med `--accent-ink`-tekst, overgang til `--accent-2` nederst (`linear-gradient(180deg, #00E5FF, #00C8E8)`). Trykk: scale 0.97 som før.
- **Aktiv fane:** indikator-pillen er `--accent-soft` med ikonet i `--accent` (13:1). Ingen glød.
- **Bakgrunn:** helt flat. Én unntakelse: Hjem kan ha en radial `rgb(0 229 255 / 6%)` bak spar-måleren (statisk, ikke animert).
- **Lyst tema:** samme struktur, hvite kort på kjølig grå bunn, aksent `#0A5CE0`. Figurene får samme form, uten glød.

### 3. Tre interaktive figurer

Felles: ren SVG + CSS + litt JS (Pointer Events), ingen bibliotek. Animer bare `transform`, `opacity` og `stroke-dashoffset` / `stroke-dasharray` (kompositor- og SVG-trygt; ingen layout). Bruk eksisterende easing-tokens. Hver figur har `role="img"` (eller `role="group"` hvis interaktiv med barn), en `aria-label` og en skjult tabell/liste som alternativ. Målt mot 390×844 og 60 fps; hold DOM under ca. 40 noder per figur.

#### (a) Forbruk: kategori-smultring (donut)

- **Form:** SVG `viewBox="0 0 200 200"`, ytre radius 84, tykkelse 22, 10 buer som `<circle>` med `stroke-dasharray` (hver bue = én kategori, `stroke="var(--cat-x)"`, `fill="none"`, `stroke-linecap="butt"`), 2 px mellomrom mellom buer. Senter: valgt kategori (navn, kr, % av måned) eller «Totalt» med månedssum i 34 px tabellsiffer. Under figuren ligger en forklaring (liste av prikk + navn + kr) som også er tappbar; 44 px høye rader.
- **Eksempel (FAKE, mars):** Totalt 4 120 kr; meieri 610, kjott 940, frukt 480, brod 260, torr 520, snacks 330, drikke 280, frossen 300, hus 240, annet 160.
- **Interaksjon:**
  - Trykk på en bue eller en forklaringsrad velger den: buen vokser (`stroke-width` 22 → 28 gjøres med `transform: scale(1.06)` på `<g>` rundt buen, `transform-origin: 100px 100px`), de andre går til `opacity: .35`, og senteret bytter tall. Trykk igjen eller utenfor fjerner valget. Treffflate: usynlig bred stroke (36) på samme bue.
  - Dra: `pointerdown` på smultringen + `pointermove` regner vinkel `atan2` fra sentrum og velger buen under fingeren (scrubbing). Fingeren holder pointer capture; `touch-action: pan-y` på SVG, slik at vertikal scrolling ikke blokkeres, og dragmodus startes først etter 6 px horisontal bevegelse. Haptikk der støttet: `navigator.vibrate?.(8)` når buen skifter (ikke på iOS, ingen feil).
  - Månedsbytte (piler eller sveip): buene animerer fra gamle til nye lengder. Hver bue har `stroke-dasharray: len gap` og `stroke-dashoffset` for startvinkel; JS setter nye verdier, CSS transisjon `stroke-dasharray 450ms var(--ease-out), stroke-dashoffset 450ms var(--ease-out)`. Senterets tall teller ikke opp (tall du leser skal ikke bevege seg, jf. tidligere beslutning); det krysstoner på 150 ms. Første visning: buene tegnes inn med 600 ms ease-out, forskjøvet 30 ms per bue (rare øyeblikk får mer tilstedeværelse), kun første gang per økt.
  - Valgt kategori åpner ikke noe nytt; «Se kvitteringer» ligger som en knapp i senteret/under, som filtrerer listen under figuren.
- **Redusert bevegelse:** ingen innritingsanimasjon, ingen skalering. Valg vises med opasitet og en 2 px `--text`-ring rundt valgt bue. Månedsbytte krysstoner (150 ms) i stedet for å morfe.
- **Tilgjengelighet:** `role="group"` med `aria-label="Forbruk mars: 4 120 kroner fordelt på 10 kategorier"`. Hver bue er `role="button"` med `tabindex="0"` og `aria-pressed`, `aria-label="Kjøtt: 940 kroner, 23 prosent"`. Piltaster flytter valg mellom buer, Enter/Space velger, Escape fjerner. Legenden under fungerer som tekstalternativ. Månedsbytte annonseres via `aria-live="polite"` («Februar: 3 880 kroner»).
- **Ytelse:** 10 `<circle>`, 1 SVG. Under drag oppdateres bare `class`/`opacity` på buer og én tekstnode, med `requestAnimationFrame` og vinkelkalkulasjon uten `getBoundingClientRect` per hendelse (cache ved `pointerdown`). Ingen `filter: drop-shadow` på buer (dyrt); glød på valgt bue gjøres med en duplisert, uskarp `<circle>` kun for valgt bue (`opacity .5`, statisk blur-ferdig i form av bredere stroke ved lav alfa, ingen `filter`).

#### (b) Hjem: spar-måler med glødefyll

- **Form:** halvsirkel-måler (270°-bue) eller horisontal stav; forslag: stav, 100 % bredde minus gutter, 14 px høy, `border-radius: 7px`, spor `--fill`. Over staven: stort tall «312 kr spart» (34 px, `--text`) og undertekst «av 500 kr mål denne måneden» (`--text-2`). (FAKE-tall.)
- **Fyll:** `--sale` til `--accent` gradient er forbudt (to varme/kalde aksenter i ett element ser rotete ut); fyllet er `linear-gradient(90deg, var(--sale), #FFC27A)` med `--glow-sale` under (`box-shadow` på et eget, fast, uanimert lag). Lite lysende kant i enden av fyllet (6 px bred, `rgb(255 255 255 / 55%)`) gir følelse av «energi» uten partikler.
- **Implementering:** fyllet er et element med `transform: scaleX(p)` og `transform-origin: left` (ikke `width`). Gløden ligger på et overordnet element med `clip-path` / egen bredde-uavhengig skygge slik at den ikke skaleres med fyllet. Endekappen er egen liten `div` som flyttes med `translateX(p * trackWidth)`.
- **Animasjon:** ved første visning av Hjem per økt: fyll 0 → p over 700 ms `--ease-out`. Ved ny verdi (ny kvittering eller bytte av måned): 450 ms `--ease-out`. Tall krysstoner (150 ms), ikke tell-opp. Når målet passeres: én enkelt «puls» på gløden (opasitet 0.35 → 0.7 → 0.35, 600 ms, én gang), ingen konfetti.
- **Interaksjon:** trykk viser hva som utgjør summen (liste av tilbud brukt, «Kiwi: 3 varer, 84 kr»). Dra på staven justerer *målet* (ikke verdien) i trinn på 50 kr, med pointer capture; tallet «av 500 kr» oppdateres direkte uten animasjon, og verdien lagres ved slipp. Trykkflate: hele raden, minst 44 px høy (staven får usynlig padding).
- **Redusert bevegelse:** fyllet vises direkte i sluttposisjon, uten puls. Endring krysstoner kun på tallet.
- **Tilgjengelighet:** `role="meter"` med `aria-valuenow="312"`, `aria-valuemin="0"`, `aria-valuemax="500"`, `aria-valuetext="312 kroner spart av et mål på 500 kroner"` og `aria-label="Spart denne måneden"`. Målet kan justeres med piltaster (50 kr per trykk) via `role="slider"` på et eget håndtak, ikke på måleren.
- **Ytelse:** to elementer som animeres, kun `transform`. Gløden er statisk og promoteres ikke (ingen `will-change` permanent; sett det kun mens animasjonen går, fjern på `transitionend`). Ingen `filter: blur` animert.

#### (c) Tilbud: kort med tilt/parallakse og glødekant

- **Hvilke kort:** alle tilbudskort får tilt; kun de beste (høyeste rabatt, f.eks. topp 3 eller rabatt ≥ 30 %, maks 3 synlige samtidig) får glødekant. Kortet beholder dagens layout (bilde, navn, pris, rabattmerke).
- **Tilt:** ved `pointerdown`/`pointermove` på kortet (touch og mus) regnes posisjonen relativt til midten, `nx, ny ∈ [-1, 1]`. Kortet får `transform: perspective(700px) rotateX(calc(ny * -5deg)) rotateY(calc(nx * 5deg)) scale(0.985)`. Produktbildet flyttes motsatt retning (`translate3d(nx * 6px, ny * 6px, 0)`) for parallakse. Maks 5° tilt og 6 px forskyvning, slik at det blir diskré. Slipp: tilbake til hvile med 350 ms `--ease-out`. Under bevegelse følger kortet fingeren uten transisjon (1:1; set via rAF). Et svakt lysfelt (radial gradient, `opacity 0.10`) følger fingeren på overflaten.
- **Konflikt med scroll:** `touch-action: pan-y`; tilt aktiveres bare når fingeren har stått stille i ca. 120 ms eller beveger seg mer horisontalt enn vertikalt, og avbrytes straks vertikal scroll tar over (`pointercancel`). Tilt skal aldri hindre scrolling i listen. Tilt og knappene («+», legg i liste) er adskilt: trykk på knapper utløser ikke tilt, og trykk på «+» beholder dagens morf.
- **Glødekant (beste tilbud):** kantlinje i `--sale` på 1 px med `--glow-sale` ved lav alfa (mørkt). Statisk ring, pluss ett lysglimt som reiser langs kanten én gang når kortet kommer inn i bildet (IntersectionObserver, 900 ms, `--ease-in-out`, løses med en `conic-gradient`-maske på et pseudoelement som roterer med `transform: rotate`, ikke ved å animere gradient-vinkelen). Glimtet spilles bare første gang per kort per økt. I lyst tema: 1.5 px `--sale`-ring uten glød.
- **Redusert bevegelse:** ingen tilt, ingen parallakse, ingen glimt. Beste tilbud beholder den statiske `--sale`-kanten og en liten «Beste pris»-etikett, slik at informasjonen ikke ligger i bevegelsen alene.
- **Tilgjengelighet:** tilt er ren dekor (`aria-hidden` på lysfeltet). Beste tilbud får synlig tekst «Beste tilbud» (ikke bare glød) og kortets `aria-label` blir f.eks. «Tine Lettmelk 1 l, 14,90 kr, minus 32 prosent, beste tilbud, Kiwi» (FAKE). Fokus (tastatur) gir `--focus`-ring og samme lille tilt-hvile, ingen tilt.
- **Ytelse:** bare ett kort tilter om gangen (aktivt kort), og bare `transform`/`opacity`. `will-change: transform` settes ved `pointerdown` og fjernes ved slipp. Maks 3 glødekort i viewport; glimtet bruker ett pseudoelement per kort og stoppes etter ett omløp. Listen har ikke tilt-lyttere på hvert kort: bruk én delegert `pointermove` på containeren, og skriv til det aktive kortet i rAF. Ingen `backdrop-filter` på kort.

### 4. Ikon og manifest

| Felt | Verdi |
|---|---|
| `theme_color` | `#05070A` |
| `background_color` | `#05070A` |
| `<meta name="theme-color">` | mørk `#05070A`, lys `#F1F4F7` (som i dag, bare ny verdi) |
| Ikonbakgrunn | `#05070A`, med en svak radial `#0C3038` bak symbolet |
| Ikonsymbol | handlekurv/pose i `#00E5FF`, 1 px lysere kant, én liten oransje `#FF9A55` prikk (tilbud). Ingen tekst |
| Maskable | symbolet innenfor sentrale 60 % av flaten, bakgrunnen fyller helt ut |
| Apple touch icon | samme motiv, opak bakgrunn (iOS beskjærer selv) |
| Splash | `#05070A` flat, ingen animasjon |

Kontrastsjekk ikon: `#00E5FF` på `#05070A` = 13.11:1.

### 5. Ikke gjør dette

- Ingen neon som brødtekst, i avsnitt, i lenker midt i tekst eller i små etiketter på lyst tema.
- Ingen glød på alt: bare primærknapp, figurene og de beste tilbudene. Glød på hvert kort gjør at ingenting skiller seg ut.
- Ingen hard `text-shadow` eller neon-outline rundt tekst.
- Ingen ren `#000` i flater over bunnen og ingen ren `#fff` tekst på svart: bruk `--surface`-trappa og `--text`.
- Ingen fargekoding uten etikett: kategori og «beste tilbud» må også stå som tekst.
- Ingen gradient mellom `--sale` og `--accent` i samme element.
- Ingen tell-opp-animasjon på tall man leser, ingen konfetti, ingen partikler.
- Ingen animert `filter: blur`, `box-shadow`, `width` eller `height`; ingen `backdrop-filter` på kort.
- Ikke fjern lyst tema eller `prefers-reduced-motion`-reglene: figurene må fungere statisk.
- Ikke la figurene stjele scroll: `touch-action: pan-y`, og avbryt ved vertikal bevegelse.
- Ingen ekte forbruks- eller kvitteringsdata i eksempler, skjermbilder eller tester: bruk FAKE-data.

### Kontrasttest

Tallene over er regnet med WCAG-formelen i `/private/tmp/claude-502/-Users-OleChristian-Ole-Storage-Claude/7046fd42-b7a6-4e6a-9d9a-b0d719d5ca43/scratchpad/c.py`. David bør legge en enhetstest (samme formel) på alle token-par i `styles.css` når verdiene er byttet inn, slik at en senere fargejustering ikke ødelegger kontrasten.
