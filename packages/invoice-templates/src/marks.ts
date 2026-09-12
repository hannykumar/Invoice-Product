/**
 * Issue #147 — the mark of the trade: finding a picture, and turning it into one a bill can print.
 *
 * Asked for after looking at the KK Polyplast bill, which carries the company's own mark. A
 * business using this product should be able to put something on its bill that says what it does,
 * so the paper looks like it belongs to that business rather than to a template.
 *
 * Three things this module holds to.
 *
 * 1. **Nothing is ever chosen for a business.** There is no default picture and no guess from the
 *    business type. A mark appears on a bill only because a person searched, looked at the
 *    drawings and picked one. See `no-invented-text-on-the-bill`: a bill is the business speaking,
 *    and that includes the pictures on it.
 * 2. **It is an extra, never a requirement.** A bill with no mark is a complete and lawful bill.
 * 3. **It can never cost legibility.** The watermark is capped in code at a faintness a tax figure
 *    survives, and it is not printed at all on till-roll paper, where it comes out as grey smudge.
 *    `validateTemplate` already refuses a design that touches a required field; this is the same
 *    idea applied to decoration.
 *
 * The pictures themselves are a free open set copied into this repository — see
 * `marks-library.generated.ts`. They are searched by what a business actually sells, in the words
 * an Indian shopkeeper would use, which is what `TRADE_WORDS` below is for.
 */
import { invalid } from '@invoice/kernel';
import { FIELD_SEPARATOR, PATH_SEPARATOR } from './marks-format.ts';
import { TRADE_MARK_LIBRARY_ROWS, TRADE_MARK_LIBRARY_VERSION } from './marks-library.generated.ts';

export { TRADE_MARK_LIBRARY_VERSION };

/** One drawing in the library. */
export interface TradeMarkPicture {
  /** Stable across rebuilds, and what a business's choice is stored as, e.g. "bread". */
  readonly id: string;
  /** The strokes the drawing is made of, on a 24 by 24 square. */
  readonly paths: readonly string[];
  /** Every word this picture can be found by. */
  readonly words: readonly string[];
}

/**
 * The faintest a watermark may be printed, as a percentage of full ink.
 *
 * Six per cent of black is visible as a shape on a page and leaves a printed figure unambiguous.
 * The number is a cap rather than a setting: a business may ask for less, never for more, because
 * the thing underneath the watermark is the tax on the bill.
 */
export const MAX_TRADE_MARK_OPACITY_PERCENT = 6;

/** What a business gets when it turns a mark on. Frozen onto the bill, exactly like the logo. */
export interface TradeMarkChoice {
  /**
   * Where the picture came from. `LIBRARY` is one of ours, `OWN` is a picture the business
   * uploaded — usually its own logo. Recorded because a business that later uploads a real logo
   * should be told which of the two it is currently printing.
   */
  readonly source: 'LIBRARY' | 'OWN';
  /** Set only for `LIBRARY`, so the same drawing can be found again. */
  readonly pictureId: string | null;
  /** The picture itself, already a data URI, so printing needs neither this library nor a network. */
  readonly imageDataUri: string;
  /** At or below `MAX_TRADE_MARK_OPACITY_PERCENT`. */
  readonly opacityPercent: number;
}

// ------------------------------------------------------------------------------- reading the library

const parse = (row: string): TradeMarkPicture => {
  const [id, words, paths] = row.split(FIELD_SEPARATOR);
  return {
    id: id as string,
    words: (words as string).split(' '),
    paths: (paths as string).split(PATH_SEPARATOR),
  };
};

let cache: readonly TradeMarkPicture[] | null = null;

/** Every picture, read from the generated file once and kept. */
export const tradeMarkPictures = (): readonly TradeMarkPicture[] => {
  cache ??= TRADE_MARK_LIBRARY_ROWS.map(parse);
  return cache;
};

export const tradeMarkPicture = (id: string): TradeMarkPicture | null =>
  tradeMarkPictures().find((p) => p.id === id) ?? null;

// ------------------------------------------------------------------------------- searching it

/**
 * Words an Indian business would type, and the words the drawings are filed under.
 *
 * The library is an English set drawn abroad, so "mithai" finds nothing in it and "dana" finds
 * nothing either. Rather than ask a shopkeeper to guess the English word a designer used, the
 * trade's own word is mapped here. Hindi is written the way it is typed on a phone keyboard,
 * because that is how it will be typed.
 *
 * This is a list of **search words**, not a list of pictures. Nothing here decides what a business
 * gets; it only decides what it is shown when it types.
 */
