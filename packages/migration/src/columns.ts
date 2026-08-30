/**
 * Issue #37 [E37] — working out which column is which, and then asking.
 *
 * The product guesses; a person decides. Everything here produces a *proposal*: a best guess per
 * column with a confidence and the runners-up, so the screen can say "this column looks like the
 * customer's GST number — is that right?" rather than quietly deciding. Nothing is committed until
 * someone approves the mapping, and the approval is pinned to a fingerprint of it (see
 * `service.ts`), so a mapping cannot be changed after approval without being approved again.
 *
 * The synonym lists are the accumulated shape of real exports: Tally's "Party's Name", BUSY's
 * "Party Name", Vyapar's "Party Name"/"Phone No", and the transliterations people type by hand.
 */
import { createHash } from 'node:crypto';
import { CONFIRM_BELOW, type ColumnMapping, type EntityKind, type MappingProposal, type SourceSystem } from './model.ts';

export interface FieldSpec {
  readonly id: string;
  readonly label: string;
  /** Headers that mean this field. Compared after normalisation, so case and spacing do not matter. */
  readonly synonyms: readonly string[];
  /** A field the import genuinely cannot proceed without. */
  readonly required?: true;
  /** Several columns may supply this field (three phone columns, two barcode columns). */
  readonly repeatable?: true;
}

const PARTY_FIELDS: readonly FieldSpec[] = [
  { id: 'external_id', label: 'Their reference or code', synonyms: ['code', 'party code', 'customer code', 'supplier code', 'ledger code', 'account code', 'id', 'sr no', 'serial no'] },
  { id: 'name', label: 'Name', synonyms: ['name', 'party name', "party's name", 'customer name', 'supplier name', 'ledger name', 'account name', 'business name', 'firm name', 'naam'], required: true },
  { id: 'trade_name', label: 'Shop name', synonyms: ['trade name', 'display name', 'shop name', 'alias', 'short name'] },
  { id: 'gstin', label: 'GST number', synonyms: ['gstin', 'gst no', 'gst number', 'gstin/uin', 'gst in', 'gstin no', 'tax number', 'gst registration no'] },
  { id: 'pan', label: 'PAN', synonyms: ['pan', 'pan no', 'pan number', 'income tax no'] },
  { id: 'phone', label: 'Phone', synonyms: ['phone', 'phone no', 'mobile', 'mobile no', 'contact', 'contact no', 'phone number', 'whatsapp', 'telephone'], repeatable: true },
  { id: 'email', label: 'Email', synonyms: ['email', 'email id', 'e mail', 'email address'], repeatable: true },
  { id: 'address', label: 'Address', synonyms: ['address', 'billing address', 'address line 1', 'address 1', 'street', 'mailing address'] },
  { id: 'city', label: 'City', synonyms: ['city', 'town', 'place', 'district'] },
  { id: 'state_code', label: 'State', synonyms: ['state', 'state code', 'state name', 'gst state code', 'place of supply'] },
  { id: 'pincode', label: 'PIN code', synonyms: ['pincode', 'pin code', 'pin', 'postal code', 'zip'] },
  { id: 'credit_days', label: 'Credit days', synonyms: ['credit days', 'credit period', 'payment terms days', 'due days'] },
  { id: 'credit_limit', label: 'Credit limit', synonyms: ['credit limit', 'limit', 'credit limit amount'] },
  { id: 'opening_balance', label: 'Opening balance', synonyms: ['opening balance', 'opening bal', 'balance', 'closing balance', 'outstanding', 'due amount', 'amount due', 'receivable', 'payable', 'baki'] },
  { id: 'opening_side', label: 'Debit or credit', synonyms: ['dr/cr', 'drcr', 'type', 'balance type', 'debit/credit', 'nature'] },
];

