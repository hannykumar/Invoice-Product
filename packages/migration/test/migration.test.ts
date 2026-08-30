/**
 * Issue #37 [E37] — the import end to end, against the real ledger, real master data and real stock.
 *
 * Every assertion below reads back out of the service that owns the record — `MasterDataService`
 * for a customer, `InventoryService` for a count, the ledger's own trial balance for a balance —
 * rather than out of the import's own return value. An import that only satisfies itself has proved
 * nothing (issue #76).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DomainError, formatINR, isoDate, toDecimalString, toQuantityString } from '@invoice/kernel';
import { trialBalance } from '@invoice/ledger';
import { buildHarness, bringIn, PERMISSIONS } from './harness.ts';
import { BUSY_ITEMS, GSTIN_HOTEL, SALES_REGISTER, TALLY_STOCK, TRIAL_BALANCE, TRIAL_BALANCE_OUT_BY_1000, VYAPAR_CUSTOMERS } from './fixtures.ts';

const customersFile = { fileName: 'vyapar-parties.csv', content: VYAPAR_CUSTOMERS, asOn: '2026-04-01' };
/** The same file, typed for the calls that go straight to the service rather than through `bringIn`. */
const customersCommand = { fileName: customersFile.fileName, content: customersFile.content, asOn: isoDate(customersFile.asOn) };
const itemsFile = { fileName: 'busy-items.txt', content: BUSY_ITEMS, asOn: '2026-04-01' };
const stockFile = { fileName: 'tally-stock.csv', content: TALLY_STOCK, asOn: '2026-04-01' };
const balancesFile = { fileName: 'trial-balance.csv', content: TRIAL_BALANCE, asOn: '2026-04-01' };

describe('bringing in customers', () => {
  it('creates them in the real master data, with the address and phone from the file', async () => {
    const harness = await buildHarness();
    const { analysis, result } = await bringIn(harness, customersFile);

    assert.equal(analysis.batch.entity, 'customers');
    assert.equal(analysis.batch.sourceSystem, 'VYAPAR');
    assert.equal(result.created.parties, 3);

    const parties = harness.masters.parties(harness.context);
    const rajmahal = parties.find((party) => party.legalName === 'Hotel Rajmahal');
    assert.ok(rajmahal, 'the customer must exist in master data, not just in the import result');
    assert.deepEqual(rajmahal.phones, ['9845012345']);
    const address = harness.masters.addressesOfParty(harness.companyId, rajmahal.id)[0];
    assert.equal(address?.gstin, GSTIN_HOTEL);
    assert.equal(address?.stateCode, '29');
  });

  it('leaves out the row with no name and hands back a file to fix', async () => {
    const harness = await buildHarness();
    const analysis = await harness.service.analyse(harness.actor, customersCommand);
    await harness.service.approveMapping(harness.actor, analysis.batch.id, {
      columns: analysis.batch.proposal.columns,
      fingerprint: analysis.batch.proposal.fingerprint,
    });
    const preview = await harness.service.preview(harness.actor, analysis.batch.id);

    assert.equal(preview.accepted, 3);
    assert.equal(preview.rejected, 1);
    assert.equal(preview.skipped, 1, 'the repeated Hotel Rajmahal row');
    assert.equal(preview.duplicates.withinFile, 1);
    assert.ok(preview.errorFile);
    assert.match(preview.errorFile, /Row in your file/);
    assert.match(preview.errorFile, /no name/);
    // The refused row comes back with its own cells intact, so it can be corrected in place.
    assert.match(preview.errorFile, /9000000000/);
  });

  it('skips a customer the business already has instead of overwriting them', async () => {
    const harness = await buildHarness();
    await bringIn(harness, customersFile);

    const again = await bringIn(harness, {
      fileName: 'more-parties.csv',
      content: ['Party Name,Phone No,City', 'Hotel Rajmahal,9845012345,Mysuru', 'Green Leaf Caterers,9845099999,Mysuru'].join('\n'),
      asOn: '2026-04-01',
    });
    assert.equal(again.result.created.parties, 1);
    assert.equal(again.result.reconciliation.skippedAsDuplicate, 1);

    const rajmahal = harness.masters.parties(harness.context).filter((party) => party.legalName === 'Hotel Rajmahal');
    assert.equal(rajmahal.length, 1, 'the customer must not be duplicated');
    assert.deepEqual(rajmahal[0]?.phones, ['9845012345']);
  });

  it('refuses the same file twice, and names the import that already brought it in', async () => {
    const harness = await buildHarness();
    const first = await bringIn(harness, customersFile);

    const second = await harness.service.analyse(harness.actor, customersCommand);
    assert.equal(second.batch.state, 'REJECTED_DUPLICATE');
    assert.equal(second.batch.duplicateOfBatchId, first.analysis.batch.id);

    await assert.rejects(
      () => harness.service.commit(harness.actor, second.batch.id, { idempotencyKey: 'again' }),
      (error: DomainError) => {
        assert.equal(error.code, 'MIGRATION_ALREADY_IMPORTED');
        assert.match(error.message, /double your figures/);
        return true;
      },
    );
    assert.equal(harness.masters.parties(harness.context).length, 3, 'nothing was added a second time');
  });
});

