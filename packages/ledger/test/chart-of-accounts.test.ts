/**
 * Issue #73 — every role a posting template looks up has a real, postable account behind it.
 *
 * A posting template asks the chart for a role, not a code, so that renaming an account never
 * breaks a posting. That only holds if the role actually resolves to a leaf account: a role
 * pointing at nothing makes a module refuse a perfectly ordinary bill, and a role pointing at a
 * heading makes it post to something no figure can be drilled out of.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { asId, type AccountId, type CompanyId } from '@invoice/kernel';
import { DEFAULT_CHART, buildDefaultChart, defaultChartIdFactory } from '../src/domain/chart-of-accounts.ts';
import { appearsInProfitAndLoss, type SystemAccountRole } from '../src/domain/account.ts';

const COMPANY = asId<'Company'>('chart-test-co');

/** Every role a module is entitled to look up, and what it must be for the books to make sense. */
const EXPECTED: readonly { role: SystemAccountRole; type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE' }[] = [
  { role: 'ROUND_OFF', type: 'INCOME' },
  { role: 'OPENING_BALANCE_DIFFERENCE', type: 'EQUITY' },
  { role: 'RETAINED_EARNINGS', type: 'EQUITY' },
  { role: 'CASH_IN_HAND', type: 'ASSET' },
  { role: 'CHEQUES_IN_HAND', type: 'ASSET' },
  { role: 'STOCK_IN_HAND', type: 'ASSET' },
  { role: 'SALES_GOODS', type: 'INCOME' },
  { role: 'SALES_SERVICES', type: 'INCOME' },
  { role: 'SALES_RETURNS', type: 'EXPENSE' },
  { role: 'BAD_DEBTS', type: 'EXPENSE' },
  { role: 'PURCHASES_GOODS', type: 'EXPENSE' },
  { role: 'PURCHASES_SERVICES', type: 'EXPENSE' },
  { role: 'PURCHASE_RETURNS', type: 'EXPENSE' },
  { role: 'FREIGHT_OUTWARD', type: 'EXPENSE' },
  { role: 'DISCOUNT_ALLOWED', type: 'EXPENSE' },
  { role: 'OUTPUT_CGST', type: 'LIABILITY' },
  { role: 'OUTPUT_SGST', type: 'LIABILITY' },
  { role: 'OUTPUT_IGST', type: 'LIABILITY' },
  { role: 'OUTPUT_CESS', type: 'LIABILITY' },
  { role: 'REVERSE_CHARGE_PAYABLE', type: 'LIABILITY' },
  { role: 'INPUT_CGST', type: 'ASSET' },
  { role: 'INPUT_SGST', type: 'ASSET' },
  { role: 'INPUT_IGST', type: 'ASSET' },
  { role: 'INPUT_CESS', type: 'ASSET' },
];

test('every role in the standard chart resolves to one postable account of the right kind', () => {
  for (const expected of EXPECTED) {
    const matches = DEFAULT_CHART.filter((account) => account.systemRole === expected.role);
    assert.equal(matches.length, 1, `${expected.role} should name exactly one account, found ${matches.length}`);
    const account = matches[0] as (typeof DEFAULT_CHART)[number];
    assert.equal(account.isGroup, false, `${expected.role} points at "${account.name}", which is a heading and cannot be posted to`);
    assert.equal(account.type, expected.type, `${expected.role} is a ${account.type}, expected ${expected.type}`);
  }
});

test('account codes are unique, because the database enforces it', () => {
  const seen = new Map<string, string>();
  for (const account of DEFAULT_CHART) {
    const clash = seen.get(account.code);
    assert.equal(clash, undefined, `code ${account.code} is used by both "${clash}" and "${account.name}"`);
    seen.set(account.code, account.name);
  }
});

test('every account hangs off a heading that exists', () => {
  const codes = new Set(DEFAULT_CHART.map((account) => account.code));
  for (const account of DEFAULT_CHART) {
    if (account.parentCode === null) continue;
    assert.ok(codes.has(account.parentCode), `"${account.name}" hangs off ${account.parentCode}, which is not in the chart`);
    const parent = DEFAULT_CHART.find((candidate) => candidate.code === account.parentCode);
    assert.equal(parent?.isGroup, true, `"${account.name}" hangs off "${parent?.name}", which is not a heading`);
  }
});

test('what a business bought is a cost, and is not confused with what it sold', () => {
  const services = DEFAULT_CHART.find((a) => a.systemRole === 'PURCHASES_SERVICES');
  const goods = DEFAULT_CHART.find((a) => a.systemRole === 'PURCHASES_GOODS');
  assert.notEqual(services?.code, goods?.code, 'freight must not land in purchases of goods');
  assert.ok(appearsInProfitAndLoss('EXPENSE'), 'both belong on the profit and loss');
  assert.equal(services?.type, 'EXPENSE');
});

test('GST owed under reverse charge is not filed under GST collected from customers', () => {
  const reverseCharge = DEFAULT_CHART.find((a) => a.systemRole === 'REVERSE_CHARGE_PAYABLE');
  assert.notEqual(reverseCharge, undefined);
  const collected = DEFAULT_CHART.find((a) => a.code === '2200');
  assert.equal(collected?.name, 'GST you collected');
  assert.notEqual(
    reverseCharge?.parentCode,
    collected?.code,
    'nobody collected this from anyone; grouping it under "GST you collected" would say they did',
  );
});

test('the chart builds into real accounts with ids and parents wired up', () => {
  const built = buildDefaultChart(COMPANY as CompanyId, defaultChartIdFactory(COMPANY as CompanyId));
  const byId = new Map<AccountId, (typeof built)[number]>(built.map((account) => [account.id, account]));
  const services = built.find((account) => account.systemRole === 'PURCHASES_SERVICES');
  const reverseCharge = built.find((account) => account.systemRole === 'REVERSE_CHARGE_PAYABLE');

  assert.notEqual(services, undefined);
  assert.notEqual(reverseCharge, undefined);
  for (const account of [services, reverseCharge]) {
    assert.equal(account?.companyId, COMPANY);
    assert.equal(account?.active, true);
    assert.notEqual(account?.parentId, null, 'both hang off a heading');
    assert.notEqual(byId.get(account?.parentId as AccountId), undefined, 'and that heading is in the same chart');
  }
});