const ITEM_FIELDS: readonly FieldSpec[] = [
  { id: 'external_id', label: 'Item code', synonyms: ['code', 'item code', 'product code', 'sku', 'item id', 'alias', 'sr no'] },
  { id: 'name', label: 'Item name', synonyms: ['name', 'item name', 'product name', 'particulars', 'description', 'stock item', 'item', 'saman'], required: true },
  { id: 'item_kind', label: 'Goods or service', synonyms: ['type', 'item type', 'kind', 'goods/service', 'nature'] },
  { id: 'hsn_sac', label: 'HSN or SAC code', synonyms: ['hsn', 'hsn code', 'sac', 'sac code', 'hsn/sac', 'hsn sac code', 'hsncode'] },
  { id: 'base_unit', label: 'Unit', synonyms: ['unit', 'uom', 'base unit', 'unit of measure', 'unit of measurement', 'primary unit', 'measurement unit'] },
  { id: 'barcode', label: 'Barcode', synonyms: ['barcode', 'bar code', 'ean', 'upc', 'item barcode'], repeatable: true },
  { id: 'selling_rate', label: 'Selling price', synonyms: ['sale price', 'selling price', 'sales rate', 'rate', 'mrp', 'price', 'sale rate', 'selling rate'] },
  { id: 'purchase_rate', label: 'Purchase price', synonyms: ['purchase price', 'purchase rate', 'cost price', 'cost', 'buying price'] },
  { id: 'gst_rate', label: 'GST rate', synonyms: ['gst', 'gst %', 'gst rate', 'tax rate', 'tax %', 'gst percentage', 'rate of tax'] },
];

const STOCK_FIELDS: readonly FieldSpec[] = [
  { id: 'item_ref', label: 'Item', synonyms: ['item', 'item name', 'product', 'product name', 'particulars', 'stock item', 'item code', 'name', 'description'], required: true },
  { id: 'warehouse_ref', label: 'Godown', synonyms: ['godown', 'warehouse', 'location', 'store', 'branch'] },
  { id: 'batch_number', label: 'Batch', synonyms: ['batch', 'batch no', 'batch number', 'lot', 'lot no'] },
  { id: 'quantity', label: 'Quantity', synonyms: ['quantity', 'qty', 'closing qty', 'closing quantity', 'stock', 'stock qty', 'opening qty', 'balance qty', 'maal'], required: true },
  { id: 'unit', label: 'Unit', synonyms: ['unit', 'uom', 'units', 'unit of measure'] },
  { id: 'value', label: 'Total value', synonyms: ['value', 'amount', 'closing value', 'stock value', 'total value', 'opening value'] },
  { id: 'rate', label: 'Rate per unit', synonyms: ['rate', 'cost', 'unit rate', 'cost price', 'rate per unit', 'purchase rate'] },
  { id: 'as_on', label: 'As on date', synonyms: ['as on', 'as on date', 'date', 'stock as on', 'opening date'] },
];

const BALANCE_FIELDS: readonly FieldSpec[] = [
  { id: 'account_code', label: 'Account code', synonyms: ['account code', 'ledger code', 'code', 'gl code', 'account no'] },
  { id: 'party_ref', label: 'Customer or supplier', synonyms: ['party', 'party name', 'customer', 'supplier', 'ledger', 'ledger name', 'account name', 'particulars', 'name'] },
  { id: 'party_kind', label: 'Customer or supplier?', synonyms: ['party type', 'ledger group', 'group', 'under', 'category', 'account type'] },
  { id: 'debit', label: 'Debit', synonyms: ['debit', 'dr', 'debit amount', 'debit balance'] },
  { id: 'credit', label: 'Credit', synonyms: ['credit', 'cr', 'credit amount', 'credit balance'] },
  { id: 'amount', label: 'Amount', synonyms: ['amount', 'balance', 'opening balance', 'closing balance', 'value'] },
  { id: 'side', label: 'Debit or credit', synonyms: ['dr/cr', 'drcr', 'type', 'balance type', 'debit/credit', 'nature'] },
];

export const FIELDS: Readonly<Record<EntityKind, readonly FieldSpec[]>> = {
  customers: PARTY_FIELDS,
  suppliers: PARTY_FIELDS,
  items: ITEM_FIELDS,
  opening_stock: STOCK_FIELDS,
  opening_balances: BALANCE_FIELDS,
};

