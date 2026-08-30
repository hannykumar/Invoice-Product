/**
 * Issue #37 [E37] — turning approved columns into records the product can actually hold.
 *
 * A row either becomes a typed record or it is refused with reasons written for the person who has
 * to fix it, and those reasons go straight into the error file. There is no third outcome, and in
 * particular there is no "imported with a blank where the number should have been".
 *
 * Where a value has a meaning the rest of the product already owns — a GST number's checksum, a
 * state code, an HSN code, a unit — the check is GPT 3's from `packages/masters`, not a second copy
 * of the same rule living here.
 */
import { mulDiv, zero, type IsoDate, type Money } from '@invoice/kernel';
import { GST_STATE_CODES, normalisePhone, validateGstin, validateHsnOrSac, validatePan, validatePincode } from '../../masters/src/validation.ts';
import type { Quantity } from '../../masters/src/units.ts';
import { isBlank, readDate, readInteger, readMoney, readPercent, readQuantity, readSide, type Read } from './coerce.ts';
import type {
  Bilingual, ColumnMapping, CustomerRow, EntityKind, ItemRow, OpeningBalanceRow, OpeningStockRow, RowOutcome, RowProblem,
} from './model.ts';

export interface ReadRowsOptions {
  /** Unit to use when an item file does not say. A warning is raised on every row that needs it. */
  readonly defaultUnit?: string;
  /** Date opening stock is as on, when the file has no date column. */
  readonly asOn: IsoDate;
  readonly defaultWarehouseRef?: string;
  /** For a party file: which kind of party the whole file is. */
  readonly partyKind?: 'CUSTOMER' | 'SUPPLIER';
}

interface Cells {
  /** The first mapped column for a field, trimmed. Empty string when unmapped or blank. */
  one(field: string): string;
  /** Every mapped column for a repeatable field, blanks dropped. */
  many(field: string): string[];
  /** Whether any column was mapped to this field at all. */
  has(field: string): boolean;
  readonly headerOf: (field: string) => string | null;
}

const cellsFor = (mapping: readonly ColumnMapping[], row: readonly string[]): Cells => {
  const byField = new Map<string, ColumnMapping[]>();
  for (const column of mapping) {
    if (column.field === null) continue;
    const existing = byField.get(column.field);
    if (existing === undefined) byField.set(column.field, [column]);
    else existing.push(column);
  }
  const valuesOf = (field: string): string[] =>
    (byField.get(field) ?? []).map((column) => (row[column.index] ?? '').trim());
  return {
    one: (field) => valuesOf(field).find((value) => value !== '') ?? '',
    many: (field) => valuesOf(field).filter((value) => value !== ''),
    has: (field) => byField.has(field),
    headerOf: (field) => byField.get(field)?.[0]?.header ?? null,
  };
};

class RowNotes {
  readonly #problems: RowProblem[] = [];
  readonly #row: number;

  constructor(row: number) {
    this.#row = row;
  }

  add(severity: RowProblem['severity'], code: string, column: string | null, value: string, message: Bilingual): void {
    this.#problems.push({ row: this.#row, column, code, severity, message, value });
  }

  blocking(code: string, column: string | null, value: string, en: string, hi: string): void {
    this.add('BLOCKING', code, column, value, { 'en-IN': en, 'hi-IN': hi });
  }

  warn(code: string, column: string | null, value: string, en: string, hi: string): void {
    this.add('WARNING', code, column, value, { 'en-IN': en, 'hi-IN': hi });
  }

  /** Records a failed read from `coerce.ts` at the given severity and returns null. */
  fromRead<T>(read: Read<T>, severity: RowProblem['severity'], column: string | null, value: string): T | null {
    if (read.ok) {
      if (read.note !== undefined) this.add('WARNING', 'READ_ASSUMPTION', column, value, read.note);
      return read.value;
    }
    this.add(severity, read.code, column, value, read.message);
    return null;
  }

  get problems(): readonly RowProblem[] {
    return this.#problems;
  }

