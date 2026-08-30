/** Issue #37 [E37] — reading files: the shapes they arrive in and the values inside them. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isoDate, toDecimalString, toQuantityString } from '@invoice/kernel';
import { asRecords, readDelimited, sniffDelimiter, toCsv } from '../src/csv.ts';
import { detectEntity, detectSourceSystem, fingerprintOf, looksLikeTransactions, needsConfirmation, proposeMapping } from '../src/columns.ts';
import { readDate, readMoney, readPercent, readQuantity, readSide } from '../src/coerce.ts';
import { readRows } from '../src/rows.ts';
import { BUSY_ITEMS, SALES_REGISTER, TALLY_STOCK, TRIAL_BALANCE, VYAPAR_CUSTOMERS } from './fixtures.ts';

describe('reading a delimited file', () => {
  it('keeps a quoted address that contains commas in one cell', () => {
    const sheet = readDelimited(VYAPAR_CUSTOMERS);
    const rows = asRecords(sheet);
    assert.equal(rows[0]?.Address, '12, Sayyaji Rao Road, Near Clock Tower');
  });

  it('reads a tab separated file without being told', () => {
    assert.equal(sniffDelimiter(BUSY_ITEMS), '\t');
    const sheet = readDelimited(BUSY_ITEMS);
    assert.deepEqual(sheet.headers.slice(0, 3), ['Item Code', 'Item Name', 'Unit']);
    assert.equal(sheet.rows.length, 4);
  });

  it('steps over the report title Tally writes above the headings', () => {
    const sheet = readDelimited(TALLY_STOCK);
    assert.deepEqual(sheet.headers, ['Particulars', 'Godown', 'Closing Qty', 'Rate', 'Closing Value']);
    assert.equal(sheet.rows.length, 3);
    assert.deepEqual(sheet.preamble, ['Sampoorna Traders', 'Stock Summary : 1-Apr-2026']);
  });

  it('handles a byte order mark, CRLF and a short last row', () => {
    const sheet = readDelimited('﻿Name,Phone\r\nRamesh,9845012345\r\nSuresh\r\n');
    assert.deepEqual(sheet.headers, ['Name', 'Phone']);
    assert.deepEqual(sheet.rows[1], ['Suresh', '']);
    // Row numbers are the line numbers the person sees in Excel, not an index of our own.
    assert.deepEqual(sheet.rowNumbers, [2, 3]);
  });

  it('keeps a newline inside a quoted cell', () => {
    const sheet = readDelimited('Name,Address\n"Ramesh","Shop 4\nMarket Road"');
    assert.equal(asRecords(sheet)[0]?.Address, 'Shop 4\nMarket Road');
  });

  it('writes a CSV back out with the quoting it needs', () => {
    assert.equal(toCsv(['a', 'b'], [['1,2', 'he said "hi"']]), 'a,b\r\n"1,2","he said ""hi"""');
  });
});

describe('working out what a file is', () => {
  it('recognises a party list, a stock summary, an item list and a trial balance', () => {
    assert.equal(detectEntity(readDelimited(VYAPAR_CUSTOMERS).headers).entity, 'customers');
    assert.equal(detectEntity(readDelimited(TALLY_STOCK).headers).entity, 'opening_stock');
    assert.equal(detectEntity(readDelimited(BUSY_ITEMS).headers).entity, 'items');
    assert.equal(detectEntity(readDelimited(TRIAL_BALANCE).headers).entity, 'opening_balances');
  });

  it('names the product the file came from, which only ever changes the guesses', () => {
    assert.equal(detectSourceSystem(readDelimited(TALLY_STOCK).headers), 'TALLY');
    assert.equal(detectSourceSystem(readDelimited(VYAPAR_CUSTOMERS).headers), 'VYAPAR');
  });

  it('refuses to treat a list of past bills as a list of anything else', () => {
    assert.equal(looksLikeTransactions(readDelimited(SALES_REGISTER).headers), true);
    assert.equal(looksLikeTransactions(readDelimited(VYAPAR_CUSTOMERS).headers), false);
  });
});

describe('proposing a mapping', () => {
  it('maps a Vyapar party export column by column', () => {
    const proposal = proposeMapping(readDelimited(VYAPAR_CUSTOMERS).headers, 'customers');
    const byHeader = new Map(proposal.columns.map((column) => [column.header, column.field]));
    assert.equal(byHeader.get('Party Name'), 'name');
    assert.equal(byHeader.get('Phone No'), 'phone');
    assert.equal(byHeader.get('GSTIN'), 'gstin');
    assert.equal(byHeader.get('Opening Balance'), 'opening_balance');
    assert.equal(byHeader.get('Dr/Cr'), 'opening_side');
    assert.deepEqual(proposal.missingRequired, []);
  });

  it('says which fields are missing rather than inventing them', () => {
    const proposal = proposeMapping(['Phone', 'City'], 'customers');
    assert.deepEqual(proposal.missingRequired, ['name']);
  });

  it('marks a column it is unsure about as one to ask about', () => {
    const proposal = proposeMapping(['PAN Of Party', 'Party Name'], 'customers');
    const unsure = needsConfirmation(proposal).map((column) => column.header);
    assert.deepEqual(unsure, ['PAN Of Party']);
    // A heading that says exactly what it is needs no question.
    assert.deepEqual(needsConfirmation(proposeMapping(['GSTIN', 'Party Name'], 'customers')), []);
  });

  it('gives one field to one column, and leaves the loser to be mapped by hand', () => {
    const proposal = proposeMapping(['Name', 'Customer Name'], 'customers');
    // "Customer Name" is a weaker claim on `name` than "Name", and it is not quietly given to
    // some other field either — it comes back unmapped for the person to place.
    const mapped = proposal.columns.filter((column) => column.field === 'name');
    assert.equal(mapped.length, 1);
    assert.equal(proposal.unmapped.length, 1);
  });

  it('changes its fingerprint when a column is mapped differently', () => {
    const proposal = proposeMapping(readDelimited(VYAPAR_CUSTOMERS).headers, 'customers');
    const changed = proposal.columns.map((column, index) => (index === 1 ? { ...column, field: 'email' } : column));
    assert.notEqual(fingerprintOf(changed), proposal.fingerprint);
    assert.equal(fingerprintOf(proposal.columns), proposal.fingerprint);
  });
});

describe('reading a value out of a cell', () => {
  it('reads the shapes old software writes money in', () => {
    const cases: [string, string][] = [
      ['4500', '4500.00'],
      ['₹1,23,456.50', '123456.50'],
      ['Rs. 5,000/-', '5000.00'],
      ['(500)', '-500.00'],
      ['-500', '-500.00'],
      ['1234.5', '1234.50'],
    ];
    for (const [cell, expected] of cases) {
      const read = readMoney(cell);
      assert.equal(read.ok, true, `${cell} should be readable`);
      if (read.ok) assert.equal(toDecimalString(read.value.amount), expected);
    }
  });

  it('keeps the Dr or Cr written beside a figure instead of guessing from the sign', () => {
    const read = readMoney('9,800.00 Cr');
    assert.equal(read.ok && read.value.side, 'CREDIT');
  });

  it('refuses a figure with more paise than the rupee has, rather than rounding it', () => {
    const read = readMoney('100.005');
    assert.equal(read.ok, false);
    if (!read.ok) assert.equal(read.code, 'AMOUNT_TOO_MANY_PAISE');
  });

  it('refuses text where a number should be, and says what the cell said', () => {
    const read = readMoney('as per bill');
    assert.equal(read.ok, false);
    if (!read.ok) assert.match(read.message['en-IN'], /"as per bill"/);
  });

  it('reads a quantity with its unit written in', () => {
    const read = readQuantity('120 KGS', 'PCS');
    assert.equal(read.ok, true);
    if (read.ok) {
      assert.equal(toQuantityString(read.value), '120');
      assert.equal(read.value.unit, 'KGS');
    }
  });

  it('reads dates the way Indian software writes them, and says so', () => {
    assert.equal((readDate('01-04-2026') as { value: string }).value, isoDate('2026-04-01'));
    assert.equal((readDate('1-Apr-26') as { value: string }).value, isoDate('2026-04-01'));
    assert.equal((readDate('2026-04-01') as { value: string }).value, isoDate('2026-04-01'));
    // 25/12 can only be a day first, so nothing needs saying.
    const unambiguous = readDate('25/12/2026');
    assert.equal(unambiguous.ok && unambiguous.note, undefined);
    // 03/04 could be either, so the reading is stated out loud.
    const ambiguous = readDate('03/04/2026');
    assert.equal(ambiguous.ok, true);
    if (ambiguous.ok) assert.match(ambiguous.note?.['en-IN'] ?? '', /read as 3 of month 4/);
  });

  it('refuses a date it cannot read and a day that does not exist', () => {
    assert.equal(readDate('31-02-2026').ok, false);
    assert.equal(readDate('sometime in April').ok, false);
  });

  it('reads a GST rate as basis points, and refuses one over 100%', () => {
    assert.equal((readPercent('18%') as { value: number }).value, 1800);
    assert.equal((readPercent('0') as { value: number }).value, 0);
    assert.equal(readPercent('180').ok, false);
  });

  it('reads which side of the books an amount is on', () => {
    assert.equal((readSide('Cr') as { value: string }).value, 'CREDIT');
    assert.equal((readSide('debit') as { value: string }).value, 'DEBIT');
    assert.equal(readSide('yes').ok, false);
  });
});

describe('turning rows into records', () => {
  const options = { asOn: isoDate('2026-04-01') };

  it('reads a party list, warning about a mistyped GST number rather than dropping the customer', () => {
    const sheet = readDelimited(VYAPAR_CUSTOMERS);
    const mapping = proposeMapping(sheet.headers, 'customers').columns;
    const outcomes = readRows('customers', sheet, mapping, { ...options, partyKind: 'CUSTOMER' });

    const rajmahal = outcomes[0];
    assert.equal(rajmahal?.decision, 'ACCEPT');
    assert.equal((rajmahal?.parsed as { name: string }).name, 'Hotel Rajmahal');
    assert.equal((rajmahal?.parsed as unknown as { phones: string[] }).phones[0], '9845012345');
    assert.equal((rajmahal?.parsed as { stateCode: string }).stateCode, '29');

    const teaStall = outcomes[2];
    assert.equal(teaStall?.decision, 'ACCEPT', 'a bad GST number must not lose the customer');
    assert.equal((teaStall?.parsed as { gstin: string | null }).gstin, null);
    assert.match(teaStall?.problems[0]?.message['en-IN'] ?? '', /digit was probably mistyped/);

    const nameless = outcomes[4];
    assert.equal(nameless?.decision, 'REJECT');
    assert.equal(nameless?.problems[0]?.code, 'NAME_MISSING');
  });

  it('refuses an item with no HSN code and says exactly what to do', () => {
    const sheet = readDelimited(BUSY_ITEMS);
    const mapping = proposeMapping(sheet.headers, 'items').columns;
    const outcomes = readRows('items', sheet, mapping, options);

    assert.equal(outcomes[0]?.decision, 'ACCEPT');
    assert.equal((outcomes[0]?.parsed as { hsnSac: string }).hsnSac, '10063020');
    assert.equal((outcomes[0]?.parsed as { gstRateBasisPoints: number }).gstRateBasisPoints, 0);

    const missingHsn = outcomes[3];
    assert.equal(missingHsn?.decision, 'REJECT');
    assert.equal(missingHsn?.problems[0]?.code, 'HSN_MISSING');
    assert.match(missingHsn?.problems[0]?.message['en-IN'] ?? '', /add it to the file/);
  });

  it('multiplies a rate by a quantity, and refuses stock that is below zero', () => {
    const sheet = readDelimited(TALLY_STOCK);
    const mapping = proposeMapping(sheet.headers, 'opening_stock').columns;
    const outcomes = readRows('opening_stock', sheet, mapping, options);

    assert.equal(outcomes[0]?.decision, 'ACCEPT');
    assert.equal(toQuantityString((outcomes[0]?.parsed as { quantity: { scaled: bigint; unit: string } }).quantity), '120');
    assert.equal(toDecimalString((outcomes[0]?.parsed as { value: { minor: bigint; currency: 'INR' } }).value), '6240.00');

    const negative = outcomes[2];
    assert.equal(negative?.decision, 'REJECT');
    assert.equal(negative?.problems[0]?.code, 'STOCK_NEGATIVE');
  });

  it('reads a trial balance, and works out who is a customer and who is a supplier', () => {
    const sheet = readDelimited(TRIAL_BALANCE);
    const mapping = proposeMapping(sheet.headers, 'opening_balances').columns;
    const outcomes = readRows('opening_balances', sheet, mapping, options);

    assert.equal(outcomes.length, 5);
    assert.equal((outcomes[0]?.parsed as { partyKind: string }).partyKind, 'CUSTOMER');
    assert.equal((outcomes[2]?.parsed as { partyKind: string }).partyKind, 'SUPPLIER');
    assert.equal(toDecimalString((outcomes[2]?.parsed as { credit: { minor: bigint; currency: 'INR' } }).credit), '9800.00');
  });

  it('refuses a balance row with an amount on both sides', () => {
    const sheet = readDelimited('Ledger Name,Debit,Credit\nSomething,100.00,50.00');
    const mapping = proposeMapping(sheet.headers, 'opening_balances').columns;
    const outcomes = readRows('opening_balances', sheet, mapping, options);
    assert.equal(outcomes[0]?.decision, 'REJECT');
    assert.equal(outcomes[0]?.problems[0]?.code, 'BOTH_SIDES');
  });

  it('refuses an amount with no side, because an opening balance is never guessed', () => {
    const sheet = readDelimited('Ledger Name,Amount\nSomething,100.00');
    const mapping = proposeMapping(sheet.headers, 'opening_balances').columns;
    const outcomes = readRows('opening_balances', sheet, mapping, options);
    assert.equal(outcomes[0]?.decision, 'REJECT');
    assert.equal(outcomes[0]?.problems[0]?.code, 'SIDE_MISSING');
  });
});