export const fieldSpec = (entity: EntityKind, id: string): FieldSpec | undefined =>
  FIELDS[entity].find((field) => field.id === id);

/** Lower case, no punctuation, single spaces — "Party's Name" and "PARTY NAME" become one thing. */
export const normaliseHeader = (header: string): string =>
  header
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, ' ')
    .replace(/\bnos?\b/g, 'no')
    .trim()
    .replace(/\s+/g, ' ');

const scoreHeader = (header: string, field: FieldSpec): number => {
  const target = normaliseHeader(header);
  if (target === '') return 0;
  const synonyms = field.synonyms.map(normaliseHeader);
  if (synonyms.includes(target)) return 1;
  // "Customer GSTIN" contains "gstin"; a containing match is good but worth asking about.
  const contained = synonyms.filter((synonym) => target === synonym || target.includes(` ${synonym}`) || target.startsWith(`${synonym} `) || target.endsWith(` ${synonym}`));
  if (contained.length > 0) {
    const longest = Math.max(...contained.map((synonym) => synonym.length));
    return longest >= 5 ? 0.85 : 0.7;
  }
  const words = new Set(target.split(' '));
  const best = synonyms.reduce((accumulator, synonym) => {
    const parts = synonym.split(' ');
    const shared = parts.filter((part) => words.has(part)).length;
    return Math.max(accumulator, parts.length === 0 ? 0 : shared / parts.length);
  }, 0);
  return best >= 0.5 ? Number((0.5 + best * 0.25).toFixed(2)) : 0;
};

/** How well a set of headers fits one kind of import. Used to guess what the file is. */
export const scoreEntity = (headers: readonly string[], entity: EntityKind): number => {
  const specs = FIELDS[entity];
  let total = 0;
  const claimed = new Set<string>();
  for (const header of headers) {
    let best = 0;
    let bestId = '';
    for (const spec of specs) {
      const score = scoreHeader(header, spec);
      if (score > best) {
        best = score;
        bestId = spec.id;
      }
    }
    if (best >= 0.7 && (!claimed.has(bestId) || (fieldSpec(entity, bestId)?.repeatable ?? false))) {
      claimed.add(bestId);
      total += best;
    }
  }
  const requiredMet = specs.filter((spec) => spec.required === true && claimed.has(spec.id)).length;
  const requiredCount = specs.filter((spec) => spec.required === true).length;
  if (requiredCount > 0 && requiredMet < requiredCount) total -= 2;
  // A stock file and an item file share "item name"; the distinguishing columns are worth more.
  return total;
};

/** Signature columns that only one of these products writes. Only ever changes the guesses. */
export const detectSourceSystem = (headers: readonly string[]): SourceSystem => {
  const normalised = headers.map(normaliseHeader);
  const has = (value: string): boolean => normalised.includes(value);
  if (has('party s name') || has('under') || has('closing qty') || has('stock item')) return 'TALLY';
  if (has('ledger group') || has('party code') || has('bill by bill')) return 'BUSY';
  if (has('phone no') && (has('party name') || has('item name'))) return 'VYAPAR';
  if (has('marg code') || has('company name mfg')) return 'MARG';
  return 'GENERIC';
};

/** The best guess of what this file is a list of, with the runners-up. */
export const detectEntity = (headers: readonly string[]): { entity: EntityKind; confidence: number; alternatives: EntityKind[] } => {
  const scored = (Object.keys(FIELDS) as EntityKind[])
    .map((entity) => ({ entity, score: scoreEntity(headers, entity) }))
    .sort((left, right) => right.score - left.score);
  const [best, second] = scored as [{ entity: EntityKind; score: number }, { entity: EntityKind; score: number } | undefined];
  const gap = best.score - (second?.score ?? 0);
  const confidence = best.score <= 0 ? 0 : Math.min(1, Number((0.55 + gap * 0.15).toFixed(2)));
  return {
    entity: best.entity,
    confidence,
    alternatives: scored.slice(1).filter((candidate) => candidate.score > 0).map((candidate) => candidate.entity),
  };
};