  get blocked(): boolean {
    return this.#problems.some((problem) => problem.severity === 'BLOCKING');
  }
}

const STATE_BY_NAME = new Map<string, string>(
  Object.entries(GST_STATE_CODES).map(([code, state]) => [state.name.toLowerCase(), code]),
);

/** "29", "Karnataka" and "karnataka " all mean state 29. Anything else is refused. */
const readStateCode = (value: string): string | null => {
  const text = value.trim();
  if (/^\d{1,2}$/.test(text)) {
    const padded = text.padStart(2, '0');
    return GST_STATE_CODES[padded] === undefined ? null : padded;
  }
  return STATE_BY_NAME.get(text.toLowerCase()) ?? null;
};

const buildParty = (cells: Cells, notes: RowNotes, options: ReadRowsOptions): CustomerRow | null => {
  const name = cells.one('name');
  if (name === '') {
    notes.blocking('NAME_MISSING', cells.headerOf('name'), '', 'This row has no name, so there is nobody to add.', 'Is row mein naam nahin hai, isliye kisi ko jodha nahin ja sakta.');
    return null;
  }

  let gstin: string | null = null;
  const gstinCell = cells.one('gstin');
  if (gstinCell !== '') {
    const verdict = validateGstin(gstinCell);
    if (verdict.ok) gstin = gstinCell.replace(/[\s-]/g, '').toUpperCase();
    else {
      notes.warn(
        'GSTIN_UNUSABLE', cells.headerOf('gstin'), gstinCell,
        `The GST number "${gstinCell}" does not match the rest of it, so a digit was probably mistyped. ${name} will be brought in without it.`,
        `GST number "${gstinCell}" ke ank aapas mein mel nahin khaate, shaayad koi ank galat type hua hai. ${name} ko iske bina joda jaayega.`,
      );
    }
  }

  let pan: string | null = null;
  const panCell = cells.one('pan');
  if (panCell !== '') {
    if (validatePan(panCell).ok) pan = panCell.toUpperCase();
    else notes.warn('PAN_UNUSABLE', cells.headerOf('pan'), panCell, `"${panCell}" is not a PAN we can use, so it will be left blank.`, `"${panCell}" sahi PAN nahin hai, ise khaali chhoda jaayega.`);
  }

  const phones = cells.many('phone').map((phone) => normalisePhone(phone)).filter((phone): phone is string => phone !== null);
  if (cells.many('phone').length > phones.length) {
    notes.warn('PHONE_UNUSABLE', cells.headerOf('phone'), cells.one('phone'), 'One phone number could not be read and was left out.', 'Ek phone number padha nahin ja saka aur chhod diya gaya.');
  }

  let stateCode: string | null = null;
  const stateCell = cells.one('state_code');
  if (stateCell !== '') {
    stateCode = readStateCode(stateCell);
    if (stateCode === null) notes.warn('STATE_UNKNOWN', cells.headerOf('state_code'), stateCell, `We do not recognise the state "${stateCell}".`, `"${stateCell}" raajya pehchaana nahin gaya.`);
  }
  if (stateCode === null && gstin !== null) stateCode = gstin.slice(0, 2);

  const pincodeCell = cells.one('pincode');
  const pincode = pincodeCell === '' || !validatePincode(pincodeCell).ok ? null : pincodeCell.trim();
  if (pincodeCell !== '' && pincode === null) {
    notes.warn('PINCODE_UNUSABLE', cells.headerOf('pincode'), pincodeCell, `"${pincodeCell}" is not a PIN code, so it will be left blank.`, `"${pincodeCell}" PIN code nahin hai, ise khaali chhoda jaayega.`);
  }

  const creditDaysCell = cells.one('credit_days');
  const creditDays = creditDaysCell === '' ? null : notes.fromRead(readInteger(creditDaysCell), 'WARNING', cells.headerOf('credit_days'), creditDaysCell);
  const creditLimitCell = cells.one('credit_limit');
  const creditLimit = creditLimitCell === '' ? null : notes.fromRead(readMoney(creditLimitCell), 'WARNING', cells.headerOf('credit_limit'), creditLimitCell);

  const openingCell = cells.one('opening_balance');
  let openingBalance: Money | null = null;
  let openingSide: 'DEBIT' | 'CREDIT' | null = null;
  if (openingCell !== '' && !isBlank(openingCell)) {
    const read = notes.fromRead(readMoney(openingCell), 'BLOCKING', cells.headerOf('opening_balance'), openingCell);
    if (read !== null) {
      const sideCell = cells.one('opening_side');
      const stated = sideCell === '' ? null : notes.fromRead(readSide(sideCell), 'WARNING', cells.headerOf('opening_side'), sideCell);
      // The sign is the last resort, and a negative figure is never quietly flipped: it is said out
      // loud, because "-4500" against a customer means the opposite thing to "4500 Cr".
      const fromSign = read.amount.minor < 0n;
      openingBalance = { currency: read.amount.currency, minor: read.amount.minor < 0n ? -read.amount.minor : read.amount.minor };
      openingSide =
        stated ??
        read.side ??
        (options.partyKind === 'SUPPLIER' ? (fromSign ? 'DEBIT' : 'CREDIT') : fromSign ? 'CREDIT' : 'DEBIT');
      if (stated === null && read.side === null) {
        notes.warn(
          'OPENING_SIDE_ASSUMED', cells.headerOf('opening_balance'), openingCell,
          openingSide === 'DEBIT'
            ? `"${openingCell}" was taken to mean ${name} owes the business this much. Add a Dr/Cr column if that is the wrong way round.`
            : `"${openingCell}" was taken to mean the business owes ${name} this much. Add a Dr/Cr column if that is the wrong way round.`,
          openingSide === 'DEBIT'
            ? `"${openingCell}" ka matlab liya gaya ki ${name} se itna lena hai. Ulta ho to Dr/Cr column jodein.`
            : `"${openingCell}" ka matlab liya gaya ki ${name} ko itna dena hai. Ulta ho to Dr/Cr column jodein.`,
        );
      }
    }
  }

  return {
    kind: options.partyKind === 'SUPPLIER' ? 'suppliers' : 'customers',
    externalId: cells.one('external_id') === '' ? null : cells.one('external_id'),
    name,
    tradeName: cells.one('trade_name') === '' ? null : cells.one('trade_name'),
    gstin,
    pan,
    phones,
    emails: cells.many('email').filter((email) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)),
    addressLine: cells.one('address') === '' ? null : cells.one('address'),
    city: cells.one('city') === '' ? null : cells.one('city'),
    stateCode,
    pincode,
    creditDays,
    creditLimit: creditLimit === null ? null : creditLimit.amount,
    openingBalance,
    openingSide,
  };
};

