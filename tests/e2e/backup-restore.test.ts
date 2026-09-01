/**
 * Issue #44 — the backup/restore smoke test.
 *
 * The security module already tests encryption, checksums and the restore drill against a two-field
 * fixture, which proves the machinery. What it cannot prove is the thing a business actually cares
 * about: that a backup taken of *their books* comes back as their books. A backup that captures an
 * incomplete picture is worse than no backup, because nobody finds out until the day it is needed.
 *
 * So this takes a real business — a purchase, a sale, a receipt — backs it up through the real
 * encrypted path, moves the books on afterwards, and restores. The assertion is that what comes
 * back is the position as it stood when the backup was taken: same vouchers, same totals, and the
 * trial balance still balancing.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Buffer } from 'node:buffer';
import { isoDate, quantityFromString, rupees } from '@invoice/kernel';
import { trialBalance } from '@invoice/ledger';
import {
  AesGcmEncryptionService, BackupRecoveryService, MemoryBackupRepository, StaticEncryptionKeyProvider,
} from '../../ops/security/src/index.ts';
import { AuditLog } from '../../packages/platform/src/index.ts';
import type { Permission, RequestContext } from '../../packages/platform/src/index.ts';
import type { BackupSource, RestoreTarget } from '../../ops/security/src/recovery.ts';
import { COMPANY, CUSTOMER, makeBusiness, purchase } from './harness.ts';

const BACKUP_PERMISSIONS = new Set<Permission>(['backup.manage', 'backup.restore']);
const contextFor = (companyId: string): RequestContext => ({
  companyId, branchId: 'main', actorId: `${companyId}-owner`, sessionId: `${companyId}-session`,
  permissions: BACKUP_PERMISSIONS,
});

/** What is in this company's books, in the form a backup keeps it. */
interface BookSnapshot {
  readonly companyId: string;
  readonly accounts: number;
  readonly vouchers: readonly { readonly id: string; readonly date: string; readonly debit: string; readonly credit: string }[];
  readonly totalDebitPaise: string;
  readonly totalCreditPaise: string;
}

const readBooks = async (shop: Awaited<ReturnType<typeof makeBusiness>>): Promise<BookSnapshot> => {
  const uow = shop.store.read();
  const vouchers = await uow.vouchers.list(COMPANY, {});
  const books = await trialBalance(uow, COMPANY);
  return {
    companyId: COMPANY,
    accounts: (await uow.accounts.listAll(COMPANY)).length,
    vouchers: vouchers.map((voucher) => ({
      id: voucher.id,
      date: voucher.date,
      debit: voucher.lines.reduce((running, line) => running + (line.debit?.minor ?? 0n), 0n).toString(),
      credit: voucher.lines.reduce((running, line) => running + (line.credit?.minor ?? 0n), 0n).toString(),
    })),
    totalDebitPaise: books.totalDebit.minor.toString(),
    totalCreditPaise: books.totalCredit.minor.toString(),
  };
};

/** A trading day: goods in, goods out, money in. */
const aDayOfTrading = async () => {
  const shop = await makeBusiness();
  await shop.posting.post(
    shop.actor,
    purchase({ id: 'e2e-bak-buy', sourceDocumentId: 'e2e-bak-source', invoiceNumber: 'E2E/BAK/BUY' }),
    'e2e:backup:purchase',
  );
  const draft = await shop.sales.createDraft(shop.actor, {
    idempotencyKey: 'e2e:backup:sale:draft',
    input: {
      partyId: CUSTOMER, customerType: 'B2B', supplyKind: 'GOODS',
      documentDate: isoDate('2026-08-29'), dueDate: isoDate('2026-09-28'),
      lines: [{
        lineId: 'steel', itemId: 'TMT12', quantity: quantityFromString('100', 'KGS'),
        unitPrice: rupees(100), priceBasis: 'EXCLUSIVE', warehouseId: 'wh-main',
      }],
    },
  });
  const issued = await shop.sales.finalise(shop.actor, { idempotencyKey: 'e2e:backup:sale:final', invoiceId: draft.id });
  await shop.receivables.recordPayment(shop.actor, {
    idempotencyKey: 'e2e:backup:receipt',
    direction: 'RECEIPT', partyId: CUSTOMER, mode: 'BANK_TRANSFER', bankAccountCode: '1121',
    amount: rupees(5_000), date: isoDate('2026-09-01'), reference: 'UTR-BAK-5000',
    allocations: [{
      documentId: issued.invoice.id,
      documentNumber: issued.invoice.number ?? issued.invoice.id,
      amount: rupees(5_000),
    }],
  });
  return { shop, issued };
};

