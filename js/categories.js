// Categories, the Norwegian keyword map and the rule engine.
// Tjek gives no categories, so offers and receipt lines are classified here.

export const DEFAULT_CATEGORIES = [
  { id: 'meieri', name: 'Meieri', color: '#2a78d6' },
  { id: 'kjott', name: 'Kjøtt/fisk', color: '#e34948' },
  { id: 'frukt', name: 'Frukt/grønt', color: '#008300' },
  { id: 'brod', name: 'Brød/bakst', color: '#eda100' },
  { id: 'torr', name: 'Tørrvarer', color: '#eb6834' },
  { id: 'snacks', name: 'Snacks/godteri', color: '#e87ba4' },
  { id: 'drikke', name: 'Drikke', color: '#1baf7a' },
  { id: 'frossen', name: 'Frossen', color: '#6250d6' },
  { id: 'hus', name: 'Husholdning', color: '#5f7186' },
  { id: 'annet', name: 'Annet', color: '#8a8a85' },
];

// Keyword map. Longest matching keyword wins across all categories, so
// "vannmelon" beats "vann" and "lambi" beats "lam".
// Plain keyword: matches a word that starts or ends with it (Norwegian compounds:
// "lettmelk", "kjøttdeig"). Prefix "=": whole word only. A keyword with a space
// matches anywhere as a phrase.
const KEYWORDS = {
  annet: `roser blomster azalea chrysanthemum hyperikum potteplante julestjerne tulipaner`,
  meieri: `kefir parmigiano grana_padano kvarg yoplait margarin =flora soft_flora melange smøremyk apetina =oatly melk lettmelk skummetmelk helmelk fløte matfløte kremfløte rømme lettrømme yoghurt yogurt skyr
    ost norvegia jarlsberg brunost gudbrandsdalsost geitost smør bremykt meierismør =egg egg kesam cottage
    kulturmelk biola =tine synnøve q-meieriene mozzarella parmesan cheddar brie feta kremost philadelphia
    smøreost crème creme sjokolademelk iskaffe havredrikk oatly pudding go'morgen gomorgen`,
  kjott: `pancetta mortadella filet klippfisk lysing pulled_pork pulled_chicken chicken =reke kjøttpålegg skinkestek =torsk kjøtt kylling kyllingfilet kyllingbryst lårfilet kyllinglår kyllingvinger svin svinekjøtt storfe
    =biff biffer entrecôte entrecote indrefilet ytrefilet mørbrad karbonadedeig kjøttdeig =deig pølse pølser
    wienerpølser grillpølser bacon skinke kalkun =lam lammekjøtt lammelår fårikål ribbe pinnekjøtt svinestek
    koteletter kjøttkaker medisterkaker medisterdeig kebab =fisk fiskefilet laks laksefilet torsk =sei ørret
    reker scampi fiskekaker fiskeboller fiskepudding fiskegrateng makrell sild hamburger burger burgere
    salami servelat leverpostei pålegg kjøttboller =gilde =prior nortura nakkekoteletter svinenakke
    karbonader gryterett kyllingpølse hvalbiff reinsdyr elg hjort andebryst tunfiskbiff`,
  frukt: `=chili gresskar spisskål avocado =dadler rosiner oliven =bær frukt grønt grønnsaker eple epler banan bananer appelsin appelsiner mandarin mandariner klementin
    klementiner sitron sitroner =lime druer pære pærer avokado mango ananas jordbær bringebær blåbær melon
    vannmelon tomat tomater cherrytomater agurk paprika salat isberg spinat brokkoli blomkål gulrot gulrøtter
    =løk rødløk hvitløk vårløk potet poteter søtpotet =kål hodekål rosenkål grønnkål purre sopp champignon
    squash maiskolbe urter persille basilikum koriander ingefær rødbeter kålrot sellerirot sellerist
    nektarin plomme plommer granateple kiwifrukt fersken ruccola salatmiks bladsalat asparges
    sukkererter`,
  brod: `focaccia stykker gifflar krisprolls donuts =muffin leksands 4-korn =grovt brød rundstykker baguette ciabatta =loff polarbrød lomper lompe lefse lefser tortilla tortillalefser
    wraps =pita pitabrød knekkebrød kavring =bolle boller kanelsnurr kanelboller croissant wienerbrød =kake
    kaker muffins bagel pølsebrød hamburgerbrød flatbrød grovbrød kneipp bakst skolebrød surdeigsbrød
    toastbrød rugbrød`,
  torr: `fettuccine filtermalt kokmalt pizzasaus arrabbiata bakstmel ferdigretter grøt risgrøt pizzamel kjerner chiafrø sesamfrø linfrø gresskarkjerner weetabix cheerios rett_i_koppen maiskorn havre lasagne =knorr pasta spaghetti makaroni penne fusilli tagliatelle =ris jasminris basmatiris =mel hvetemel sammalt
    sukker havregryn müsli musli granola frokostblanding cornflakes kaffe kaffebønner =te tebrev kakao
    buljong krydder =salt =pepper olje olivenolje rapsolje eddik ketchup sennep majones dressing =saus
    pastasaus pesto =taco tacokrydder tacosaus salsa hermetikk bønner kidneybønner linser kikerter
    hermetiske tunfisk hakkede_tomater syltetøy nugatti peanøttsmør honning
    =gryn nudler =suppe =toro =mills =idun vaffelrøre pannekakerøre bakepulver gjær kokosmelk soyasaus
    =mais majones bakemiks knorr makrell_i_tomat kaviar mikkel`,
  snacks: `haribo maoam hubba skittles nøttebar chokiss =drops malaco salmiakk crispies nøttemiks partymix godt_&_blandet mellombar doritos fisherman's cookies ritz sommerhjerter stimorol läkerol proteinbar =barer fazer løkringer nachos mynthon =dent =snickers =kitkat chips potetgull sjokolade godteri smågodt snacks popcorn nøtter peanøtter cashew cashewnøtter
    mandler kjeks =kex nonstop m&m freia kvikk_lunsj smash twist cheez_doodles pringles
    sørlandschips maarud polly saltstenger lakris pastiller tyggegummi karameller sjokoladeplate marabou
    =daim smågodtkopp dip dipmix knask snop bugles bamsemums seigmenn`,
  drikke: `fuzetea gatorade =urge sprudle pellegrino lipton ice_tea kullsyredrikk powerade starbucks fun_light =vilje =pepsi =zero brus =cola coca-cola pepsi =solo fanta sprite farris imsdal =vann mineralvann juice saft nektar
    smoothie =øl pils =cider energidrikk red_bull monster =burn iste brusbrett eplemost appelsinjuice
    kombucha sportsdrikk`,
  frossen: `tiramisu findus peppes fish_&_crisp frossen frosne fryst fryste frys =pizza grandiosa ristorante =big_one iskrem =is =isen
    pommes frites fiskepinner wok =lollipop isbåt pizzabunn`,
  hus: `dove bomullspads =axe libresse =tena sensodyne carmex ansiktsrens ansiktskrem nattkrem avløpsåpner plumbo =klor intimservietter lypsyl domestos zendium nivea biotex hundeposer pedigree tyggepinner tyggeknute =latz katt kattemat menybokser =hund toalettpapir tørkepapir lambi serla vaskemiddel oppvask oppvaskmiddel zalo =jif klorin =omo =milo
    tøymykner såpe sjampo shampoo balsam dusjsåpe dusj deodorant tannkrem tannbørste bleier libero
    våtservietter bind tamponger søppelsekk søppelposer fryseposer plastfolie aluminiumsfolie bakepapir
    batterier telys stearinlys kattesand hundemat kattemat dyrefôr dyrefor oppvasktabletter maskinoppvask
    =blank barbering`,
};