const SERVICE_WORDS = /(service|labour|labor|job work|sac|consult)/i;

const buildItem = (cells: Cells, notes: RowNotes, options: ReadRowsOptions): ItemRow | null => {
  const name = cells.one('name');
  if (name === '') {
    notes.blocking('NAME_MISSING', cells.headerOf('name'), '', 'This row has no item name.', 'Is row mein saman ka naam nahin hai.');
    return null;
  }

  const kindCell = cells.one('item_kind');
  const itemKind: 'goods' | 'service' = SERVICE_WORDS.test(kindCell) || (kindCell === '' && SERVICE_WORDS.test(cells.headerOf('hsn_sac') ?? '') && /^99/.test(cells.one('hsn_sac'))) ? 'service' : 'goods';

  const hsnCell = cells.one('hsn_sac');
  if (hsnCell === '') {
    notes.blocking(
      'HSN_MISSING', cells.headerOf('hsn_sac'), '',
      `"${name}" has no HSN code. Every item needs one before it can go on a GST bill, so add it to the file and bring this row in again.`,
      `"${name}" ka HSN code nahin hai. GST bill ke liye har saman ko HSN chahiye; file mein jodkar is row ko dobara laayein.`,
    );
    return null;
  }
  const hsnVerdict = validateHsnOrSac(hsnCell, itemKind);
  if (!hsnVerdict.ok) {
    notes.blocking(
      'HSN_UNUSABLE', cells.headerOf('hsn_sac'), hsnCell,
      `"${hsnCell}" is not an HSN code we can use for "${name}". ${hsnVerdict.problems.map((problem) => problem.message).join(' ')}`,
      `"${hsnCell}" ko "${name}" ke liye HSN code ke roop mein nahin liya ja sakta.`,
    );
    return null;
  }

  let baseUnit = cells.one('base_unit').toUpperCase().replace(/\.$/, '');
  if (baseUnit === '') {
    baseUnit = (options.defaultUnit ?? 'PCS').toUpperCase();
    notes.warn(
      'UNIT_ASSUMED', cells.headerOf('base_unit'), '',
      `"${name}" does not say what it is counted in, so it will be kept in ${baseUnit}.`,
      `"${name}" kis unit mein ginaa jaata hai, file mein nahin likha; ise ${baseUnit} mein rakha jaayega.`,
    );
  }

  const sellingCell = cells.one('selling_rate');
  const purchaseCell = cells.one('purchase_rate');
  const gstCell = cells.one('gst_rate');
  const selling = sellingCell === '' ? null : notes.fromRead(readMoney(sellingCell), 'WARNING', cells.headerOf('selling_rate'), sellingCell);
  const purchase = purchaseCell === '' ? null : notes.fromRead(readMoney(purchaseCell), 'WARNING', cells.headerOf('purchase_rate'), purchaseCell);
  const gstRate = gstCell === '' ? null : notes.fromRead(readPercent(gstCell), 'WARNING', cells.headerOf('gst_rate'), gstCell);

  return {
    externalId: cells.one('external_id') === '' ? null : cells.one('external_id'),
    name,
    itemKind,
    hsnSac: hsnCell.replace(/\s/g, ''),
    baseUnit,
    barcodes: cells.many('barcode'),
    sellingRate: selling === null ? null : selling.amount,
    purchaseRate: purchase === null ? null : purchase.amount,
    gstRateBasisPoints: gstRate,
  };
};