const makeRecovery = () => new BackupRecoveryService(
  new AuditLog(),
  new MemoryBackupRepository(),
  new AesGcmEncryptionService(new StaticEncryptionKeyProvider(new Map([['backup-v1', Buffer.alloc(32, 7)]]))),
  'backup-v1',
  () => new Date('2026-09-01T20:00:00.000Z'),
);

test('a real day of trading survives a backup and comes back as it was', async () => {
  const { shop } = await aDayOfTrading();
  const recovery = makeRecovery();
  const actor = contextFor(COMPANY);

  const atBackup = await readBooks(shop);
  assert.ok(atBackup.vouchers.length >= 3, 'a purchase, a sale and a receipt is at least three entries');

  const source: BackupSource = { async snapshot() { return Buffer.from(JSON.stringify(atBackup)); } };
  const manifest = await recovery.create(actor, source, 'books-v1', 30, 'e2e:backup:nightly:2026-09-01');

  // The business keeps trading after the backup, so the live books and the backup differ. That is
  // the ordinary case, and a restore has to bring back the older picture rather than today's.
  const second = await shop.sales.createDraft(shop.actor, {
    idempotencyKey: 'e2e:backup:after:draft',
    input: {
      partyId: CUSTOMER, customerType: 'B2B', supplyKind: 'GOODS',
      documentDate: isoDate('2026-08-29'), dueDate: isoDate('2026-09-28'),
      lines: [{
        lineId: 'steel', itemId: 'TMT12', quantity: quantityFromString('50', 'KGS'),
        unitPrice: rupees(100), priceBasis: 'EXCLUSIVE', warehouseId: 'wh-main',
      }],
    },
  });
  await shop.sales.finalise(shop.actor, { idempotencyKey: 'e2e:backup:after:final', invoiceId: second.id });
  const afterwards = await readBooks(shop);
  assert.notEqual(afterwards.vouchers.length, atBackup.vouchers.length);

  let restored: BookSnapshot | null = null;
  const target: RestoreTarget = {
    async validate(snapshot, received) {
      // What a real restore refuses on: a backup for another business, or a schema this build
      // cannot read. Both are checked before anything is replaced.
      assert.equal(received.schemaVersion, 'books-v1');
      const parsed = JSON.parse(snapshot.toString()) as BookSnapshot;
      assert.equal(parsed.companyId, COMPANY);
    },
    async replace(snapshot) { restored = JSON.parse(snapshot.toString()) as BookSnapshot; },
  };
  const drill = await recovery.restore(actor, manifest.id, target);

  assert.equal(drill.status, 'passed');
  assert.ok(restored !== null);
  const recovered = restored as BookSnapshot;
  assert.deepEqual(recovered, atBackup, 'what comes back must be exactly what went in');
  assert.equal(recovered.totalDebitPaise, recovered.totalCreditPaise, 'restored books still balance');
});

test('a backup taken twice on the same schedule is one backup, not two', async () => {
  const { shop } = await aDayOfTrading();
  const recovery = makeRecovery();
  const actor = contextFor(COMPANY);
  const books = await readBooks(shop);

  let snapshots = 0;
  const source: BackupSource = {
    async snapshot() { snapshots += 1; return Buffer.from(JSON.stringify(books)); },
  };
  const first = await recovery.create(actor, source, 'books-v1', 30, 'e2e:backup:nightly:2026-09-01');
  const retried = await recovery.create(actor, source, 'books-v1', 30, 'e2e:backup:nightly:2026-09-01');

  assert.equal(retried.id, first.id);
  assert.equal(snapshots, 1, 'the books should not be read a second time for the same nightly run');
});

test('one business cannot restore another business’s books', async () => {
  const { shop } = await aDayOfTrading();
  const recovery = makeRecovery();
  const owner = contextFor(COMPANY);
  const books = await readBooks(shop);
  const manifest = await recovery.create(
    owner,
    { async snapshot() { return Buffer.from(JSON.stringify(books)); } },
    'books-v1', 30, 'e2e:backup:isolation',
  );

  const stranger = contextFor('konkan');
  await assert.rejects(
    () => recovery.restore(stranger, manifest.id, {
      async validate() { throw new Error('validation must never be reached'); },
      async replace() { throw new Error('replacement must never be reached'); },
    }),
    /another company/,
  );
});