describe('approving the mapping', () => {
  it('will not commit anything until a person has approved which column is which', async () => {
    const harness = await buildHarness();
    const analysis = await harness.service.analyse(harness.actor, customersCommand);
    await assert.rejects(
      () => harness.service.commit(harness.actor, analysis.batch.id, { idempotencyKey: 'k' }),
      (error: DomainError) => error.code === 'MIGRATION_MAPPING_NOT_APPROVED',
    );
    assert.equal(harness.masters.parties(harness.context).length, 0);
  });

  it('refuses an approval whose fingerprint does not match the columns being approved', async () => {
    const harness = await buildHarness();
    const analysis = await harness.service.analyse(harness.actor, customersCommand);
    const tampered = analysis.batch.proposal.columns.map((column, index) => (index === 0 ? { ...column, field: 'city' } : column));
    await assert.rejects(
      () => harness.service.approveMapping(harness.actor, analysis.batch.id, { columns: tampered, fingerprint: analysis.batch.proposal.fingerprint }),
      (error: DomainError) => error.code === 'MIGRATION_MAPPING_CHANGED',
    );
  });

  it('asks for the column it cannot do without', async () => {
    const harness = await buildHarness();
    const analysis = await harness.service.analyse(harness.actor, {
      fileName: 'no-name.csv',
      content: 'Phone No,City\n9845012345,Mysuru',
      entity: 'customers',
    });
    await assert.rejects(
      () => harness.service.approveMapping(harness.actor, analysis.batch.id, {
        columns: analysis.batch.proposal.columns,
        fingerprint: analysis.batch.proposal.fingerprint,
      }),
      (error: DomainError) => {
        assert.equal(error.code, 'MIGRATION_MAPPING_INCOMPLETE');
        assert.match(error.message, /which column holds: name/);
        return true;
      },
    );
  });
});