const buildStock = (cells: Cells, notes: RowNotes, options: ReadRowsOptions): OpeningStockRow | null => {
  const itemRef = cells.one('item_ref');
  if (itemRef === '') {
    notes.blocking('ITEM_MISSING', cells.headerOf('item_ref'), '', 'This row does not say which item the stock is of.', 'Is row mein nahin likha ki yeh stock kis saman ka hai.');
    return null;
  }
  const quantityCell = cells.one('quantity');
  const quantity = notes.fromRead(readQuantity(quantityCell, cells.one('unit') || options.defaultUnit || ''), 'BLOCKING', cells.headerOf('quantity'), quantityCell) as Quantity | null;
  if (quantity === null) return null;
  if (quantity.scaled < 0n) {
    notes.blocking(
      'STOCK_NEGATIVE', cells.headerOf('quantity'), quantityCell,
      `"${itemRef}" is shown as ${quantityCell}, which is less than nothing. Opening stock cannot start below zero, so check the old system's figure.`,
      `"${itemRef}" ki maatra ${quantityCell} hai, jo shoonya se kam hai. Shuruaati stock shoonya se kam nahin ho sakta.`,
    );
    return null;
  }

  let value: Money = zero('INR');
  const valueCell = cells.one('value');
  const rateCell = cells.one('rate');
  if (valueCell !== '') {
    const read = notes.fromRead(readMoney(valueCell), 'BLOCKING', cells.headerOf('value'), valueCell);
    if (read === null) return null;
    value = read.amount;
  } else if (rateCell !== '') {
    const read = notes.fromRead(readMoney(rateCell), 'BLOCKING', cells.headerOf('rate'), rateCell);
    if (read === null) return null;
    value = mulDiv(read.amount, quantity.scaled, 1_000_000n);
    if ((read.amount.minor * quantity.scaled) % 1_000_000n !== 0n) {
      notes.warn(
        'VALUE_ROUNDED', cells.headerOf('rate'), rateCell,
        `The rate times the quantity does not come to a whole number of paise, so the value was rounded to the nearest paisa. The stock count itself is exact.`,
        `Dar aur maatra ka guna poore paise mein nahin aata, isliye keemat nazdeeki paise tak li gayi hai. Maatra bilkul theek hai.`,
      );
    }
  } else {
    notes.warn(
      'VALUE_MISSING', null, '',
      `The file does not say what "${itemRef}" is worth, so the stock will be brought in with no value against it.`,
      `File mein "${itemRef}" ki keemat nahin di gayi, isliye stock bina keemat ke laaya jaayega.`,
    );
  }

  const dateCell = cells.one('as_on');
  const asOn = dateCell === '' ? options.asOn : notes.fromRead(readDate(dateCell), 'BLOCKING', cells.headerOf('as_on'), dateCell);
  if (asOn === null) return null;

  return {
    itemRef,
    warehouseRef: cells.one('warehouse_ref') === '' ? (options.defaultWarehouseRef ?? null) : cells.one('warehouse_ref'),
    batchNumber: cells.one('batch_number') === '' ? null : cells.one('batch_number'),
    quantity,
    value,
    asOn,
  };
};

