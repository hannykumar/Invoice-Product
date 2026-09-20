/**
 * Issue #191 — the e-way bill page the driver carries.
 *
 * Rule 138A(1) lets the person in charge of the vehicle carry the e-way bill *number* electronically:
 * a printed page is a convention, not a legal requirement, so nothing in the product may be blocked
 * for want of one. What this page is for is the checkpoint, where an officer expects to be handed
 * the same sheet the government portal prints.
 *
 * So it is drawn from the portal's own document, not from our invoice design: its five sections keep
 * the portal's headings and its order, because those are the words an officer reads. Everything on it
 * comes from what the portal answered or from the movement the business itself recorded. Nothing here
 * is composed — in particular there is no QR code, because the e-way bill provider gives us no QR
 * content, and a square we drew ourselves on a government document would be a forgery.
 */
import type { EwayBillRecord, Movement, MovementParty, ConsignmentDocument, ConsignmentLine } from '@invoice/transport';
import { STATE_NAMES, readPortalTimestamp } from '@invoice/transport';
import { escapeHtml } from './parts.ts';

/** Plain two-decimal amounts, the way the portal prints them: `94400.00`, no symbol, no separators. */
const amount = (paise: bigint): string => {
  const negative = paise < 0n;
  const absolute = negative ? -paise : paise;
  return `${negative ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
};

/** A rate as hundredths of a percent, so 9% prints as `9.00` without ever touching a float. */
const rate = (taxPaise: bigint, taxablePaise: bigint): string =>
  taxablePaise === 0n ? '0.00' : amount((taxPaise * 10_000n) / taxablePaise);

/** `9.00+9.00+0.00+0.00+0.00` — the portal's C+S+I+Cess+Cess Non.Advol column, in that order. */
const rateColumn = (line: ConsignmentLine): string => [
  rate(line.cgstPaise, line.taxableValuePaise),
  rate(line.sgstPaise, line.taxableValuePaise),
  rate(line.igstPaise, line.taxableValuePaise),
  rate(line.cessPaise, line.taxableValuePaise),
  // Cess on quantity rather than value. We do not model it, and printing a guess would be worse
  // than printing the zero the portal prints when there is none.
  '0.00',
].join('+');

/** Indian wall-clock, the way a driver reads it. Accepts the portal's stamp or an ISO instant. */
const indianDateTime = (raw: string): string => {
  const at = raw.includes('/') ? readPortalTimestamp(raw) : new Date(raw);
  if (Number.isNaN(at.getTime())) return escapeHtml(raw);
  const indian = new Date(at.getTime() + 330 * 60_000);
  const hour24 = indian.getUTCHours();
  const hour = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${String(indian.getUTCDate()).padStart(2, '0')}/${String(indian.getUTCMonth() + 1).padStart(2, '0')}/${indian.getUTCFullYear()} ${String(hour).padStart(2, '0')}:${String(indian.getUTCMinutes()).padStart(2, '0')} ${hour24 < 12 ? 'AM' : 'PM'}`;
};

/** `2026-03-22` as `22/03/2026`, for the document line and the transporter's document date. */
const indianDate = (iso: string): string => {
  const [year, month, day] = iso.split('-');
  return day === undefined ? escapeHtml(iso) : `${day}/${month}/${year}`;
};

const MODE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  ROAD: 'Road', RAIL: 'Rail', AIR: 'Air', SHIP: 'Ship', NON_MOTORISED: 'Non-motorised',
});

const DOCUMENT_NAMES: Readonly<Record<ConsignmentDocument['documentType'], string>> = Object.freeze({
  TAX_INVOICE: 'Tax invoice', BILL_OF_SUPPLY: 'Bill of supply', DELIVERY_CHALLAN: 'Delivery challan',
  CREDIT_NOTE: 'Credit note', BILL_OF_ENTRY: 'Bill of entry',
});

/**
 * The portal's supply type and sub-supply type, joined the way its page prints them.
 *
 * Which side a movement is on is not a matter of taste: goods coming in on an import or a sales
 * return are inward, and everything else the business sends out is outward.
 */
const MOVEMENT_TYPES: Readonly<Record<Movement['reason'], string>> = Object.freeze({
  SUPPLY: 'Outward-Supply', EXPORT: 'Outward-Export', JOB_WORK: 'Outward-Job Work',
  BRANCH_TRANSFER: 'Outward-Branch Transfer', EXHIBITION_OR_FAIRS: 'Outward-Exhibition or Fairs',
  FOR_OWN_USE: 'Outward-For Own Use', SKD_CKD: 'Outward-SKD/CKD', LINE_SALES: 'Outward-Line Sales',
  OTHERS: 'Outward-Others', IMPORT: 'Inward-Import', SALES_RETURN: 'Inward-Sales Return',
});

/** The portal's four transaction types, decided by whether the bill and the goods part company. */
const transactionType = (movement: Movement): string => {
  const shipsElsewhere = movement.shipTo !== undefined;
  const dispatchesElsewhere = movement.dispatchFrom !== undefined;
  if (shipsElsewhere && dispatchesElsewhere) return 'Combination of 2 and 3';
  if (shipsElsewhere) return 'Bill To - Ship To';
  if (dispatchesElsewhere) return 'Bill From - Dispatch From';
  return 'Regular';
};

