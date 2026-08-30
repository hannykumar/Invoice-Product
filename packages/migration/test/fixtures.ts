/**
 * Issue #37 [E37] — the files a real migration actually arrives as.
 *
 * These are shaped like the exports the three products people leave produce, down to the title rows
 * Tally writes above the headings and the ₹ signs Vyapar leaves in the amounts. Every GST number is
 * built by `syntheticGstin` — structurally valid, belonging to nobody.
 */
import { syntheticGstin } from '../../masters/src/fixtures.ts';

export const GSTIN_HOTEL = syntheticGstin('29', 'AABCH4321K');
export const GSTIN_STORES = syntheticGstin('29', 'AAFCN8765J');
export const GSTIN_BAKERY = syntheticGstin('27', 'AAGCB1357L');

/** Vyapar's party export: ₹ signs, "Phone No", a Dr/Cr column, and one number mistyped. */
export const VYAPAR_CUSTOMERS = [
  'Party Name,Phone No,GSTIN,Address,City,State,Pincode,Opening Balance,Dr/Cr',
  `Hotel Rajmahal,98450 12345,${GSTIN_HOTEL},"12, Sayyaji Rao Road, Near Clock Tower",Mysuru,Karnataka,570001,"₹4,500.00",Dr`,
  `Nandini Provision Stores,9880098800,${GSTIN_STORES},Ashoka Road,Mysuru,Karnataka,570001,"₹12,340.50",Dr`,
  'Anand Tea Stall,9448811223,29AABCT9999Z9,Devaraja Market,Mysuru,Karnataka,570001,"₹800",Dr',
  'Hotel Rajmahal,98450 12345,,,,,,"₹4,500.00",Dr',
  ',9000000000,,,,,,"₹100",Dr',
].join('\r\n');

/** Tally's stock summary: a report title above the headings, quantities with the unit written in. */
export const TALLY_STOCK = [
  'Sampoorna Traders',
  'Stock Summary : 1-Apr-2026',
  '',
  'Particulars,Godown,Closing Qty,Rate,Closing Value',
  'Sona Masoori Rice,Main godown,120 KGS,52.00,6240.00',
  'OPC Cement 53 Grade 50kg Bag,Main godown,45 BAG,410.00,18450.00',
  'TMT Steel Bar 12mm,Main godown,-8 KGS,72.00,-576.00',
].join('\n');

/** A BUSY item master, tab separated, with one item missing its HSN code. */
export const BUSY_ITEMS = [
  'Item Code\tItem Name\tUnit\tHSN Code\tSale Price\tGST %',
  'RICE\tSona Masoori Rice\tKg\t10063020\t54.00\t0',
  'CEM53\tOPC Cement 53 Grade 50kg Bag\tBag\t25232930\t425.00\t28',
  'TMT12\tTMT Steel Bar 12mm\tKgs\t72142090\t78.50\t18',
  'MISC\tAssorted hardware\tPcs\t\t100.00\t18',
].join('\n');

/** A trial balance that balances: two customers, one supplier, cash and capital. */
export const TRIAL_BALANCE = [
  'Ledger Name,Group,Debit,Credit',
  'Hotel Rajmahal,Sundry Debtors,4500.00,',
  'Nandini Provision Stores,Sundry Debtors,12340.50,',
  'Shree Ram Steels,Sundry Creditors,,9800.00',
  'Cash in hand,Cash-in-Hand,7000.00,',
  'Capital,Capital Account,,14040.50',
].join('\n');

/** The same trial balance with ₹1,000 missing from the credit side. */
export const TRIAL_BALANCE_OUT_BY_1000 = TRIAL_BALANCE.replace('14040.50', '13040.50');

/** A sales register — a list of past bills, which this route deliberately refuses. */
export const SALES_REGISTER = [
  'Invoice No,Invoice Date,Party Name,Taxable Value,GST,Total',
  'INV-001,01-04-2026,Hotel Rajmahal,4000.00,720.00,4720.00',
  'INV-002,02-04-2026,Nandini Provision Stores,10000.00,1800.00,11800.00',
].join('\n');
