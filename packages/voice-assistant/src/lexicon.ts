/**
 * Issue #10 [E10] — the words a shopkeeper actually uses.
 *
 * This is a lexicon, not a model. Reading "sattar" as 70 is a lookup with a known answer, and a
 * lookup can be tested, corrected and explained. A word that is not in the table becomes a
 * question, never a guess — which is the same rule the rest of the product follows.
 *
 * Hindi is written in Latin script because that is how people type it on a phone. Devanagari is
 * accepted too where the mapping is unambiguous.
 */

export type Language = 'en' | 'hi' | 'hinglish';

/** Small numbers, where Hindi is irregular and must simply be listed. */
const HINDI_UNITS: Record<string, number> = {
  shunya: 0, zero: 0,
  ek: 1, do: 2, teen: 3, char: 4, chaar: 4, paanch: 5, panch: 5, chhah: 6, chhe: 6, cheh: 6,
  saat: 7, aath: 8, nau: 9, das: 10, dus: 10,
  gyarah: 11, gyara: 11, barah: 12, bara: 12, terah: 13, tera: 13, chaudah: 14, chauda: 14,
  pandrah: 15, pandra: 15, solah: 16, sola: 16, satrah: 17, satra: 17, atharah: 18, athara: 18,
  unnis: 19, unnees: 19, bees: 20, bis: 20,
};

/** Tens. `sattar` and `satrah` are the pair this whole feature exists to keep apart. */
const HINDI_TENS: Record<string, number> = {
  bees: 20, bis: 20, tees: 30, tis: 30, chalis: 40, chaalis: 40, pachas: 50, pachaas: 50,
  saath: 60, sath: 60, sattar: 70, sattr: 70, assi: 80, asi: 80, nabbe: 90, nabbey: 90,
};

/** The irregular twenties to nineties people say most often at a counter. */
const HINDI_COMPOUNDS: Record<string, number> = {
  ikkis: 21, baees: 22, bais: 22, teis: 23, chaubis: 24, pachchis: 25, pachees: 25,
  chhabbis: 26, sattais: 27, atthais: 28, untis: 29,
  ikattis: 31, battis: 32, taintis: 33, chauntis: 34, paintis: 35, chhattis: 36,
  saintis: 37, adtis: 38, untalis: 39,
  iktalis: 41, bayalis: 42, taintalis: 43, chvalis: 44, paintalis: 45, chhiyalis: 46,
  saintalis: 47, adtalis: 48, unchas: 49,
  ikyavan: 51, bavan: 52, tirpan: 53, chauvan: 54, pachpan: 55, chhappan: 56,
  sattavan: 57, atthavan: 58, unsath: 59,
  iksath: 61, basath: 62, tirsath: 63, chausath: 64, painsath: 65, chhiyasath: 66,
  sarsath: 67, adsath: 68, unhattar: 69,
  ikhattar: 71, bahattar: 72, tihattar: 73, chauhattar: 74, pachhattar: 75, chhihattar: 76,
  sathattar: 77, athhattar: 78, unasi: 79,
  ikyasi: 81, bayasi: 82, tirasi: 83, chaurasi: 84, pachasi: 85, chhiyasi: 86,
  satasi: 87, athasi: 88, nirasi: 89,
  ikyanve: 91, banve: 92, tiranve: 93, chauranve: 94, pachanve: 95, chhiyanve: 96,
  sattanve: 97, atthanve: 98, ninyanve: 99,
};

const ENGLISH_UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};

const ENGLISH_TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

/** Multipliers. Indian scale: sau, hazaar, lakh. */
export const MULTIPLIERS: Record<string, number> = {
  hundred: 100, sau: 100,
  thousand: 1000, hazaar: 1000, hazar: 1000,
  lakh: 100000, lac: 100000,
  crore: 10000000, karod: 10000000,
};

export const NUMBER_WORDS: Record<string, number> = {
  ...ENGLISH_UNITS,
  ...ENGLISH_TENS,
  ...HINDI_UNITS,
  ...HINDI_TENS,
  ...HINDI_COMPOUNDS,
};

/** Devanagari digits, so a number typed in Hindi script parses without a model. */
export const DEVANAGARI_DIGITS: Record<string, string> = {
  '०': '0', '१': '1', '२': '2', '३': '3', '४': '4', '५': '5', '६': '6', '७': '7', '८': '8', '९': '9',
};

/** Unit words to the code master data uses. A word not here becomes a question. */
export const UNIT_WORDS: Record<string, string> = {
  box: 'BOX', boxes: 'BOX', peti: 'BOX', petiyan: 'BOX', dabba: 'BOX', dabbe: 'BOX',
  kg: 'KGS', kgs: 'KGS', kilo: 'KGS', kilos: 'KGS', kilogram: 'KGS', kilograms: 'KGS',
  gram: 'GMS', grams: 'GMS', gm: 'GMS',
  piece: 'PCS', pieces: 'PCS', pcs: 'PCS', nag: 'PCS', adad: 'PCS',
  litre: 'LTR', litres: 'LTR', liter: 'LTR', ltr: 'LTR',
  dozen: 'DOZ', darjan: 'DOZ',
  packet: 'PAC', packets: 'PAC', pack: 'PAC',
  bag: 'BAG', bags: 'BAG', bora: 'BAG',
  quintal: 'QTL', tonne: 'TON', ton: 'TON',
};

/** Words that mean "this is a sale". A sentence with none of them is not acted on. */
export const SELL_VERBS: readonly string[] = ['sell', 'sold', 'bech', 'becho', 'bechna', 'becha', 'de', 'diya', 'bill'];

/** Words that say whether the rate already contains tax. */
export const INCLUSIVE_WORDS: readonly string[] = ['inclusive', 'including', 'sahit', 'samet', 'included', 'with'];
export const EXCLUSIVE_WORDS: readonly string[] = ['exclusive', 'excluding', 'plus', 'alag', 'without', 'extra'];

/** Words that mark a rate rather than a total: "at", "@", "per", "ke hisaab se". */
export const RATE_MARKERS: readonly string[] = ['at', '@', 'per', 'ka', 'ke', 'rate', 'hisaab'];

/** Words that mark the customer: "to ABC", "ABC ko". */
export const TO_MARKERS: readonly string[] = ['to', 'ko', 'for'];

export const CURRENCY_WORDS: readonly string[] = ['rupees', 'rupee', 'rs', 'rupaye', 'rupay', '₹'];

/** A rough language guess, used for wording the questions back, never for deciding a number. */
export const detectLanguage = (text: string): Language => {
  const lower = text.toLowerCase();
  const words = lower.split(/\s+/).filter((w) => w.length > 0);
  if (/[ऀ-ॿ]/.test(text)) return 'hi';
  const hindiMarkers = ['ko', 'ka', 'ke', 'ki', 'becho', 'bech', 'se', 'aur', 'hai', 'per'];
  const hindiHits = words.filter((w) => hindiMarkers.includes(w) || w in HINDI_UNITS || w in HINDI_TENS || w in HINDI_COMPOUNDS).length;
  if (hindiHits === 0) return 'en';
  const englishHits = words.filter((w) => w in ENGLISH_UNITS || w in ENGLISH_TENS || ['sell', 'boxes', 'to', 'at', 'per'].includes(w)).length;
  return englishHits > 0 ? 'hinglish' : 'hi';
};

/** Devanagari digits to Latin, so "७०" is seventy without a model being involved. */
export const normaliseDigits = (text: string): string =>
  [...text].map((ch) => DEVANAGARI_DIGITS[ch] ?? ch).join('');