/** The weakest guess worth showing at all. Anything below is left unmapped, not proposed. */
export const CLAIM_FLOOR = 0.7;

export const fingerprintOf = (columns: readonly ColumnMapping[]): string =>
  createHash('sha256')
    .update(JSON.stringify(columns.map((column) => [column.index, column.header, column.field])))
    .digest('hex')
    .slice(0, 32);

/**
 * Proposes a mapping for one file.
 *
 * A field is claimed by the strongest column that wants it, so a file with both "Name" and
 * "Customer Name" gives `name` to the more specific one and leaves the other to be mapped by hand
 * rather than fighting over it.
 */
export const proposeMapping = (
  headers: readonly string[],
  entity: EntityKind,
  sourceSystem: SourceSystem = detectSourceSystem(headers),
): MappingProposal => {
  const specs = FIELDS[entity];
  const scores = headers.map((header, index) =>
    specs
      .map((spec) => ({ id: spec.id, score: scoreHeader(header, spec) }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score)
      .map((candidate) => ({ ...candidate, index })),
  );

  const takenBy = new Map<string, number>();
  const chosen = new Map<number, { id: string; score: number }>();
  // Strongest claim first, so the clearest header wins a field that two columns could fill.
  const claims = scores.flat().sort((left, right) => right.score - left.score || left.index - right.index);
  for (const claim of claims) {
    if (chosen.has(claim.index)) continue;
    const spec = fieldSpec(entity, claim.id);
    if (takenBy.has(claim.id) && spec?.repeatable !== true) continue;
    // Below this the guess is too weak to state at all: the column is left unmapped for the person
    // to place, which is a smaller cost than quietly putting a customer's name into "shop name".
    if (claim.score < CLAIM_FLOOR) continue;
    chosen.set(claim.index, { id: claim.id, score: claim.score });
    takenBy.set(claim.id, claim.index);
  }

  const columns: ColumnMapping[] = headers.map((header, index) => {
    const pick = chosen.get(index);
    const alternatives = (scores[index] ?? [])
      .filter((candidate) => candidate.id !== pick?.id)
      .slice(0, 3)
      .map((candidate) => candidate.id);
    return {
      header,
      index,
      field: pick?.id ?? null,
      confidence: pick === undefined ? 0 : pick.score,
      alternatives,
    };
  });

  const mapped = new Set(columns.map((column) => column.field).filter((field): field is string => field !== null));
  return {
    entity,
    sourceSystem,
    columns,
    unmapped: columns.filter((column) => column.field === null).map((column) => column.header),
    missingRequired: specs.filter((spec) => spec.required === true && !mapped.has(spec.id)).map((spec) => spec.id),
    fingerprint: fingerprintOf(columns),
  };
};

/** Columns the screen must ask about rather than state. */
export const needsConfirmation = (proposal: MappingProposal): readonly ColumnMapping[] =>
  proposal.columns.filter((column) => column.field !== null && column.confidence < CONFIRM_BELOW);

/**
 * Whether a file looks like a list of past bills rather than a list of things.
 *
 * Historical vouchers are deliberately out of scope for this route (issue #37: "optional historical
 * vouchers only through a separately validated format"). Reading a sales register in as customers
 * would be worse than refusing it, so it is detected and refused by name — see
 * `docs/contracts/migration.v1.md` for the separate format that will carry them.
 */
export const looksLikeTransactions = (headers: readonly string[]): boolean => {
  const normalised = new Set(headers.map(normaliseHeader));
  const documentColumn = ['invoice no', 'invoice number', 'bill no', 'voucher no', 'voucher number', 'document no', 'invoice date', 'voucher date', 'bill date']
    .some((candidate) => normalised.has(candidate));
  const hasDate = [...normalised].some((header) => header.includes('date'));
  const hasAmount = [...normalised].some((header) => ['amount', 'total', 'taxable value', 'invoice value', 'net amount'].includes(header));
  return documentColumn && hasDate && hasAmount;
};