describe('bringing in items and stock', () => {
  it('creates the items, and refuses only the one with no HSN code', async () => {
    const harness = await buildHarness();
    const { result } = await bringIn(harness, itemsFile);
    assert.equal(result.created.items, 3);
    assert.equal(result.reconciliation.rejected, 1);

    const items = harness.masters.items(harness.context);
    const rice = items.find((item) => item.name === 'Sona Masoori Rice');
    assert.ok(rice);
    assert.equal(rice.hsnSac, '10063020');
    assert.equal(rice.baseUnit, 'KGS', '"Kg" from the file means the KGS the books already use');
  });

  it('moves the opening stock through the real stock ledger and reconciles to it', async () => {
    const harness = await buildHarness();
    await bringIn(harness, itemsFile);
    const { result } = await bringIn(harness, { ...stockFile, defaultWarehouseRef: 'MAIN' });

    assert.equal(result.created.stockLines, 2, 'the negative row is refused, the other two go in');
    const rice = harness.masters.items(harness.context).find((item) => item.name === 'Sona Masoori Rice');
    const balance = await harness.inventory.balance(harness.actor, { itemId: rice?.id ?? '', warehouseId: harness.warehouseId });
    assert.equal(toQuantityString(balance.physical), '120');
    assert.equal(balance.physical.unit, 'KGS');

    const totals = result.reconciliation.stockTotals;
    assert.ok(totals);
    assert.equal(totals.matchesFile, true);
    assert.equal(toDecimalString(totals.fileValue), '24690.00');
    assert.equal(toDecimalString(totals.recordedValue), '24690.00', 'read back out of stock, not copied from the file');
  });

  it('stops before moving anything when the file names an item the books do not have', async () => {
    const harness = await buildHarness();
    await assert.rejects(
      () => bringIn(harness, { ...stockFile, defaultWarehouseRef: 'MAIN' }),
      (error: DomainError) => {
        assert.equal(error.code, 'MIGRATION_ITEM_UNKNOWN');
        assert.match(error.message, /Sona Masoori Rice/);
        assert.match(error.message, /Bring your item list in first/);
        return true;
      },
    );
    const movements = await harness.inventory.movementsFor(harness.actor, {});
    assert.equal(movements.length, 0, 'nothing may move when one line cannot be resolved');
  });
});

describe('bringing in opening balances', () => {
  it('posts one balanced opening entry and reconciles it against the ledger', async () => {
    const harness = await buildHarness();
    const { result } = await bringIn(harness, balancesFile);

    assert.ok(result.openingVoucherId);
    const totals = result.reconciliation.openingTotals;
    assert.ok(totals);
    assert.equal(totals.balanced, true);
    assert.equal(totals.matchesFile, true);
    assert.equal(toDecimalString(totals.postedDebit), '23840.50');

    const tb = await trialBalance(harness.store.read(), harness.companyId);
    assert.equal(tb.balanced, true);
    assert.equal(toDecimalString(tb.totalDebit), '23840.50');
    const receivable = tb.rows.find((row) => row.account.name === 'Hotel Rajmahal');
    assert.ok(receivable, 'the customer got their own account in the books');
    assert.equal(formatINR(receivable.balance), '₹4,500.00');
  });

  it('tells an account apart from a person, which balancing alone would never catch', async () => {
    const harness = await buildHarness();
    await bringIn(harness, balancesFile);
    const tb = await trialBalance(harness.store.read(), harness.companyId);

    // "Cash in hand" and "Capital" are accounts the books already have, and the trial balance names
    // them exactly as the shopkeeper sees them. Opening a supplier called "Capital" would balance
    // perfectly and be nonsense.
    const cash = tb.rows.find((row) => row.account.code === '1110');
    const capital = tb.rows.find((row) => row.account.code === '3100');
    assert.equal(formatINR(cash?.balance ?? { currency: 'INR', minor: 0n }), '₹7,000.00');
    assert.equal(formatINR(capital?.balance ?? { currency: 'INR', minor: 0n }), '₹14,040.50');

    // The two named under "Sundry Debtors" did become customers, with accounts of their own.
    const customer = tb.rows.find((row) => row.account.name === 'Hotel Rajmahal');
    assert.ok(customer?.account.partyId, 'a customer gets a party account, not a chart account');
    assert.equal(customer?.account.type, 'ASSET');
    const supplier = tb.rows.find((row) => row.account.name === 'Shree Ram Steels');
    assert.equal(supplier?.account.type, 'LIABILITY');
  });

  it('refuses a trial balance whose sides do not agree, and says by how much', async () => {
    const harness = await buildHarness();
    await assert.rejects(
      () => bringIn(harness, { fileName: 'tb-out.csv', content: TRIAL_BALANCE_OUT_BY_1000, asOn: '2026-04-01' }),
      (error: DomainError) => {
        assert.equal(error.code, 'MIGRATION_OPENING_UNBALANCED');
        assert.match(error.message, /₹1,000.00/);
        return true;
      },
    );
    const tb = await trialBalance(harness.store.read(), harness.companyId);
    assert.equal(tb.totalDebit.minor, 0n, 'nothing was posted');
  });

  it('records an accepted difference visibly, with the reason a person gave', async () => {
    const harness = await buildHarness();
    const { result } = await bringIn(
      harness,
      { fileName: 'tb-out.csv', content: TRIAL_BALANCE_OUT_BY_1000, asOn: '2026-04-01' },
      { acceptDifference: { reason: 'The old software never showed where this came from' } },
    );

    const tb = await trialBalance(harness.store.read(), harness.companyId);
    assert.equal(tb.balanced, true);
    const difference = tb.rows.find((row) => row.account.code === '3900');
    assert.ok(difference, 'the difference sits in its own account where anyone can see it');
    assert.equal(formatINR(difference.balance), '₹1,000.00');
    assert.match(result.reconciliation.sentence['en-IN'], /out by ₹1,000.00/);
  });

  it('posts once however many times the same commit is sent', async () => {
    const harness = await buildHarness();
    const analysis = await harness.service.analyse(harness.actor, { fileName: balancesFile.fileName, content: balancesFile.content, asOn: isoDate(balancesFile.asOn) });
    await harness.service.approveMapping(harness.actor, analysis.batch.id, {
      columns: analysis.batch.proposal.columns,
      fingerprint: analysis.batch.proposal.fingerprint,
    });
    const first = await harness.service.commit(harness.actor, analysis.batch.id, { idempotencyKey: 'commit-once' });
    const second = await harness.service.commit(harness.actor, analysis.batch.id, { idempotencyKey: 'commit-once' });

    assert.equal(second.openingVoucherId, first.openingVoucherId);
    const tb = await trialBalance(harness.store.read(), harness.companyId);
    assert.equal(toDecimalString(tb.totalDebit), '23840.50', 'a second commit must not double the books');
  });
});