const TRADE_WORDS: Readonly<Record<string, readonly string[]>> = {
  // Food and grocery
  mithai: ['candy', 'cake', 'dessert'],
  sweets: ['candy', 'cake', 'dessert'],
  bakery: ['bread', 'cake', 'baguette', 'cupcake'],
  kirana: ['store', 'shopping', 'basket', 'grocery'],
  grocery: ['store', 'shopping', 'basket'],
  anaj: ['grain', 'wheat', 'seedling'],
  dana: ['grain', 'seedling', 'wheat'],
  chawal: ['grain', 'bowl'],
  rice: ['grain', 'bowl'],
  atta: ['wheat', 'grain'],
  dairy: ['milk', 'cheese', 'cow'],
  doodh: ['milk'],
  chai: ['teapot', 'cup', 'coffee'],
  masala: ['salt', 'pepper', 'bowl'],
  sabzi: ['carrot', 'salad', 'plant'],
  // Cloth and clothing
  kapda: ['shirt', 'hanger', 'needle', 'thread'],
  cloth: ['shirt', 'hanger', 'needle', 'thread'],
  textile: ['shirt', 'needle', 'thread', 'hanger'],
  tailor: ['needle', 'thread', 'scissors', 'ruler'],
  darzi: ['needle', 'thread', 'scissors'],
  garment: ['shirt', 'hanger'],
  // Hardware, metal and building
  hardware: ['hammer', 'tool', 'nut', 'screwdriver'],
  loha: ['hammer', 'tool', 'nut'],
  steel: ['hammer', 'tool', 'nut'],
  cement: ['wall', 'building', 'factory', 'bucket'],
  brick: ['wall', 'building'],
  construction: ['crane', 'building', 'tool', 'helmet'],
  sariya: ['tool', 'nut'],
  paint: ['brush', 'bucket', 'paint'],
  timber: ['wood', 'tree', 'saw'],
  lakdi: ['wood', 'tree'],
  furniture: ['sofa', 'bed', 'lamp', 'armchair'],
  // Plastics, chemicals, packaging
  plastic: ['bottle', 'bucket', 'packages', 'box'],
  polymer: ['bottle', 'packages', 'box'],
  packaging: ['package', 'packages', 'box', 'cardboards'],
  soap: ['bubble', 'bath', 'droplet', 'wash'],
  detergent: ['bubble', 'wash', 'droplet'],
  chemical: ['flask', 'droplet', 'test'],
  // Vehicles and parts
  tyre: ['wheel', 'car', 'steering'],
  tire: ['wheel', 'car'],
  garage: ['car', 'tool', 'engine'],
  spare: ['engine', 'nut', 'tool'],
  auto: ['car', 'engine', 'wheel'],
  transport: ['truck', 'bus', 'road'],
  petrol: ['gas', 'station', 'fuel'],
  diesel: ['gas', 'station', 'fuel'],
  // Trades and services
  dawa: ['pill', 'pills', 'medicine', 'vaccine'],
  medical: ['pill', 'stethoscope', 'medicine', 'hospital'],
  chemist: ['pill', 'pills', 'medicine'],
  clinic: ['stethoscope', 'hospital', 'dental'],
  salon: ['razor', 'scissors', 'brush', 'perfume'],
  laundry: ['wash', 'shirt', 'ironing'],
  electrical: ['plug', 'bulb', 'battery', 'circuit'],
  electronics: ['device', 'battery', 'plug'],
  plumbing: ['droplet', 'pipeline', 'tool'],
  printing: ['printer', 'brush', 'stamp'],
  stationery: ['book', 'pencil', 'notebook'],
  jewellery: ['diamond', 'diamonds', 'crown'],
  sona: ['diamond', 'crown', 'coin'],
  gold: ['diamond', 'coin', 'crown'],
  hotel: ['bed', 'cup', 'hotel'],
  restaurant: ['bowl', 'tools-kitchen', 'pizza', 'cup'],
  farm: ['tractor', 'plant', 'seedling', 'wheat'],
  kheti: ['tractor', 'plant', 'seedling'],
  mill: ['windmill', 'factory', 'wheat'],
  factory: ['factory', 'building'],
  toys: ['gift', 'ball', 'puzzle'],
  books: ['book', 'notebook'],
  sports: ['ball', 'trophy', 'barbell'],
  gym: ['barbell', 'yoga', 'treadmill'],
};

export interface TradeMarkSearchResult {
  readonly picture: TradeMarkPicture;
  /** Higher is a better match. Only useful for ordering. */
  readonly score: number;
}

const terms = (query: string): readonly string[] =>
  query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);

const expand = (term: string): readonly string[] => [term, ...(TRADE_WORDS[term] ?? [])];

const scoreOne = (picture: TradeMarkPicture, term: string): number => {
  let best = 0;
  for (const wanted of expand(term)) {
    // A drawing actually called "bread" beats one that merely mentions bread among its words, and
    // both beat one where the word only appears inside a longer word.
    if (picture.id === wanted) best = Math.max(best, 100);
    else if (picture.id.split('-').includes(wanted)) best = Math.max(best, 60);
    else if (picture.words.includes(wanted)) best = Math.max(best, 40);
    else if (picture.words.some((w) => w.startsWith(wanted))) best = Math.max(best, 15);
  }
  return best;
};