const stateName = (code: string): string => STATE_NAMES[code] ?? code;

const addressLines = (party: MovementParty): string =>
  [party.address1, party.address2 ?? '', `${party.place}, ${stateName(party.stateCode)} - ${party.pincode}`]
    .filter((line) => line.trim() !== '')
    .map((line) => escapeHtml(line))
    .join('<br>');

const row = (label: string, value: string): string =>
  `<tr><th scope="row">${escapeHtml(label)}</th><td>${value}</td></tr>`;

/** What stops the page being printed at all, or what has to be stamped across it when it is. */
export type EwayPrintBanner = { readonly kind: 'REFUSED' | 'WARNING'; readonly message: string } | null;

/**
 * Whether this record may be printed, and what the page must say about itself.
 *
 * A bill the portal has not answered for has no number, and a page carrying no number is not an
 * e-way bill — it is a piece of paper that looks like one, which is worse than none at all.
 */
export const ewayPrintBanner = (record: EwayBillRecord): EwayPrintBanner => {
  if (record.acknowledgement === undefined) {
    return { kind: 'REFUSED', message: 'The portal has not given an e-way bill number for this movement, so there is nothing to print yet.' };
  }
  if (record.status === 'CANCELLED') {
    return { kind: 'WARNING', message: `CANCELLED on ${record.cancelledAt === undefined ? 'an unrecorded date' : indianDateTime(record.cancelledAt)}` };
  }
  if (record.status === 'EXPIRED') {
    return { kind: 'WARNING', message: `EXPIRED at ${record.acknowledgement.validUntil === undefined ? 'its validity end' : indianDateTime(record.acknowledgement.validUntil)}` };
  }
  if (record.status === 'PART_A_ONLY') {
    return { kind: 'WARNING', message: 'PART-B NOT ENTERED — the goods may not move on this e-way bill yet' };
  }
  return null;
};

/**
 * The page's own rules, kept here rather than in the invoice stylesheet.
 *
 * This is the portal's document, not one of the business's bills: it carries no logo, no template
 * colours and no design choices, and it must not drift when somebody restyles the invoice.
 */
const EWAY_STYLES = `
.eway-title { font-size: 16pt; text-align: center; margin: 0 0 6pt; letter-spacing: 1pt; }
.eway-banner { border: 2pt solid #000; padding: 4pt 6pt; margin: 0 0 8pt; font-weight: 700; text-align: center; }
.sheet h2 { font-size: 10pt; margin: 10pt 0 3pt; border-bottom: 1pt solid #000; text-transform: uppercase; }
.sheet h3, .sheet h4 { font-size: 9pt; margin: 4pt 0 2pt; }
.eway-facts, .eway-goods, .eway-totals, .eway-vehicles { width: 100%; border-collapse: collapse; font-size: 9pt; }
.eway-facts th, .eway-facts td, .eway-totals th, .eway-totals td { text-align: left; padding: 2pt 4pt; border: 0.5pt solid #999; }
.eway-facts th, .eway-totals th { width: 32%; font-weight: 600; }
.eway-goods th, .eway-goods td, .eway-vehicles th, .eway-vehicles td { border: 0.5pt solid #999; padding: 2pt 4pt; text-align: left; }
.eway-goods .amount, .eway-totals .amount { display: block; text-align: right; font-variant-numeric: tabular-nums; }
.eway-addresses { display: flex; gap: 8pt; }
.eway-address { flex: 1 1 50%; border: 0.5pt solid #999; padding: 4pt 6pt; }
.eway-party { margin: 0 0 4pt; font-size: 9pt; line-height: 1.35; }
`;

