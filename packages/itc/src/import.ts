/**
 * Issue #31 [E31] — getting the government's list into the app.
 *
 * "File import first and GSP download later" is the issue's own instruction, and it is the right
 * way round: a business can always download its GSTR-2B from the portal itself, and most of them
 * will do exactly that for years before anybody pays a licensed intermediary. So the file is the
 * first-class path and the download (`PortalRecordSource`) is an optional convenience that
 * produces *the same records through the same reader*. The equivalence is tested, not assumed.
 *
 * Three formats are read here.
 *
 *   - **The portal's GSTR-2B JSON**, as downloaded. Its own field names (`ctin`, `inum`, `txval`)
 *     and its own date format (`05-07-2026`) are handled here so nothing downstream has to know
 *     them.
 *   - **A spreadsheet exported as CSV**, because that is what accountants actually send each
 *     other, and because a business on IMS often has a working copy in Excel long before it has a
 *     clean file.
 *   - **A row typed in by a person**, reading the portal on a screen. This is not a lesser path:
 *     the shop's internet is bad, the download button fails, the accountant reads out four figures
 *     over the phone. What changes is the recorded source — evidence from a person rather than
 *     from a file — never the rules applied afterwards.
 *
 * **Money never passes through a float.** Amounts are read as exact decimal strings and converted
 * to paise. Where a JSON file gives a number rather than a string, it is converted through its
 * shortest decimal form and refused if that form carries more than two decimal places. Refused
 * rows are returned with the reason and the row they came from; nothing is dropped quietly,
 * because a purchase silently missing from the comparison is the one thing this module exists to
 * prevent.
 */
import { createHash } from 'node:crypto';
import { fromDecimalString, type IsoDate, type Money } from '@invoice/kernel';
import { taxPeriod, type DocumentKind, type RecordSource, type TaxAmounts, type TaxPeriod } from './types.ts';

/** A record as a file describes it, before it is given an id and stored. */
export interface ParsedPortalRecord {
  readonly supplierGstin: string;
  readonly supplierName: string | null;
  readonly kind: DocumentKind;
  readonly number: string;
  readonly documentDate: IsoDate;
  readonly amounts: TaxAmounts;
  readonly invoiceValue: Money;
  readonly itcAvailableOnPortal: boolean | null;
  readonly itcUnavailableReason: string | null;
  readonly amends: { readonly number: string; readonly period: TaxPeriod } | null;
  readonly reversed: boolean;
  readonly reverseCharge: boolean;
}

export interface ParseResult {
  readonly period: TaxPeriod | null;
  /** The registration the file was downloaded for, when the file says. */
  readonly gstin: string | null;
  readonly records: readonly ParsedPortalRecord[];
  readonly rejected: readonly { readonly row: string; readonly reason: string }[];
  readonly checksum: string;
}

export const checksumOf = (content: string): string => createHash('sha256').update(content).digest('hex');

// ---------------------------------------------------------------------------- small readers

const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/;

const readGstin = (value: unknown): string => {
  const text = String(value ?? '').trim().toUpperCase();
  if (!GSTIN.test(text)) {
    throw new Error(`"${text}" is not a GST number. A GST number is fifteen characters, like 29AAAAA0000A1ZY.`);
  }
  return text;
};

/**
 * The portal writes dates as `05-07-2026`; a CSV from a spreadsheet usually writes `2026-07-05`.
 *
 * Both are read, and anything else is refused rather than guessed at. `05-07-2026` is unambiguous
 * in Indian usage and this reader does not accept the American order at all: reading a date the
 * wrong way round would move a bill into the wrong month, which is the expensive kind of quiet
 * mistake.
 */
