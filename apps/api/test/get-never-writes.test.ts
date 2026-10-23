/**
 * Issue #395 — a GET only reads. Every GET in the route table, called by a viewer and by the owner,
 * leaves the books, the master data, the app's own stores and the operations queue as they were.
 * Before #395, opening the catalogue opened the walk-in customer's ledger account as the setup user,
 * and opening Operations seeded a failure and a job before checking `operations.read`.
 *
 * Every name and number here is synthetic (`packages/platform/src/seed.ts`).
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { handleApi, ROUTES } from '../src/server.ts';
import { apiRuntime } from '../src/runtime.ts';
import { DurableMap } from '../src/durable.ts';
import { LedgerService } from '../../../packages/ledger/src/service.ts';
import { MasterDataService } from '../../../packages/masters/src/masters.ts';
import { OperationalQueue, OperationsTelemetry } from '../../../ops/operations/src/operations.ts';
import { forgetBusinessDetails } from '../src/business-details-application.ts';
import { SAMPOORNA_OWNER, SAMPOORNA_VIEWER, signIn } from './sign-in-helper.ts';

const SAMPOORNA = '00000000-0000-4000-8000-000000000001';

/** Every method that changes one of the stores a GET could reach. */
const WRITES: readonly (readonly [object, readonly string[]])[] = [
  [LedgerService.prototype, ['initialiseCompany', 'openPartyAccount', 'postVoucher', 'postVoucherIn', 'recordPosted', 'reverseVoucher', 'reverseVoucherIn', 'recordReversed', 'amendVoucher', 'setPeriodState']],
  [MasterDataService.prototype, ['addAddress', 'correctAddress', 'createBankAccount', 'createBatch', 'createItem', 'createParty', 'createPriceList', 'createSerial', 'createTransporter', 'createVehicle', 'createWarehouse', 'mergeParties', 'registerItemConversion', 'setOpeningStock', 'setPrice', 'setTaxDefault', 'updateItem', 'updateParty']],
  [OperationalQueue.prototype, ['enqueue', 'begin', 'succeed', 'fail', 'replay']],
  [OperationsTelemetry.prototype, ['externalFailure']],
  [DurableMap.prototype, ['set', 'delete']],
];

/** Watches every write; `taken()` names the ones made since the last call. */
const watchWrites = (context: TestContext) => {
  const spies = WRITES.flatMap(([prototype, names]) => names.map((name) => {
    const owner = prototype as Record<string, (...args: unknown[]) => unknown>;
    return { name: `${prototype.constructor.name}.${name}`, spy: context.mock.method(owner, name) };
  }));
  return {
    taken: (): string[] => {
      const made = spies.filter(({ spy }) => spy.mock.callCount() > 0).map(({ name, spy }) => `${name} ×${spy.mock.callCount()}`);
      for (const { spy } of spies) spy.mock.resetCalls();
      return made;
    },
    calls: (name: string) => spies.find((watched) => watched.name === name)!.spy.mock.calls,
  };
};

const get = async (path: string, session: string) => {
  const response = await handleApi('GET', path, {}, `Bearer ${session}`);
  return { status: response.status, body: response.headers['content-type']?.includes('json') ? JSON.parse(String(response.body)) as Record<string, any> : null };
};

/** Signed in, and the company opened (its books set up) before anything is watched. */
const openCompany = async () => {
  const owner = await signIn(SAMPOORNA_OWNER, SAMPOORNA);
  const viewer = await signIn(SAMPOORNA_VIEWER, SAMPOORNA);
  const runtime = apiRuntime();
  await runtime.application(await runtime.authenticate(`Bearer ${owner}`));
  return { owner, viewer };
};

test('#395: every GET in the route table, as a viewer and as the owner, writes nothing', async (context) => {
  const { owner, viewer } = await openCompany();
  const invoice = (await get('/api/einvoices/invoices', owner)).body?.invoices?.[0]?.id as string | undefined;
  const writes = watchWrites(context);
  const gets = ROUTES.filter((route) => route.method === 'GET');
  assert.ok(gets.length > 30, `only ${gets.length} GET routes are in the table`);
  const wrote: string[] = [];
  for (const route of gets) {
    const paths = [route.path.replace(/:\w+/g, 'probe')];
    if (route.path.includes(':invoice') && invoice !== undefined) paths.push(route.path.replace(':invoice', encodeURIComponent(invoice)));
    for (const path of paths) {
      for (const [who, session] of [['viewer', viewer], ['owner', owner]] as const) {
        const { status } = await get(path, session);
        assert.notEqual(status, 500, `GET ${path} as the ${who} failed on our side`);
        const made = writes.taken();
        if (made.length > 0) wrote.push(`GET ${path} as the ${who} (${status}): ${made.join(', ')}`);
      }
    }
  }
  assert.deepEqual(wrote, [], 'these GETs wrote');
});

test('#395: a viewer opening the catalogue opens no ledger account, and the walk-in customer is already listed', async (context) => {
  const { viewer } = await openCompany();
  const writes = watchWrites(context);
  const catalogue = await get('/api/catalogue', viewer);
  assert.equal(catalogue.status, 200);
  assert.ok(catalogue.body!.customers.some((customer: any) => customer.walkIn), 'the walk-in customer is on the list');
  assert.deepEqual(writes.taken(), []);
});

test('#395: a viewer refused the Operations screen has written nothing to it', async (context) => {
  const { owner, viewer } = await openCompany();
  const before = (await get('/api/operations', owner)).body!;
  const writes = watchWrites(context);
  assert.equal((await get('/api/operations', viewer)).status, 403);
  assert.deepEqual(writes.taken(), [], 'refused, and nothing was seeded either');
  const after = (await get('/api/operations', owner)).body!;
  assert.deepEqual({ failures: after.failures, jobs: after.jobs }, { failures: before.failures, jobs: before.jobs });
});

test('#395: saving business details opens the walk-in customer\'s account as the person saving them', async (context) => {
  const { owner } = await openCompany();
  const runtime = apiRuntime();
  const session = await runtime.authenticate(`Bearer ${owner}`);
  const writes = watchWrites(context);
  forgetBusinessDetails(SAMPOORNA);
  const saved = await handleApi('POST', '/api/business-details', { legalName: 'Sampoorna Traders', address1: 'Plot 14, 2nd Phase, Peenya Industrial Area', city: 'Bengaluru', pincode: '560058', stateCode: '29' }, `Bearer ${owner}`);
  assert.equal(saved.status, 200, String(saved.body));
  const opened = writes.calls('LedgerService.openPartyAccount');
  assert.equal(opened.length, 1, 'the walk-in customer\'s account was opened once');
  const [actor, account] = opened[0]!.arguments as [{ userId: string; permissions: readonly string[] }, { kind: string; name: string }];
  assert.equal(account.kind, 'CUSTOMER');
  assert.equal(actor.userId, session.actorId);
  assert.deepEqual([...actor.permissions].sort(), [...session.permissions].sort(), 'with the owner\'s own permissions, not the setup user\'s');
});