/** The five sections, in the portal's order and under the portal's headings. */
export const renderEwayBillBody = (record: EwayBillRecord, movement: Movement): string => {
  const acknowledgement = record.acknowledgement;
  if (acknowledgement === undefined) throw new Error('An e-way bill with no number from the portal cannot be printed.');
  const banner = ewayPrintBanner(record);
  const document = movement.documents[0];
  const lines = movement.documents.flatMap((each) => each.lines);
  const totals = lines.reduce(
    (running, line) => ({
      taxable: running.taxable + line.taxableValuePaise,
      cgst: running.cgst + line.cgstPaise,
      sgst: running.sgst + line.sgstPaise,
      igst: running.igst + line.igstPaise,
      cess: running.cess + line.cessPaise,
    }),
    { taxable: 0n, cgst: 0n, sgst: 0n, igst: 0n, cess: 0n },
  );
  const invoiceTotal = totals.taxable + totals.cgst + totals.sgst + totals.igst + totals.cess;
  const from = movement.dispatchFrom ?? movement.consignor;
  const to = movement.shipTo ?? movement.billTo;
  const transporter = record.transporter ?? movement.transporter;

  return `
<style>${EWAY_STYLES}</style>
<h1 class="eway-title">e-Way Bill</h1>
${banner === null ? '' : `<p class="eway-banner">${escapeHtml(banner.message)}</p>`}

<h2>E-way Bill Details</h2>
<table class="eway-facts">
${row('E-Way Bill No.', escapeHtml(acknowledgement.ewayBillNumber))}
${row('Generated Date', indianDateTime(acknowledgement.generatedAt))}
${row('Generated By', escapeHtml(movement.consignor.gstin))}
${row('Valid Upto', acknowledgement.validUntil === undefined ? 'Not started — Part B has not been entered' : indianDateTime(acknowledgement.validUntil))}
${row('Mode', escapeHtml(MODE_NAMES[movement.transportMode] ?? movement.transportMode))}
${row('Approx Distance', movement.approximateDistanceKm === undefined ? (record.distanceKm === undefined ? 'Not recorded' : `${record.distanceKm} km`) : `${movement.approximateDistanceKm} km`)}
${row('Type', escapeHtml(MOVEMENT_TYPES[movement.reason] ?? movement.reason))}
${row('Document Details', document === undefined ? 'Not recorded' : escapeHtml(`${DOCUMENT_NAMES[document.documentType]}-${document.documentNumber}-`) + indianDate(document.documentDate))}
${row('Transaction Type', escapeHtml(transactionType(movement)))}
</table>

<h2>Address Details</h2>
<div class="eway-addresses">
<div class="eway-address">
<h3>From</h3>
<p class="eway-party">${escapeHtml(movement.consignor.gstin)}<br><strong>${escapeHtml(movement.consignor.legalName)}</strong><br>${escapeHtml(stateName(movement.consignor.stateCode))}</p>
<h4>Dispatch From</h4>
<p class="eway-party">${addressLines(from)}</p>
</div>
<div class="eway-address">
<h3>To</h3>
<p class="eway-party">${escapeHtml(movement.billTo.gstin)}<br><strong>${escapeHtml(movement.billTo.legalName)}</strong><br>${escapeHtml(stateName(movement.billTo.stateCode))}</p>
<h4>Ship To</h4>
<p class="eway-party">${addressLines(to)}</p>
</div>
</div>

<h2>Goods Details</h2>
<table class="eway-goods">
<thead><tr><th>HSN Code</th><th>Product Name &amp; Desc.</th><th>Quantity</th><th>Taxable Amount Rs.</th><th>Tax Rate (C+S+I+Cess+Cess Non.Advol)</th></tr></thead>
<tbody>
${lines.map((line) => `<tr><td>${escapeHtml(line.hsnCode)}</td><td>${escapeHtml(line.description)}</td><td>${escapeHtml(`${line.quantity} ${line.unit}`)}</td><td class="amount">${amount(line.taxableValuePaise)}</td><td>${rateColumn(line)}</td></tr>`).join('\n')}
</tbody>
</table>
<table class="eway-totals">
${row('Total Taxable Amount', `<span class="amount">${amount(totals.taxable)}</span>`)}
${row('CGST Amount', `<span class="amount">${amount(totals.cgst)}</span>`)}
${row('SGST Amount', `<span class="amount">${amount(totals.sgst)}</span>`)}
${row('IGST Amount', `<span class="amount">${amount(totals.igst)}</span>`)}
${row('CESS Amount', `<span class="amount">${amount(totals.cess)}</span>`)}
${row('CESS Non.Advol Amount', '<span class="amount">0.00</span>')}
${row('Other Amount', '<span class="amount">0.00</span>')}
${row('Total Invoice Amount', `<span class="amount">${amount(invoiceTotal)}</span>`)}
</table>

<h2>Transportation Details</h2>
<table class="eway-facts">
${row('Transporter ID', transporter === undefined ? 'Not recorded' : escapeHtml(transporter.transporterId))}
${row('Transporter Name', transporter === undefined ? 'Not recorded' : escapeHtml(transporter.name))}
${row('Transporter Doc. No.', transporter?.documentNumber === undefined ? 'Not recorded' : escapeHtml(transporter.documentNumber))}
${row('Transporter Doc. Date', transporter?.documentDate === undefined ? 'Not recorded' : indianDate(transporter.documentDate))}
</table>

<h2>Vehicle Details</h2>
<table class="eway-vehicles">
<thead><tr><th>Mode</th><th>Vehicle / Trans Doc No. &amp; Date</th><th>From</th><th>Entered Date</th><th>Entered By</th><th>CEWB No.</th><th>Multi Veh. Info</th></tr></thead>
<tbody>
${record.vehicleLegs.length === 0
    ? '<tr><td colspan="7">No vehicle has been entered on this e-way bill.</td></tr>'
    : record.vehicleLegs.map((leg) => `<tr><td>${escapeHtml(MODE_NAMES[leg.mode] ?? leg.mode)}</td><td>${escapeHtml(leg.registrationNumber)}</td><td>${escapeHtml(leg.fromPlace)}</td><td>${indianDateTime(leg.recordedAt)}</td><td>${escapeHtml(movement.consignor.gstin)}</td><td>${escapeHtml(record.consolidatedTripNumber ?? '')}</td><td></td></tr>`).join('\n')}
</tbody>
</table>
`;
};