/**
 * The pictures that match what a business typed, best first.
 *
 * Every word typed has to match something, so "milk bottle" narrows rather than widens. An empty
 * query returns nothing rather than the whole library: the whole library with no question asked is not a choice, it is a wall.
 */
export const searchTradeMarks = (query: string, limit = 24): readonly TradeMarkSearchResult[] => {
  const wanted = terms(query);
  if (wanted.length === 0) return [];

  const strict: TradeMarkSearchResult[] = [];
  const loose: TradeMarkSearchResult[] = [];
  for (const picture of tradeMarkPictures()) {
    let total = 0;
    let matched = 0;
    for (const term of wanted) {
      const score = scoreOne(picture, term);
      if (score > 0) matched += 1;
      total += score;
    }
    if (matched === wanted.length) strict.push({ picture, score: total });
    else if (matched > 0) loose.push({ picture, score: total });
  }

  // Ties are broken by the shorter id, which is nearly always the plainer drawing: "bread" before
  // "bread-basket-full-of-something".
  const byScore = (a: TradeMarkSearchResult, b: TradeMarkSearchResult): number =>
    b.score - a.score || a.picture.id.length - b.picture.id.length;

  // Someone who types "plastic dana" has described their trade, not asked for a drawing that is
  // both. When nothing answers every word, the words are taken one at a time rather than answering
  // with an empty screen, which reads as "we have nothing" when we have nearly two thousand pictures.
  const results = strict.length > 0 ? strict : loose;
  return results.sort(byScore).slice(0, limit);
};

// ------------------------------------------------------------------------------- making it printable

/** The drawing as an SVG, at whatever colour the caller wants. */
export const tradeMarkSvg = (picture: TradeMarkPicture, colour = '#000000'): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${colour}" ` +
  `stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round">` +
  picture.paths.map((d) => `<path d="${d}"/>`).join('') +
  `</svg>`;

/**
 * The drawing as a data URI, which is the form a bill carries.
 *
 * Held as text rather than as base64 so that a stored bill stays greppable, and so the picture on
 * a five-year-old reprint can still be read by a person opening the file.
 */
export const tradeMarkDataUri = (picture: TradeMarkPicture, colour = '#000000'): string =>
  `data:image/svg+xml;utf8,${encodeURIComponent(tradeMarkSvg(picture, colour))}`;

/**
 * Turns a chosen picture into the thing stored against the business.
 *
 * `opacityPercent` is offered so a business can go fainter than the cap, never darker.
 */
export const tradeMarkFromLibrary = (
  pictureId: string,
  opacityPercent: number = MAX_TRADE_MARK_OPACITY_PERCENT,
): TradeMarkChoice => {
  const picture = tradeMarkPicture(pictureId);
  if (picture === null) {
    throw invalid('TRADE_MARK_UNKNOWN_PICTURE', `There is no picture called "${pictureId}" in the library.`);
  }
  const choice: TradeMarkChoice = {
    source: 'LIBRARY',
    pictureId,
    imageDataUri: tradeMarkDataUri(picture),
    opacityPercent,
  };
  validateTradeMark(choice);
  return choice;
};

/** The same, for a business printing its own picture behind the bill. */
export const tradeMarkFromOwnPicture = (
  imageDataUri: string,
  opacityPercent: number = MAX_TRADE_MARK_OPACITY_PERCENT,
): TradeMarkChoice => {
  const choice: TradeMarkChoice = { source: 'OWN', pictureId: null, imageDataUri, opacityPercent };
  validateTradeMark(choice);
  return choice;
};

/**
 * Refuses a mark that would make the bill harder to read.
 *
 * This throws rather than quietly correcting, for the same reason `validateTemplate` throws: a
 * setting that is silently ignored is a setting someone believes is in force.
 */
export const validateTradeMark = (choice: TradeMarkChoice): void => {
  if (!Number.isFinite(choice.opacityPercent) || choice.opacityPercent <= 0) {
    throw invalid('TRADE_MARK_INVISIBLE', 'A watermark at zero is not a watermark. Leave it off instead.');
  }
  if (choice.opacityPercent > MAX_TRADE_MARK_OPACITY_PERCENT) {
    throw invalid(
      'TRADE_MARK_TOO_DARK',
      `A watermark may be at most ${MAX_TRADE_MARK_OPACITY_PERCENT}% dark, so the tax figures on top of it stay readable.`,
    );
  }
  if (!choice.imageDataUri.startsWith('data:image/')) {
    throw invalid(
      'TRADE_MARK_NOT_A_PICTURE',
      'The mark must be the picture itself, so a bill printed years from now does not depend on a web address.',
    );
  }
  if (choice.source === 'LIBRARY' && choice.pictureId === null) {
    throw invalid('TRADE_MARK_NO_PICTURE_ID', 'A picture taken from the library must record which one it was.');
  }
};
