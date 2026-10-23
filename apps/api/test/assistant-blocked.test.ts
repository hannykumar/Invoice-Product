/**
 * Issue #397 — "why is this bill blocked?" answers as the person who asked.
 *
 * Before, the running app looked the bill up with no check of the asker and read its stock as the
 * company's setup identity, so a staff member who could only ask questions learnt that a bill
 * existed, who it was for, which items were short and by how much.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { InventoryService } from '@invoice/inventory';
import { InMemorySalesRepository } from '@invoice/sales';
import { handleApi } from '../src/server.ts';
import { useFixedAppClock } from '../src/app-clock.ts';
import { apiRuntime } from '../src/runtime.ts';
import { signIn } from './sign-in-helper.ts';
import { stockEverything } from './stock-helper.ts';

useFixedAppClock('2026-09-28T10:00:00.000Z');

const SAMPOORNA = '00000000-0000-4000-8000-000000000001';
const ACCOUNTANT = 'accounts@sampoorna.example.invalid';
const SETUP_USER = '00000000-0000-4000-8000-000000000003';
/** What the test calls the bill under review, so the question can name it as a person would. */
const REFERENCE = 'DRAFT/397';

const signedIn = async (address: string) => {
  const token = await signIn(address, SAMPOORNA);
  const runtime = apiRuntime();
  const context = await runtime.authenticate(`Bearer ${token}`);
  return { token, actor: runtime.actor(context), app: await runtime.application(context) };
};

test('a bill waiting to go out is explained only to someone who may see bills and stock, and read as them', async (context) => {
  const accountant = await signedIn(ACCOUNTANT);
  await stockEverything(`Bearer ${accountant.token}`);
  const reviewed = await handleApi('POST', '/api/sales/preview', {
    party: 'ABC Traders', item: 'Herbal Bath Soap 100g', quantity: '2', rate: '100', date: '2026-09-27', terms: '7', reference: 'ASSIST-397',
  }, `Bearer ${accountant.token}`);
  assert.equal(reviewed.status, 200, String(reviewed.body));
  const draftId = (JSON.parse(String(reviewed.body)) as { token: string }).token;

  // A reviewed bill has no number yet; the test gives it one so the question can name it.
  const list = InMemorySalesRepository.prototype.list;
  context.mock.method(InMemorySalesRepository.prototype, 'list', async function (this: InMemorySalesRepository, ...args: Parameters<typeof list>) {
    return (await list.apply(this, args)).map((invoice) => (invoice.id === draftId ? { ...invoice, number: REFERENCE } : invoice));
  });
  const balance = InventoryService.prototype.balance;
  const stockReadAs: string[] = [];
  context.mock.method(InventoryService.prototype, 'balance', function (this: InventoryService, ...args: Parameters<typeof balance>) {
    stockReadAs.push(String(args[0].userId));
    return balance.apply(this, args);
  });
  const question = { question: `why is ${REFERENCE} blocked?` };

  // Only allowed to ask questions: told plainly, and nothing about the bill or its stock is read.
  const askOnly = { ...accountant.actor, permissions: ['assistant.ask'] };
  const refused = await accountant.app.ask(askOnly, question);
  assert.equal(refused.intent, 'WHY_BLOCKED');
  assert.equal(refused.state, 'NEEDS_PERMISSION');
  assert.deepEqual(refused.sentences.map((sentence) => sentence['en-IN']), [
    'You do not have access to that bill. Ask the owner if you need to see bills and stock.',
  ]);
  assert.doesNotMatch(JSON.stringify(refused), /ABC Traders|Herbal Bath Soap|held up by|free to sell/);
  assert.deepEqual(stockReadAs, [], 'no stock was read for someone who may not see it');

  // Allowed to see bills but not stock: still refused, so the shortfall is never told.
  const noStock = { ...accountant.actor, permissions: ['assistant.ask', 'reports.view.sales'] };
  assert.equal((await accountant.app.ask(noStock, question)).state, 'NEEDS_PERMISSION');
  assert.deepEqual(stockReadAs, []);

  // Someone who may see both gets the answer, and the stock is read as them, not as the setup user.
  const answered = await accountant.app.ask(accountant.actor, question);
  assert.equal(answered.state, 'NEEDS_A_PERSON');
  assert.match(JSON.stringify(answered.sentences), /ABC Traders/);
  assert.ok(stockReadAs.length > 0, 'the bill’s lines were checked against stock');
  assert.ok(stockReadAs.every((userId) => userId === String(accountant.actor.userId)), stockReadAs.join(', '));
  assert.notEqual(String(accountant.actor.userId), SETUP_USER);
});
