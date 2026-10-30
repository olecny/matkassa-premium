// Categories, the Norwegian keyword map, the rule engine and word matching (search + shopping list).
// Tjek gives no categories, so offers and receipt lines are classified here.

// Muted palette: one saturation/lightness family, so no colour shouts. Order = the walk through a typical store
// (used to group the shopping list).
export const DEFAULT_CATEGORIES = [
  { id: 'frukt', name: 'Frukt/grønt', color: '#5f9a6e' },
  { id: 'brod', name: 'Brød/bakst', color: '#b8955a' },
  { id: 'kjott', name: 'Kjøtt', color: '#b56a5e' },
  { id: 'fisk', name: 'Fisk', color: '#5a8aa6' },
  { id: 'palegg', name: 'Pålegg', color: '#c08468' },
  { id: 'meieri', name: 'Meieri', color: '#6d8fc0' },
  { id: 'ferdigmat', name: 'Ferdigmat', color: '#a5806a' },
  { id: 'frossen', name: 'Frossen', color: '#7d7bbd' },
  { id: 'torr', name: 'Tørrvarer', color: '#b38c62' },
  { id: 'snacks', name: 'Snacks/godteri', color: '#b97a96' },
  { id: 'drikke', name: 'Drikke', color: '#5a9a92' },
  { id: 'hus', name: 'Husholdning', color: '#7f8b98' },
  { id: 'dyremat', name: 'Dyremat', color: '#9a9070' },
  { id: 'ikkemat', name: 'Ikke-mat', color: '#8e8e93' },
  { id: 'annet', name: 'Annet', color: '#a3a39b' },
];
/** Categories that are not food: hidden by "Kun mat", and never offered for a food item on the shopping list. */
export const NON_FOOD = new Set(['hus', 'dyremat', 'ikkemat']);
export const CATEGORY_VERSION = 2;

// Colours the first version shipped with: an untouched category gets the new muted colour.
const OLD_COLORS = {
  meieri: '#2a78d6', kjott: '#e34948', frukt: '#008300', brod: '#eda100', torr: '#eb6834', snacks: '#e87ba4',
  drikke: '#1baf7a', frossen: '#6250d6', hus: '#5f7186', annet: '#8a8a85',
};

/**
 * Bring a stored category list up to version 2 (once): "Kjøtt/fisk" becomes "Kjøtt", the new categories (Fisk,
 * Pålegg, Ferdigmat, Dyremat, Ikke-mat) are added, and colours the user never changed become the muted ones.
 * User-made categories, names and colours are kept. Pure.
 */
export function migrateCategories(stored) {
  if (!Array.isArray(stored) || !stored.length) return DEFAULT_CATEGORIES.map((c) => ({ ...c }));
  const out = stored.map((c) => ({ ...c }));
  for (const c of out) {
    if (c.id === 'kjott' && c.name === 'Kjøtt/fisk') c.name = 'Kjøtt';
    const def = DEFAULT_CATEGORIES.find((d) => d.id === c.id);
    if (def && OLD_COLORS[c.id] && String(c.color).toLowerCase() === OLD_COLORS[c.id]) c.color = def.color;
  }
  const ids = new Set(out.map((c) => c.id));
  for (const [i, d] of DEFAULT_CATEGORIES.entries()) {
    if (ids.has(d.id)) continue;
    // insert after the nearest default that comes before it, so the store order holds
    let at = out.length;
    for (let j = i - 1; j >= 0; j--) {
      const k = out.findIndex((c) => c.id === DEFAULT_CATEGORIES[j].id);
      if (k >= 0) { at = k + 1; break; }
    }
    out.splice(at, 0, { ...d });
    ids.add(d.id);
  }
  // Never reordered (the defaults still come in the first version's order): use the new store order.
  const was = stored.filter((c) => c && OLD_ORDER.includes(c.id)).map((c) => c.id);
  if (was.join() !== OLD_ORDER.filter((id) => was.includes(id)).join()) return out;
  const isDef = (c) => DEFAULT_CATEGORIES.some((d) => d.id === c.id);
  const sorted = DEFAULT_CATEGORIES.map((d) => out.find((c) => c.id === d.id)).filter(Boolean);
  // a category the user made stays right after the default it followed
  out.forEach((c, i) => {
    if (isDef(c)) return;
    const prev = out.slice(0, i).reverse().find(isDef);
    const at = prev ? sorted.findIndex((x) => x.id === prev.id) + 1 : 0;
    let k = at;
    while (k < sorted.length && !isDef(sorted[k])) k++; // after earlier custom ones in the same spot
    sorted.splice(k, 0, c);
  });
  return sorted;
}
const OLD_ORDER = ['meieri', 'kjott', 'frukt', 'brod', 'torr', 'snacks', 'drikke', 'frossen', 'hus', 'annet'];