describe('taking an import back out', () => {
  it('reverses the opening entry and leaves the books where they started', async () => {
    const harness = await buildHarness();
    const { analysis } = await bringIn(harness, balancesFile);
    const rolledBack = await harness.service.rollback(harness.actor, analysis.batch.id, {
      reason: 'The accountant sent the wrong year',
    });

    assert.equal(rolledBack.state, 'ROLLED_BACK');
    const tb = await trialBalance(harness.store.read(), harness.companyId);
    assert.equal(tb.balanced, true);
    // Every account is back to nothing. The movements are still there — a reversal is an entry, not
    // an erasure — so what must be zero is each balance, not the traffic through the books.
    for (const row of tb.rows) assert.equal(row.balance.minor, 0n, `${row.account.name} should be back to nothing`);
    const original = await harness.ledger.getVoucher(harness.actor, rolledBack.written.voucherId as never);
    assert.equal(original?.state, 'REVERSED');
    assert.equal(original?.reason, 'The accountant sent the wrong year');
  });

  it('switches off the customers an import created rather than deleting them', async () => {
    const harness = await buildHarness();
    const { analysis } = await bringIn(harness, customersFile);
    await harness.service.rollback(harness.actor, analysis.batch.id, { reason: 'Wrong file' });

    const active = harness.masters.parties(harness.context).filter((party) => party.active);
    assert.equal(active.length, 0);
    // The record and its history survive, so nothing that referred to it is left dangling.
    assert.equal(harness.masters.parties(harness.context).length, 3);
  });

  it('refuses to undo stock that has already been sold, before it moves anything', async () => {
    const harness = await buildHarness();
    await bringIn(harness, itemsFile);
    const { analysis } = await bringIn(harness, { ...stockFile, defaultWarehouseRef: 'MAIN' });

    const rice = harness.masters.items(harness.context).find((item) => item.name === 'Sona Masoori Rice');
    await harness.inventory.recordMovement(harness.actor, {
      idempotencyKey: 'sold-some-rice',
      itemId: rice?.id ?? '',
      warehouseId: harness.warehouseId,
      kind: 'SALE_OUT',
      quantity: { scaled: 100_000000n, unit: 'KGS' },
      documentDate: isoDate('2026-04-05'),
      source: { kind: 'sale', id: 'INV-1', number: 'INV-1' },
    });

    await assert.rejects(
      () => harness.service.rollback(harness.actor, analysis.batch.id, { reason: 'changed my mind' }),
      (error: DomainError) => {
        assert.equal(error.code, 'MIGRATION_STOCK_ALREADY_USED');
        assert.match(error.message, /already been sold/);
        return true;
      },
    );

    const balance = await harness.inventory.balance(harness.actor, { itemId: rice?.id ?? '', warehouseId: harness.warehouseId });
    assert.equal(toQuantityString(balance.physical), '20', 'the refused rollback left every count alone');
  });
});