const CUSTOMER_GROUPS = /(debtor|customer|receivable|sales)/i;
const SUPPLIER_GROUPS = /(creditor|supplier|vendor|payable|purchase)/i;

const buildBalance = (cells: Cells, notes: RowNotes, options: ReadRowsOptions): OpeningBalanceRow | null => {
  const partyRef = cells.one('party_ref');
  const accountCode = cells.one('account_code');
  if (partyRef === '' && accountCode === '') {
    notes.blocking('TARGET_MISSING', null, '', 'This row does not say which account or which customer it belongs to.', 'Is row mein nahin likha ki yeh kis khaate ya kis party ka hai.');
    return null;
  }

  let debit = zero('INR');
  let credit = zero('INR');
  const debitCell = cells.one('debit');
  const creditCell = cells.one('credit');
  if (cells.has('debit') || cells.has('credit')) {
    if (debitCell !== '') {
      const read = notes.fromRead(readMoney(debitCell), 'BLOCKING', cells.headerOf('debit'), debitCell);
      if (read === null) return null;
      debit = read.amount;
    }
    if (creditCell !== '') {
      const read = notes.fromRead(readMoney(creditCell), 'BLOCKING', cells.headerOf('credit'), creditCell);
      if (read === null) return null;
      credit = read.amount;
    }
  } else {
    const amountCell = cells.one('amount');
    if (amountCell === '') {
      notes.blocking('AMOUNT_MISSING', cells.headerOf('amount'), '', 'This row has no amount.', 'Is row mein rakam nahin hai.');
      return null;
    }
    const read = notes.fromRead(readMoney(amountCell), 'BLOCKING', cells.headerOf('amount'), amountCell);
    if (read === null) return null;
    const sideCell = cells.one('side');
    const stated = sideCell === '' ? null : notes.fromRead(readSide(sideCell), 'BLOCKING', cells.headerOf('side'), sideCell);
    const side = stated ?? read.side;
    if (side === null) {
      notes.blocking(
        'SIDE_MISSING', cells.headerOf('amount'), amountCell,
        `"${amountCell}" does not say whether it is a debit or a credit, and an opening balance cannot be guessed. Add a Dr/Cr column.`,
        `"${amountCell}" ke saath Dr ya Cr nahin likha, aur shuruaati baaki ka andaaza nahin lagaya ja sakta. Dr/Cr column jodein.`,
      );
      return null;
    }
    const magnitude: Money = { currency: read.amount.currency, minor: read.amount.minor < 0n ? -read.amount.minor : read.amount.minor };
    const flipped = read.amount.minor < 0n;
    const effective = flipped ? (side === 'DEBIT' ? 'CREDIT' : 'DEBIT') : side;
    if (effective === 'DEBIT') debit = magnitude;
    else credit = magnitude;
  }

  if (debit.minor === 0n && credit.minor === 0n) {
    notes.warn('ZERO_BALANCE', null, '', 'This row is zero on both sides, so nothing will be recorded for it.', 'Is row mein dono taraf shoonya hai, isliye kuch darj nahin hoga.');
  }
  if (debit.minor !== 0n && credit.minor !== 0n) {
    notes.blocking(
      'BOTH_SIDES', null, `${debitCell} / ${creditCell}`,
      'This row has an amount on both sides. An opening balance belongs on one side only.',
      'Is row mein dono taraf rakam hai. Shuruaati baaki sirf ek taraf hoti hai.',
    );
    return null;
  }

  const groupCell = cells.one('party_kind');
  const stated = partyRef !== '' && (CUSTOMER_GROUPS.test(groupCell) || SUPPLIER_GROUPS.test(groupCell) || options.partyKind !== undefined);
  const partyKind: 'CUSTOMER' | 'SUPPLIER' | null =
    partyRef === ''
      ? null
      : CUSTOMER_GROUPS.test(groupCell)
        ? 'CUSTOMER'
        : SUPPLIER_GROUPS.test(groupCell)
          ? 'SUPPLIER'
          : (options.partyKind ?? (debit.minor > 0n ? 'CUSTOMER' : 'SUPPLIER'));
  if (partyRef !== '' && !stated && accountCode === '') {
    notes.warn(
      'PARTY_KIND_ASSUMED', null, partyRef,
      partyKind === 'CUSTOMER'
        ? `"${partyRef}" was taken to be a customer, because the business is owed this money.`
        : `"${partyRef}" was taken to be a supplier, because the business owes this money.`,
      partyKind === 'CUSTOMER'
        ? `"${partyRef}" ko customer maana gaya, kyunki yeh rakam lena hai.`
        : `"${partyRef}" ko supplier maana gaya, kyunki yeh rakam dena hai.`,
    );
  }

  return {
    accountCode: accountCode === '' ? null : accountCode,
    partyRef: partyRef === '' ? null : partyRef,
    partyKind,
    partyKindStated: stated,
    label: partyRef !== '' ? partyRef : accountCode,
    debit,
    credit,
  };
};