/*
 * Keyword map, in tiers. A product is classified by the first tier that has a hit, so what a product IS beats what
 * it tastes of: "Dreamies laks og kylling" is pet food (tier 0) before kylling/laks (tier 2) are looked at;
 * "Iste fersken" is a drink (tier 1) before fersken (tier 2); "Nudler m/kyllingsmak" is dry goods, not meat.
 * Tier 3 is brand-only fallbacks ("Gilde" alone = meat).
 * Inside a tier: a whole word or phrase beats the end of a compound (Norwegian compounds put the head last:
 * "gulrotkake" is a cake), which beats the start of one; then the longer keyword wins.
 * Syntax: plain = whole word, start or end of a compound; "=kw" whole word only; "kw*" whole word or start;
 * "*kw" whole word or end; "a_b" = the phrase "a b".
 */
const TIERS = [
  { // 0: what the thing is, whatever it is made of or tastes of
    dyremat: `dreamies sheba whiskas cesar felix purina =gourmet gourmet_gold gourmet_perle pedigree frolic =latz
      kattemat hundemat kattegodt hundegodt kattesnacks hundesnacks katte* hunde* dyremat dyrefôr dyrefor =katt =hund
      =katter =hunder til_katt til_hund for_katt for_hund tyggepinner tyggeben tyggeknute dentastix schmackos
      fuglefrø fuglemat meiseboller meisebolle menybokser`,
    ikkemat: `sokker *sokker =sokk *sokk strømper =roser =rose rosemiks rosebukett julerose *bukett blomster
      tulipaner azalea chrysanthemum hyperikum calluna potteplante julestjerne orkide gravkrans* =leker =leke leketøy
      hot_wheels lego barbie kleshenger* =hengere utskjæringssett glow_sticks lysslynge lyspære* =lue =luer votter
      vanter hansker *jakke =jakke *bukse =bukse *dress =dress vintersko =sko tøfler pyjamas parkas fleece* håndkle*
      =pute dyne sengetøy kjøkkenredskap* stekepanne* kaffetrakter* stavmikser* airfryer* støvsuger*
      robotstøvsuger =robot gavepapir =tape =briller =bøker bøøker =bok tegneserie tubalighter =lighter
      =batteri =battery *sko barnesko joggesko sandaler *sandaler *støvler =støvler =støvel *genser =genser *skjorte =truse *truser =klær
      grillkull =kull trekull *briketter tennbriketter tennvæske opptenning* grilltenner =ved bjørkeved peisved vedkubber fyrstikker`,
    hus: `toalettpapir tørkepapir tørkeruller =lambi =torky serla vaskemiddel oppvaskmiddel oppvask* =zalo =jif
      klorin =omo biotex softlan tøymykner *såpe =såpe sjampo shampoo sunsilk hårbalsam =balsam dusj* =dusch dusch*
      dobbeldusch deodorant =deo roll-on tannkrem tannpasta tannbørste colgate zendium sensodyne bleier =libero =libresse =tena
      våtservietter =bind truseinnlegg intimservietter tamponger søppelsekk* søppelposer fryseposer plastfolie
      aluminiumsfolie bakepapir batterier telys stearinlys *lys kubbelys kattesand oppvasktabletter maskinoppvask
      =blank barbering =dove =axe nivea lypsyl carmex leppepomade ansiktsrens ansiktskrem nattkrem bomullspads
      domestos avløpsåpner plumbo =klor wc* =ajax kleenex klesrulle brillerens apobase hundeposer klut* kluter
      =lano palmolive =gunry sun_alt_i_1 sun_maxpower sun_oppvask`,
    meieri: `olivero`,
  },
  { // 1: product form (drink, snack, sauce, ready meal, spread …) beats the ingredient words
    drikke: `smoothie iste ice_tea =tea juice *juice =saft *saft =nektar brus =cola energidrikk sportsdrikk kombucha =vann
      farris imsdal mineralvann =øl pils =cider eplemost =most red_bull monster =burn =urge fuzetea lipton gatorade
      powerade =solo fanta sprite pepsi coca-cola coca =zero sprudle pellegrino fun_light =vilje kullsyredrikk
      =drikke *drikk limonade tonic ginger_beer nocco =froosh vitamin_well cevita =mer clausthaler =pant
      sjokoladedrikk restitusjonsdrikk proteinshake =shake =shots starbucks mozell =villa`,
    meieri: `yoghurt yogurt *yoghurt skyr kesam kvarg =pudding *lunsj litago sjokomelk sjokolademelk iskaffe havredrikk
      =alpro danonino biola go'morgen gomorgen kremgo =yt philadelphia *pudding kremost smøreost salatost apetina cottage
      omelett* den_leende_ku crème_fraîche creme_fraiche fraîche magerost`,
    snacks: `chips *chips potetgull kjeks *kjeks =kex cookies ritz maiskaker maiskake riskaker riskake =tuc popcorn
      sjokolade *sjokolade *sjokolader godteri* smågodt* *godteri godteriposer godteribøtte nøtter *nøtter peanøtter
      chilinøtter nøttemiks nøttebar proteinbar *bar =barer barebells potetskruer =snacks *snacks melkerull krokanrull
      =smil =smash =stratos saritas pingvin brynild nidar fazer freia =kims =olw mentos corny dumle kinder* ricola
      tyggis swizzels kiddylicious fishermans fisherman's =drops *drops pastiller lakris *lakris pretzel =dipp
      *stenger saltstenger løkringer onion_rings tyrkisk_peber fløjl laban wasa_sandwich =läkerol mynthon ritter_sport lollipops juicy_drop`,
    torr: `buljong *buljong buljongterninger nudler *nudler =noodles koppnudler =maggi krydder* *krydder tacokrydder
      =saus *saus sauser =sauce *sauce dressing majones majo remulade ketchup sennep *grøt =grøt havregryn müsli
      musli granola cornflakes frokostblanding weetabix cheerios honning *honning syltetøy *syltetøy nugatti
      peanøttsmør pesto *olje =olje kokosmelk hermetikk hakkede_tomater =hakkede knuste =passata tomatpure tomatpuré
      polpa =mutti kidneybønner kikerter linser =bønner kokesjokolade tortelloni tortellini ravioli gnocchi risotto
      potetmos lasagneplater =kraft rett_i_koppen =te tebrev kaffe* *kaffe nescafé =ali friele =tunfisk
      =spread biscoff_spread raita papadam speltperler shaker sweet_chili sweet&sour`,
    ferdigmat: `ferdigrett* ferdigretter middagsfavoritter middagsklar grateng *grateng =gryte *gryte gryter =pai *pai
      =lasagne marry_me_chicken snack_pot pasta_snack =pirog *pirog calzone sushi =wok fløtegratin* potetsalat
      =nuggets *nuggets crispy_sticks børek macaroni_&_cheese fjordland =kit pizzalommer pytt_i_panne lapskaus*`,
    palegg: `leverpostei *postei =postei salami *salami servelat kjøttpålegg pålegg *pålegg kalkunkorv *skinke =skinke
      spekeskinke serranoskinke salatkjøtt kyllingbacon lakserøre makrell_i_tomat makrellfilet_i_tomat =stabbur
      king_oscar kaviar *kaviar kaviarmix spiseklar* chorizo =serrano stryhns`,
    frukt: `spiseklar_salat`,
    kjott: `skinkestek blodpudding lungemos falukorv kjøttkake kjøttkaker den_stolte_hane`,
    fisk: `fiskekake fiskekaker`,
    brod: `*baguetter hvitløksbaguetter 4_korn knekkebrød *knekkebrød`,
    frossen: `findus grandiosa peppes ristorante big_one billys *pizza =pizza fish_&_crisp fiskepinner =fries =pommes
      potteter pommes_frites iskrem =is =isen krone-is sørlandsis diplom-is`,
  },
  { // 2: ingredients and raw products
    annet: ``,
    meieri: `kefir parmigiano grana_padano margarin =flora soft_flora melange smøremyk melk lettmelk skummetmelk helmelk
      fløte matfløte kremfløte rømme lettrømme =ost brunost geitost gulost hvitost lettost =egg *egg egg frokostegg
      norvegia jarlsberg gudbrandsdalsost fløtemysost =smør meierismør bremykt kulturmelk mozzarella parmesan
      cheddar brie feta crème creme fraîche camembert gorgonzola cambozola maasdam mascarpone ricotta =prim`,
    kjott: `pancetta oksefilet filet_mignon pulled_pork pulled_chicken =chicken kjøtt kylling kyllingfilet kyllingbryst lårfilet kyllinglår
      kyllingvinger kyllingklubber vingeklubber svin svinekjøtt storfe =biff biffer entrecôte entrecote indrefilet
      ytrefilet mørbrad karbonadedeig kjøttdeig =deig pølse pølser wienerpølser grillpølser bacon baconterninger
      kalkun =lam lammekjøtt lammelår fårikål ribbe pinnekjøtt svinestek koteletter kotelett medisterkaker
      medisterdeig kebab hamburger burger burgere kjøttboller nakkekoteletter svinenakke karbonader kyllingpølse
      hvalbiff reinsdyr elg hjort andebryst svineknoke svinekam strimler snadder`,
    fisk: `laks *laks laksefilet torsk torskefilet =sei seifilet hyse hysefilet sildefilet ørretfilet lysingfilet lysing ørret reker =reke *reker scampi kongekrabbe krabbe blåskjell
      skalldyr fiskefilet =fisk fiskeboller fiskepudding sild spekesild klippfisk tørrfisk makrell kveite breiflabb
      steinbit tunfiskbiff =fish`,
    frukt: `=chili gresskar spisskål avocado =dadler rosiner oliven =bær frukt grønt grønnsaker eple epler banan bananer
      appelsin appelsiner mandarin mandariner klementin klementiner sitron sitroner =lime druer pære pærer avokado
      mango ananas jordbær bringebær blåbær melon meloner vannmelon tomat tomater cherrytomater piccolotomater agurk
      paprika salat isberg spinat brokkoli blomkål gulrot gulrøtter =løk rødløk hvitløk vårløk potet poteter
      søtpotet søtpoteter =kål hodekål rosenkål grønnkål purre sopp champignon squash maiskolbe urter persille
      basilikum koriander ingefær rødbeter kålrot sellerirot selleri nektarin plomme plommer granateple kiwifrukt
      fersken ruccola salatmiks bladsalat asparges aspargesbønner sukkererter =erter rotgrønnsaker bukettgrønnsaker
      =del_monte`,
    brod: `focaccia =stykker *stykker gifflar krisprolls donuts donut =muffin muffins leksands =grovt *grovt brød *brød
      rundstykker baguette ciabatta =loff polarbrød lomper lompe lefse lefser tortilla tortillas tortillalefser =wraps
      =pita pitabrød kavring =bolle boller kanelsnurr kanelboller croissant wienerbrød wienerbakst =kake *kake *kaker
      kaker bagel pølsebrød hamburgerbrød flatbrød grovbrød kneipp bakst skolebrød surdeigsbrød toastbrød rugbrød
      =naan piadina klenning =rolls brødmiks hatting lunsjkaker matpakkekaker`,
    torr: `fettuccine filtermalt kokmalt pizzasaus arrabbiata bakstmel pizzamel kjerner *kjerner chiafrø sesamfrø
      linfrø =pasta *pasta spaghetti makaroni penne fusilli fusilloni tagliatelle linguine =ris jasminris basmatiris
      =mel *mel hvetemel sammalt sukker kakao =salt =pepper olivenolje rapsolje solsikkeolje eddik =taco tacosaus
      salsa bønner hermetiske tunfisk =gryn =suppe *supper =supper vaffelrøre pannekakerøre bakepulver gjær soyasaus
      =mais maiskorn bakemiks lasagne =havre`,
    snacks: `haribo maoam hubba skittles chokiss malaco salmiakk crispies partymix godt_&_blandet mellombar doritos
      sommerhjerter stimorol proteinbar =snickers =kitkat cashew cashewnøtter mandler nonstop m&m kvikk_lunsj twist
      cheez_doodles pringles sørlandschips maarud polly marabou =daim smågodtkopp dip dipmix knask snop bugles
      bamsemums seigmenn =dent pistasj*`,
    frossen: `frossen frosne fryst fryste frys wokmix pizzabunn`,
    hus: ``,
  },
  { // 3: brand alone, when nothing else says what it is
    kjott: `=gilde =prior nortura`,
    meieri: `=tine synnøve q-meieriene =q =yoplait =røros`,
    torr: `=toro =idun =regal =axa =sopps santa_maria`,
    palegg: `=mills`,
  },
];

