/**
 * Issue #396 — a file has a row limit, and is read once.
 *
 * A file past `MAX_ROWS_PER_FILE` is refused at analyse with a sentence a shopkeeper can act on,
 * before anything is kept. A file within it is read at analyse and that reading is reused by
 * approve, preview and commit, rather than splitting the stored text again on every step.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DomainError, isoDate } from '@invoice/kernel';
import { sniffDelimiter } from '../src/csv.ts';
import { MAX_ROWS_PER_FILE, MigrationService } from '../src/service.ts';
import { buildHarness } from './harness.ts';
import { VYAPAR_CUSTOMERS } from './fixtures.ts';

const partyFile = (rows: number): string =>
  ['Party Name,Phone No,City', ...Array.from({ length: rows }, (_unused, index) => `Party ${index + 1},98450${String(index).padStart(5, '0')},Mysuru`)].join('\n');

describe('a file has a row limit', () => {
  it('refuses a file one row over the limit, says why in plain words, and keeps nothing', async () => {
    const harness = await buildHarness();
    await assert.rejects(
      harness.service.analyse(harness.actor, { fileName: 'all-parties.csv', content: partyFile(MAX_ROWS_PER_FILE + 1), asOn: isoDate('2026-04-01') }),
      (error: unknown) => {
        assert.ok(error instanceof DomainError);
        assert.equal(error.code, 'MIGRATION_TOO_MANY_ROWS');
        assert.equal(error.kind, 'INVALID');
        assert.match(error.message, /5,001 rows/);
        assert.match(error.message, /at most 5,000/);
        assert.match(error.message, /Split it into smaller files/);
        assert.equal(error.details.limit, String(MAX_ROWS_PER_FILE));
        assert.match(error.details['hi-IN'] ?? '', /छोटी फ़ाइलों/);
        return true;
      },
    );
    assert.deepEqual(await harness.service.batches(harness.actor), [], 'a refused file leaves no batch behind');
  });

  it('counts data rows, not the title or blank lines above the headings', async () => {
    const harness = await buildHarness();
    const content = `Sampoorna Traders\nParty list\n\n${partyFile(MAX_ROWS_PER_FILE)}\n\n`;
    const analysis = await harness.service.analyse(harness.actor, { fileName: 'parties.csv', content, asOn: isoDate('2026-04-01') });
    assert.equal(analysis.rowsInFile, MAX_ROWS_PER_FILE);
    assert.equal(analysis.batch.state, 'ANALYSED');
  });

  it('refuses the same over-long file every time it is retried', async () => {
    const harness = await buildHarness();
    const command = { fileName: 'all-parties.csv', content: partyFile(MAX_ROWS_PER_FILE + 50), asOn: isoDate('2026-04-01') };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(harness.service.analyse(harness.actor, command), { code: 'MIGRATION_TOO_MANY_ROWS' });
    }
    assert.deepEqual(await harness.service.batches(harness.actor), []);
  });
});

describe('a file is read once', () => {
  it('approve, preview twice and commit reuse what analyse read, never the stored text', async () => {
    const harness = await buildHarness();
    let storedTextReads = 0;
    const source = harness.migrationStore.source.bind(harness.migrationStore);
    harness.migrationStore.source = async (companyId, batchId) => {
      storedTextReads += 1;
      return source(companyId, batchId);
    };

    const analysis = await harness.service.analyse(harness.actor, { fileName: 'vyapar-parties.csv', content: VYAPAR_CUSTOMERS, asOn: isoDate('2026-04-01') });
    await harness.service.approveMapping(harness.actor, analysis.batch.id, {
      columns: analysis.batch.proposal.columns,
      fingerprint: analysis.batch.proposal.fingerprint,
    });
    const first = await harness.service.preview(harness.actor, analysis.batch.id);
    const second = await harness.service.preview(harness.actor, analysis.batch.id);
    const committed = await harness.service.commit(harness.actor, analysis.batch.id, { idempotencyKey: 'commit-once' });

    assert.equal(storedTextReads, 0, 'the file was split once, at analyse');
    assert.deepEqual(second.outcomes, first.outcomes);
    assert.equal(committed.batch.state, 'COMMITTED');
    assert.equal(committed.reconciliation.rowsInFile, analysis.rowsInFile);
  });

  it('a service that did not see the analyse reads the kept file once, then reuses it', async () => {
    const harness = await buildHarness();
    const analysis = await harness.service.analyse(harness.actor, { fileName: 'vyapar-parties.csv', content: VYAPAR_CUSTOMERS, asOn: isoDate('2026-04-01') });
    const expected = await harness.service.preview(harness.actor, analysis.batch.id);

    let storedTextReads = 0;
    const source = harness.migrationStore.source.bind(harness.migrationStore);
    harness.migrationStore.source = async (companyId, batchId) => {
      storedTextReads += 1;
      return source(companyId, batchId);
    };
    // The same store and books behind a fresh service, as after a restart.
    const restarted = new MigrationService({
      store: harness.store,
      ledger: harness.ledger,
      batches: harness.migrationStore,
      existing: { items: async () => [], parties: async () => [] },
      masters: undefined as never,
      permissions: { require: () => undefined } as never,
      audit: { record: async () => undefined } as never,
      clock: { now: () => new Date('2026-08-30T06:00:00.000Z') },
    });
    const first = await restarted.preview(harness.actor, analysis.batch.id);
    await restarted.preview(harness.actor, analysis.batch.id);
    assert.equal(storedTextReads, 1);
    assert.deepEqual(first.outcomes.map((outcome) => outcome.row), expected.outcomes.map((outcome) => outcome.row));
  });

  it('another company cannot reach a file this one has read', async () => {
    const owner = await buildHarness();
    const other = await buildHarness();
    const analysis = await owner.service.analyse(owner.actor, { fileName: 'vyapar-parties.csv', content: VYAPAR_CUSTOMERS, asOn: isoDate('2026-04-01') });
    await assert.rejects(owner.service.preview(other.actor, analysis.batch.id), { code: 'MIGRATION_BATCH_NOT_FOUND' });
  });
});

describe('working out the separator', () => {
  it('reads only the start of a long file and still finds the tab', () => {
    const lines = ['Item Code\tItem Name\tUnit', ...Array.from({ length: 20_000 }, (_unused, index) => `I${index}\tItem, number ${index}\tPcs`)];
    assert.equal(sniffDelimiter(lines.join('\n')), '\t');
  });
});