function buildIndex() {
  const idx = [];
  for (const [cat, list] of Object.entries(KEYWORDS)) {
    for (let raw of list.split(/\s+/)) {
      if (!raw) continue;
      const whole = raw.startsWith('=');
      if (whole) raw = raw.slice(1);
      const kw = raw.replace(/_/g, ' ').toLowerCase();
      idx.push({ cat, kw, whole, phrase: kw.includes(' ') });
    }
  }
  idx.sort((a, b) => b.kw.length - a.kw.length);
  return idx;
}
const INDEX = buildIndex();

export function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[’`´]/g, "'")
    .replace(/[^0-9a-zæøåäöüéèêç'&\- ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokens(text) {
  return normalize(text).split(/[ \-]+/).filter(Boolean);
}

/** Keyword-map category id for a text, or null. */
export function keywordCategory(text) {
  const norm = normalize(text);
  if (!norm) return null;
  const words = norm.split(/[ \-]+/);
  for (const { cat, kw, whole, phrase } of INDEX) {
    if (phrase) {
      if ((' ' + norm + ' ').includes(' ' + kw)) return cat;
      continue;
    }
    for (const w of words) {
      if (w === kw) return cat;
      if (!whole && w.length > kw.length && (w.startsWith(kw) || w.endsWith(kw))) return cat;
    }
  }
  return null;
}

/**
 * Category engine.
 * Order: EAN rule → text rule (longest pattern first) → keyword map (text, then chain's own group).
 * Returns a category id that exists in `categories`, or null (= Ukategorisert).
 */
export function makeClassifier(categories, rules) {
  const valid = new Set(categories.map((c) => c.id));
  const eanRules = new Map();
  const textRules = [];
  for (const r of rules || []) {
    if (!valid.has(r.categoryId)) continue;
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