/** Reads every data row of the sheet through the approved mapping. */
export const readRows = (
  entity: EntityKind,
  sheet: { readonly rows: readonly (readonly string[])[]; readonly rowNumbers: readonly number[]; readonly headers: readonly string[] },
  mapping: readonly ColumnMapping[],
  options: ReadRowsOptions,
): RowOutcome[] =>
  sheet.rows.map((row, index) => {
    const rowNumber = sheet.rowNumbers[index] ?? index + 2;
    const notes = new RowNotes(rowNumber);
    const cells = cellsFor(mapping, row);
    const raw: Record<string, string> = {};
    sheet.headers.forEach((header, column) => {
      raw[header] = row[column] ?? '';
    });

    const parsed =
      entity === 'items'
        ? buildItem(cells, notes, options)
        : entity === 'opening_stock'
          ? buildStock(cells, notes, options)
          : entity === 'opening_balances'
            ? buildBalance(cells, notes, options)
            : buildParty(cells, notes, { ...options, partyKind: options.partyKind ?? (entity === 'suppliers' ? 'SUPPLIER' : 'CUSTOMER') });

    const rejected = parsed === null || notes.blocked;
    return {
      row: rowNumber,
      raw,
      parsed: rejected ? null : parsed,
      problems: notes.problems,
      decision: rejected ? ('REJECT' as const) : ('ACCEPT' as const),
      duplicateOf: null,
    };
  });