const readDate = (value: unknown): IsoDate => {
  const text = String(value ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text as IsoDate;
  const indian = /^(\d{2})-(\d{2})-(\d{4})$/.exec(text);
  if (indian !== null) return `${indian[3]}-${indian[2]}-${indian[1]}` as IsoDate;
  throw new Error(`"${text}" is not a date this reader understands. Use 05-07-2026 or 2026-07-05.`);
};

/**
 * An amount, exactly.
 *
 * A JSON number arrives as a double, so it is converted through its shortest decimal form and
 * refused if that form is not something the rupee can hold exactly. A string is read as written.
 */
const readMoney = (value: unknown, field: string): Money => {
  if (value === null || value === undefined || value === '') return { currency: 'INR', minor: 0n };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${field} is not a number.`);
    const text = String(value);
    if (/e/i.test(text)) throw new Error(`${field} is written in a form this reader cannot hold exactly: ${text}`);
    const decimals = text.includes('.') ? (text.split('.')[1] as string).length : 0;
    if (decimals > 2) throw new Error(`${field} has more than two decimal places (${text}), so it cannot be an exact rupee amount.`);
    return fromDecimalString(text);
  }
  const text = String(value).replace(/[,\s₹]/g, '').trim();
  if (text === '' || text === '-') return { currency: 'INR', minor: 0n };
  return fromDecimalString(text);
};

const readFlag = (value: unknown): boolean | null => {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim().toUpperCase();
  if (text === 'Y' || text === 'YES' || text === 'TRUE' || text === '1') return true;
  if (text === 'N' || text === 'NO' || text === 'FALSE' || text === '0') return false;
  return null;
};

/** The portal's `072026`, the spreadsheet's `2026-07`, or nothing. */
const readPeriod = (value: unknown): TaxPeriod | null => {
  const text = String(value ?? '').trim();
  if (/^\d{4}-\d{2}$/.test(text)) return taxPeriod(text);
  if (/^\d{6}$/.test(text)) return taxPeriod(`${text.slice(2)}-${text.slice(0, 2)}`);
  return null;
};

const kindOf = (value: unknown, fallback: DocumentKind): DocumentKind => {
  const text = String(value ?? '').trim().toUpperCase();
  if (text === 'C' || text.startsWith('CREDIT') || text === 'CN') return 'CREDIT_NOTE';
  if (text === 'D' || text.startsWith('DEBIT') || text === 'DN') return 'DEBIT_NOTE';
  if (text === 'I' || text.startsWith('INV') || text === 'B2B') return 'INVOICE';
  return fallback;
};

const amountsOf = (row: Record<string, unknown>, prefix: Readonly<Record<string, string>>): TaxAmounts => ({
  taxableValue: readMoney(row[prefix.taxable as string], 'the value before GST'),
  cgst: readMoney(row[prefix.cgst as string], 'the central share of GST'),
  sgst: readMoney(row[prefix.sgst as string], 'the state share of GST'),
  igst: readMoney(row[prefix.igst as string], 'the GST on inter-state purchases'),
  cess: readMoney(row[prefix.cess as string], 'the cess'),
});

// ---------------------------------------------------------------------------- GSTR-2B JSON

interface Gstr2bInvoice extends Record<string, unknown> {
  readonly inum?: string;
  readonly ntnum?: string;
}

/**
 * Reads the file the portal hands over.
 *
 * The shape is the government's, not ours: `data.docdata.b2b[].inv[]` for invoices and
 * `data.docdata.cdnr[].nt[]` for credit and debit notes, each grouped under the supplier's
 * registration. Amendment tables (`b2ba`, `cdnra`) are read too, and their rows carry what they
 * amend, because an amendment silently treated as a fresh document would count one purchase twice.
 */
export const parseGstr2bJson = (content: string): ParseResult => {
  const checksum = checksumOf(content);
  const rejected: { row: string; reason: string }[] = [];
  const records: ParsedPortalRecord[] = [];

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return { period: null, gstin: null, records: [], rejected: [{ row: '(the whole file)', reason: 'This is not a readable GSTR-2B file. Download it again from the portal.' }], checksum };
  }

  const data = (parsed.data ?? parsed) as Record<string, unknown>;
  const period = readPeriod(data.rtnprd ?? data.period);
  const gstin = typeof data.gstin === 'string' && GSTIN.test(data.gstin) ? data.gstin : null;
  const docdata = (data.docdata ?? data.doc_data ?? {}) as Record<string, unknown>;

  const supplierGroups = (key: string): readonly Record<string, unknown>[] =>
    Array.isArray(docdata[key]) ? (docdata[key] as Record<string, unknown>[]) : [];

  const readGroup = (
    key: string,
    listKey: string,
    fallbackKind: DocumentKind,
    isAmendment: boolean,
  ): void => {
    for (const group of supplierGroups(key)) {
      let supplierGstin: string;
      try {
        supplierGstin = readGstin(group.ctin);
      } catch (error) {
        rejected.push({ row: JSON.stringify(group).slice(0, 200), reason: (error as Error).message });
        continue;
      }
      const supplierName = typeof group.trdnm === 'string' ? group.trdnm : null;
      const documents = Array.isArray(group[listKey]) ? (group[listKey] as Gstr2bInvoice[]) : [];
      for (const document of documents) {
        try {
          const number = String(document.inum ?? document.ntnum ?? '').trim();
          if (number === '') throw new Error('This row has no bill number.');
          const availability = readFlag(document.itcavl);
          records.push({
            supplierGstin,
            supplierName,
            kind: kindOf(document.typ ?? document.ntty, fallbackKind),
            number,
            documentDate: readDate(document.dt ?? document.ntdt),
            amounts: amountsOf(document, { taxable: 'txval', cgst: 'cgst', sgst: 'sgst', igst: 'igst', cess: 'cess' }),
            invoiceValue: readMoney(document.val, 'the total on the bill'),
            itcAvailableOnPortal: availability,
            itcUnavailableReason: typeof document.rsn === 'string' && document.rsn.trim() !== '' ? document.rsn.trim() : null,
            amends: isAmendment
              ? {
                number: String(document.oinum ?? document.ontnum ?? number).trim(),
                period: readPeriod(document.oinvdt ?? document.odt ?? period) ?? (period ?? taxPeriod('2000-01')),
              }
              : null,
            reversed: readFlag(document.rev) === true || readFlag(document.reversed) === true,
            reverseCharge: readFlag(document.rchrg) === true,
          });
        } catch (error) {
          rejected.push({ row: JSON.stringify(document).slice(0, 200), reason: (error as Error).message });
        }
      }
    }
  };

  readGroup('b2b', 'inv', 'INVOICE', false);
  readGroup('b2ba', 'inv', 'INVOICE', true);
  readGroup('cdnr', 'nt', 'CREDIT_NOTE', false);
  readGroup('cdnra', 'nt', 'CREDIT_NOTE', true);

  return { period, gstin, records, rejected, checksum };
};

// ---------------------------------------------------------------------------- CSV

/**
 * Column names an accountant's spreadsheet is likely to carry, and the one we mean by each.
 *
 * Matching is done on the header reduced to letters, so "Supplier GSTIN", "supplier_gstin" and
 * "SupplierGstin" are one column. A header this table does not know is kept and ignored rather
 * than rejected: a working file usually has three columns of somebody's notes on the end.
 */
const CSV_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  suppliergstin: 'gstin', gstin: 'gstin', ctin: 'gstin', gstno: 'gstin', gstnumber: 'gstin',
  suppliername: 'name', supplier: 'name', tradename: 'name', partyname: 'name',
  documenttype: 'kind', type: 'kind', kind: 'kind', doctype: 'kind',
  documentnumber: 'number', invoicenumber: 'number', billnumber: 'number', number: 'number', inum: 'number',
  documentdate: 'date', invoicedate: 'date', billdate: 'date', date: 'date',
  taxablevalue: 'taxable', taxvalue: 'taxable', valuebeforegst: 'taxable', txval: 'taxable',
  cgst: 'cgst', centraltax: 'cgst', sgst: 'sgst', statetax: 'sgst', utgst: 'sgst',
  igst: 'igst', integratedtax: 'igst', cess: 'cess',
  invoicevalue: 'total', total: 'total', billvalue: 'total', val: 'total',
  itcavailable: 'itcavl', itcavl: 'itcavl', creditavailable: 'itcavl',
  reason: 'reason', rsn: 'reason',
  reversecharge: 'rchrg', rchrg: 'rchrg',
  reversed: 'reversed', withdrawn: 'reversed',
  amendsnumber: 'amends', originalnumber: 'amends', oinum: 'amends',
  amendsperiod: 'amendsperiod', originalperiod: 'amendsperiod',
});

/** Splits one CSV line, honouring quotes, because a supplier's name has a comma in it soon enough. */
const splitCsvLine = (line: string): readonly string[] => {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] as string;
    if (quoted) {
      if (character === '"' && line[index + 1] === '"') { cell += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === '"') quoted = true;
    else if (character === ',') { cells.push(cell); cell = ''; }
    else cell += character;
  }
  cells.push(cell);
  return cells.map((value) => value.trim());
};

export const parseCsv = (content: string): ParseResult => {
  const checksum = checksumOf(content);
  const rejected: { row: string; reason: string }[] = [];
  const records: ParsedPortalRecord[] = [];

  const lines = content.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length < 2) {
    return { period: null, gstin: null, records: [], rejected: [{ row: '(the whole file)', reason: 'The file has a heading row and nothing under it.' }], checksum };
  }

  const headers = splitCsvLine(lines[0] as string).map((header) => CSV_ALIASES[header.toLowerCase().replace(/[^a-z]/g, '')] ?? header);
  if (!headers.includes('gstin') || !headers.includes('number')) {
    return {
      period: null,
      gstin: null,
      records: [],
      rejected: [{ row: lines[0] as string, reason: "The heading row needs at least a supplier GST number column and a bill number column. Rename the columns to 'Supplier GSTIN' and 'Invoice number' and try again." }],
      checksum,
    };
  }

  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const row: Record<string, unknown> = {};
    headers.forEach((header, index) => { row[header] = cells[index] ?? ''; });
    try {
      const availability = readFlag(row.itcavl);
      const amendsNumber = String(row.amends ?? '').trim();
      records.push({
        supplierGstin: readGstin(row.gstin),
        supplierName: String(row.name ?? '').trim() === '' ? null : String(row.name).trim(),
        kind: kindOf(row.kind, 'INVOICE'),
        number: String(row.number ?? '').trim(),
        documentDate: readDate(row.date),
        amounts: amountsOf(row, { taxable: 'taxable', cgst: 'cgst', sgst: 'sgst', igst: 'igst', cess: 'cess' }),
        invoiceValue: readMoney(row.total, 'the total on the bill'),
        itcAvailableOnPortal: availability,
        itcUnavailableReason: String(row.reason ?? '').trim() === '' ? null : String(row.reason).trim(),
        amends: amendsNumber === '' ? null : { number: amendsNumber, period: readPeriod(row.amendsperiod) ?? taxPeriod('2000-01') },
        reversed: readFlag(row.reversed) === true,
        reverseCharge: readFlag(row.rchrg) === true,
      });
    } catch (error) {
      rejected.push({ row: line.slice(0, 200), reason: (error as Error).message });
    }
  }

  return { period: null, gstin: null, records, rejected, checksum };
};

// ---------------------------------------------------------------------------- typed by a person

export interface TypedPortalRecord {
  readonly supplierGstin: string;
  readonly supplierName?: string;
  readonly kind?: string;
  readonly number: string;
  readonly documentDate: string;
  readonly taxableValue: string;
  readonly cgst?: string;
  readonly sgst?: string;
  readonly igst?: string;
  readonly cess?: string;
  readonly invoiceValue?: string;
  readonly itcAvailableOnPortal?: string;
  readonly itcUnavailableReason?: string;
  readonly reverseCharge?: boolean;
}

/**
 * One row as a person reads it off the portal and types it in.
 *
 * It goes through the same readers as the file, so a typed row is validated exactly as strictly:
 * a mistyped GST number is refused here as it would be there. The only difference the product
 * keeps is the recorded source, which the screens then show — "typed in by a person" beside a
 * figure is a materially different statement from "downloaded from the portal", and pretending
 * otherwise would be the quiet kind of dishonesty this product is built against.
 */
export const parseTypedRecord = (input: TypedPortalRecord): ParsedPortalRecord => {
  const number = input.number.trim();
  if (number === '') throw new Error('Enter the bill number as it appears on the portal.');
  return {
    supplierGstin: readGstin(input.supplierGstin),
    supplierName: input.supplierName === undefined || input.supplierName.trim() === '' ? null : input.supplierName.trim(),
    kind: kindOf(input.kind, 'INVOICE'),
    number,
    documentDate: readDate(input.documentDate),
    amounts: {
      taxableValue: readMoney(input.taxableValue, 'the value before GST'),
      cgst: readMoney(input.cgst, 'the central share of GST'),
      sgst: readMoney(input.sgst, 'the state share of GST'),
      igst: readMoney(input.igst, 'the GST on inter-state purchases'),
      cess: readMoney(input.cess, 'the cess'),
    },
    invoiceValue: readMoney(input.invoiceValue, 'the total on the bill'),
    itcAvailableOnPortal: readFlag(input.itcAvailableOnPortal),
    itcUnavailableReason: input.itcUnavailableReason === undefined || input.itcUnavailableReason.trim() === '' ? null : input.itcUnavailableReason.trim(),
    amends: null,
    reversed: false,
    reverseCharge: input.reverseCharge === true,
  };
};

/** Picks the reader by looking at the content, so a person never has to say which format it is. */
export const parsePortalFile = (content: string, source: RecordSource): ParseResult => {
  const trimmed = content.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return parseGstr2bJson(content);
  if (source === 'PORTAL_API') return parseGstr2bJson(content);
  return parseCsv(content);
};