function buildTier(map) {
  const idx = [];
  for (const [cat, list] of Object.entries(map)) {
    for (let raw of list.split(/\s+/)) {
      if (!raw) continue;
      let mode = 'any';
      if (raw.startsWith('=')) { mode = 'whole'; raw = raw.slice(1); }
      else if (raw.startsWith('*')) { mode = 'end'; raw = raw.slice(1); }
      else if (raw.endsWith('*')) { mode = 'start'; raw = raw.slice(0, -1); }
      const kw = tokens(raw.replace(/_/g, ' ')).join(' '); // "coca-cola" → the phrase "coca cola", like titles
      if (!kw) continue;
      idx.push({ cat, kw, mode, phrase: kw.includes(' ') });
    }
  }
  return idx;
}
const INDEX = TIERS.map(buildTier);

export function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[’`´]/g, "'")
    .replace(/[^0-9a-zæøåäöüéèêçîïôûàâ'&\- ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokens(text) {
  return normalize(text).split(/[ \-]+/).filter(Boolean);
}

/** How a keyword hits a word: 0 = whole word, 1 = end of a compound (the head), 2 = start of one, -1 = no hit. */
function hitRank(w, kw, mode) {
  if (w === kw) return 0;
  if (mode === 'whole' || w.length <= kw.length) return -1;
  if (mode !== 'start' && w.endsWith(kw)) return 1;
  if (mode !== 'end' && w.startsWith(kw)) return 2;
  return -1;
}

/** Keyword-map category id for a text, or null. */
export function keywordCategory(text) {
  const words = tokens(text);
  if (!words.length) return null;
  const joined = ' ' + words.join(' ') + ' ';
  for (const tier of INDEX) {
    let best = null;
    for (const e of tier) {
      let rank = -1;
      if (e.phrase) rank = joined.includes(' ' + e.kw + ' ') ? 0 : -1;
      else for (const w of words) { const r = hitRank(w, e.kw, e.mode); if (r >= 0 && (rank < 0 || r < rank)) rank = r; }
      if (rank < 0) continue;
      if (!best || rank < best.rank || (rank === best.rank && e.kw.length > best.len)) best = { cat: e.cat, rank, len: e.kw.length };
    }
    if (best) return best.cat;
  }
  return null;
}

/**
 * Category engine.
 * Order: EAN rule → text rule (longest pattern first) → keyword map (text, then chain's own group).
 * Returns a category id that exists in `categories`, or null (= Ukategorisert).
 */
export function makeClassifier(categories, rules) {
  // tolerant: null or odd entries (an old or broken backup) are skipped, never thrown on
  const valid = new Set((Array.isArray(categories) ? categories : []).filter((c) => c && typeof c === 'object' && c.id != null).map((c) => String(c.id)));
  const eanRules = new Map();
  const textRules = [];
  for (const r of Array.isArray(rules) ? rules : []) {
    if (!r || typeof r !== 'object' || r.pattern == null || !valid.has(String(r.categoryId))) continue;
    if (r.type === 'ean') eanRules.set(String(r.pattern).trim(), r.categoryId);
    else textRules.push({ p: normalize(r.pattern), c: r.categoryId });
  }
  textRules.sort((a, b) => b.p.length - a.p.length);
  const cache = new Map();

  return function classify(text, ean, group) {
    if (ean && eanRules.has(String(ean).trim())) return eanRules.get(String(ean).trim());
    const key = text + '\u0001' + (group || '');
    if (cache.has(key)) return cache.get(key);
    const norm = normalize(text);
    let cat = null;
    for (const r of textRules) {
      if (r.p && norm.includes(r.p)) { cat = r.c; break; }
    }
    if (!cat) cat = keywordCategory(text);
    if (!cat && group) cat = keywordCategory(group);
    if (cat && !valid.has(cat)) cat = null;
    cache.set(key, cat);
    return cat;
  };
}

// Brand and store-brand words: they say who made it, not what it is. "Tine" on the receipt is no reason to show
// every Tine product as "for you"; the word that says what it is ("helmelk") has to match.
export const BRANDS = new Set(`tine synnøve q q-meieriene kavli gilde prior nortura mills idun toro freia nidar maarud
  stabburet coop rema kiwi meny spar joker extra mega prix obs bunnpris xtra first price eldorado änglamark
  anglamark hoff findus fjordland santa maria friele ali axa regal sopps leksands wasa pågen hatting bama gartner
  jacobs kims polly lambi zalo yoplait røros fazer marabou nestlé nestle kellogg's kelloggs dr oetker grilstad
  leiv vidar den stolte hane ytterøy lofoten kystens king oscar stryhns`.split(/\s+/));

/* ---------- word matching: search and shopping list ↔ offers ---------- */

// The front of a compound that makes it a different product: "sjokomelk" and "kokosmelk" are not milk,
// "peanøttsmør" is not butter, "knekkebrød" is not bread, "hvitløk" is not an onion.
const DISTINCT_ANY = ['sjoko', 'sjokolade', 'kakao', 'kokos', 'peanøtt', 'påske'];
const DISTINCT = {
  melk: ['sjoko', 'sjokolade', 'kakao', 'kokos', 'havre', 'mandel', 'soya', 'ris', 'kjerne', 'kultur', 'jordbær', 'banan', 'vanilje', 'kaffe', 'kondens'],
  løk: ['hvit', 'vår', 'gress', 'perle', 'sjalott'],
  brød: ['knekke', 'flat', 'kavring', 'pølse', 'hamburger', 'mat', 'pita', 'ost', 'hvitløks'],
  smør: ['peanøtt', 'nøtte', 'hasselnøtt', 'kakao', 'hvitløks', 'urte'],
  egg: ['påske', 'sjokolade', 'kinder'],
  ost: ['kjøtt', 'post'],
  is: ['krone', 'sørlands', 'diplom'],
};
const distinct = (head, mod) => (DISTINCT[head] || DISTINCT_ANY).some((d) => mod === d || mod === d + 's' || mod === d + 'e');

/**
 * How a typed word matches a word in a product name:
 * 3 = the same word; 2 = the product word ends with it and the front doesn't make it another product
 * ("lettmelk" for "melk", not "sjokomelk"); 1 = the product word starts with it ("kyllingfilet" for "kylling",
 * only counted when the categories agree); 0 = no match.
 */
export function wordMatch(t, w) {
  if (t === w) return 3;
  if (t.length < 3 || w.length <= t.length) return 0;
  if (w.endsWith(t)) {
    let mod = w.slice(0, -t.length);
    if (mod.endsWith('s') && mod.length > 3 && distinct(t, mod.slice(0, -1))) return 0;
    return distinct(t, mod) ? 0 : 2;
  }
  if (w.startsWith(t)) return 1;
  return 0;
}

// Category pairs that can hold the same product: kjøtt as pålegg, frozen fish, …
const COMPAT = new Set(['kjott|palegg', 'fisk|palegg', 'kjott|frossen', 'fisk|frossen', 'frukt|frossen', 'ferdigmat|frossen', 'brod|frossen', 'kjott|ferdigmat']);
/** Can an item of category a be the same product as an offer of category b? Unknown (null/annet) = yes. */
export function compatible(a, b) {
  if (!a || !b || a === 'annet' || b === 'annet' || a === b) return true;
  return COMPAT.has(a + '|' + b) || COMPAT.has(b + '|' + a);
}

/**
 * Score an offer for a query or a shopping-list item. 0 = not a match.
 * q: query tokens; qCat: the query's category (or null); words: the offer title's tokens; cat: the offer's category.
 * Every query word has to hit a title word. A different kind of product (category mismatch) is never a match:
 * "hvitløk" ≠ "Philadelphia hvitløk", "melk" ≠ "kokosmelk", "paprika" ≠ "paprikachips".
 * opts.prefix: when the query has no known category, allow plain prefixes (search-as-you-type: "kyll" → kylling).
 * opts.desc: description tokens, used only for a whole-word hit on an offer of exactly the query's category.
 */
export function matchOffer(q, qCat, words, cat, opts = {}) {
  if (!q.length) return 0;
  if (qCat && !compatible(qCat, cat)) return 0;
  let score = 0;
  for (const t of q) {
    let best = 0;
    for (const w of words) {
      const m = wordMatch(t, w);
      const v = m === 1 ? ((qCat && cat === qCat) || (!qCat && opts.prefix) ? 1.5 : 0) : m;
      if (v > best) best = v;
      if (best === 3) break;
    }
    if (!best && opts.desc && qCat && cat === qCat && opts.desc.includes(t)) best = 1;
    if (!best) return 0;
    score += best;
  }
  if (qCat && cat === qCat) score += 2;
  return score;
}

/* ---------- quantities on the shopping list ---------- */
const UNITS = {
  g: 'g', gr: 'g', gram: 'g', hg: 'hg', kg: 'kg', kilo: 'kg', l: 'l', ltr: 'l', liter: 'l', dl: 'dl', cl: 'cl', ml: 'ml',
  stk: 'stk', st: 'stk', pk: 'pk', pakke: 'pk', pakker: 'pk', boks: 'boks', bokser: 'boks', flaske: 'flaske', flasker: 'flaske',
  pose: 'pose', poser: 'pose', x: 'stk',
};
const NUM = '(\\d+(?:[.,]\\d+)?)';
const UNIT_RE = Object.keys(UNITS).sort((a, b) => b.length - a.length).join('|');
const LEAD = new RegExp(`^${NUM}\\s*(${UNIT_RE})?\\.?\\s+(.+)$`, 'i');
const LEAD_X = new RegExp(`^${NUM}\\s*x\\s*(.+)$`, 'i');
const TRAIL = new RegExp(`^(.+?)\\s+(?:x\\s*)?${NUM}\\s*(${UNIT_RE})?\\.?$`, 'i');

/**
 * "2 l melk" → {name:'melk', qty:2, unit:'l'}; "kjøttdeig 500 g" → {name:'kjøttdeig', qty:500, unit:'g'};
 * "3 stk paprika" / "paprika x3" → {qty:3, unit:'stk'}; "melk" → {name:'melk', qty:null, unit:null}.
 * Only a number at the very start or end counts, so "4-korn brød" and "Tine helmelk 3.5%" stay as they are.
 */
export function parseQty(text) {
  const s = String(text || '').trim().replace(/\s+/g, ' ');
  const num = (v) => Number(String(v).replace(',', '.'));
  let m = s.match(LEAD);
  if (m && /\D/.test(m[3]) && num(m[1]) > 0) return { name: m[3].trim(), qty: num(m[1]), unit: m[2] ? UNITS[m[2].toLowerCase()] : 'stk' };
  m = s.match(LEAD_X);
  if (m && num(m[1]) > 0) return { name: m[2].trim(), qty: num(m[1]), unit: 'stk' };
  m = s.match(TRAIL);
  // "bleier str 5", "sko størrelse 38", "bleier nr. 4": the number is part of the name, not how many (Linn)
  if (m && /\b(str|størrelse|size|nr|nummer|type|uke|år)\.?$/i.test(m[1].trim())) return { name: s, qty: null, unit: null };
  if (m && /[a-zæøå]/i.test(m[1]) && num(m[2]) > 0 && (m[3] || /\sx\s*\d/i.test(s) || /^\d+$/.test(m[2]))) {
    return { name: m[1].trim(), qty: num(m[2]), unit: m[3] ? UNITS[m[3].toLowerCase()] : 'stk' };
  }
  return { name: s, qty: null, unit: null };
}

/** Step for the − / + buttons: 100 g, ½ kg/l, otherwise 1. */
export const qtyStep = (unit) => (unit === 'g' || unit === 'ml' ? 100 : unit === 'kg' || unit === 'l' ? 0.5 : 1);

/** "2 l", "500 g", "3 stk" (one piece without a unit shows nothing). */
export function qtyText(qty, unit) {
  if (qty == null) return '';
  const n = Number(qty).toLocaleString('nb-NO', { maximumFractionDigits: 2 });
  if (!unit || unit === 'stk') return qty === 1 ? '' : `${n} stk`;
  return `${n} ${unit}`;
}

/** A pasted list: one item per line; bullets, numbering and checkboxes from other apps are removed. */
export function pastedLines(text) {
  return String(text || '').split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*•·–]|\[[ xX]?\]|☐|☑|✓|\d+[.)])\s*/, '').trim())
    .filter((l) => l && !/^handleliste:?$/i.test(l));
}