describe('who may do this, and to whose books', () => {
  it("will not let one business see another business's import", async () => {
    const mine = await buildHarness();
    const theirs = await buildHarness();
    const { analysis } = await bringIn(mine, customersFile);

    await assert.rejects(
      () => theirs.service.preview(theirs.actor, analysis.batch.id),
      (error: DomainError) => error.code === 'MIGRATION_BATCH_NOT_FOUND',
    );
  });

  it('needs the permission to commit, not only the permission to look', async () => {
    const harness = await buildHarness({ permissions: PERMISSIONS.filter((permission) => permission !== 'migration.commit') });
    const analysis = await harness.service.analyse(harness.actor, customersCommand);
    await harness.service.approveMapping(harness.actor, analysis.batch.id, {
      columns: analysis.batch.proposal.columns,
      fingerprint: analysis.batch.proposal.fingerprint,
    });
    await assert.rejects(
      () => harness.service.commit(harness.actor, analysis.batch.id, { idempotencyKey: 'k' }),
      (error: DomainError) => error.kind === 'FORBIDDEN',
    );
  });
});

describe('files this route will not take', () => {
  it('refuses a sales register, and says where past bills belong', async () => {
    const harness = await buildHarness();
    await assert.rejects(
      () => harness.service.analyse(harness.actor, { fileName: 'sales-register.csv', content: SALES_REGISTER }),
      (error: DomainError) => {
        assert.equal(error.code, 'MIGRATION_TRANSACTIONS_NOT_SUPPORTED');
        assert.match(error.message, /past bills/);
        return true;
      },
    );
  });

  it('refuses a file with no heading row rather than guessing at one', async () => {
    const harness = await buildHarness();
    await assert.rejects(
      () => harness.service.analyse(harness.actor, { fileName: 'empty.csv', content: 'just one line of text\n' }),
      (error: DomainError) => error.code === 'MIGRATION_NO_HEADINGS',
    );
  });
});

describe('a file the size a real business sends', () => {
  it('brings in five hundred customers and counts every one of them', async () => {
    const harness = await buildHarness();
    // Real names, because names are what the duplicate rules work on: five hundred rows called
    // "Customer 1" to "Customer 500" would be five hundred near-duplicates and would prove nothing.
    const owners = ['Ramesh', 'Suresh', 'Lakshmi', 'Anand', 'Vijaya', 'Girish', 'Meena', 'Prakash', 'Shanta', 'Naveen'];
    const trades = ['Hardware', 'Textiles', 'Provisions', 'Electricals', 'Stationery', 'Sweets', 'Furniture', 'Pharma', 'Cutlery', 'Bakery'];
    const places = ['Mysuru', 'Hassan', 'Mandya', 'Tumakuru', 'Chikkamagaluru'];

    const rows = ['Party Name,Phone No,City'];
    for (const owner of owners) {
      for (const trade of trades) {
        for (const place of places) {
          rows.push(`${owner} ${trade}, ${place} branch,9845${String(rows.length).padStart(6, '0')},${place}`.replace(', ', ' '));
        }
      }
    }
    const { result } = await bringIn(harness, { fileName: 'big.csv', content: rows.join('\n'), asOn: '2026-04-01' });

    assert.equal(result.reconciliation.rowsInFile, 500);
    assert.equal(result.reconciliation.rejected, 0);
    assert.equal(result.created.parties, 500);
    assert.equal(harness.masters.parties(harness.context).length, 500);
  });
});
