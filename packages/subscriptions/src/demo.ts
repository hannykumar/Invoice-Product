/**
 * Issue #42 [E42] — a shop on the free plan, a busy month, and the day the plan runs out.
 *
 *   npm run demo:subscriptions
 *
 * The books underneath are real. The point of the demo is what does *not* happen: when the plan
 * lapses, the trial balance is identical before and after, every warning still works, and the data
 * can still be taken away.
 */
import { formatINR } from '@invoice/kernel';
import { makeSubscriptionDesk, TODAY } from '../test/harness.ts';
import { ESSENTIAL_CAPABILITIES, SHIPPED_PLANS } from './index.ts';

const heading = (text: string): void => console.log(`\n${text}\n${'─'.repeat(text.length)}`);
const day = (value: string) => value as never;

const desk = await makeSubscriptionDesk();

heading('The plans, and what they may not take away');
for (const plan of SHIPPED_PLANS) {
  const bills = plan.limits.find((limit) => limit.meter === 'invoices')?.perMonth;
  console.log(`  ${plan.name['en-IN'].padEnd(8)} ${formatINR(plan.monthlyPrice).padStart(10)}/month   bills: ${bills === null ? 'no limit' : bills}   trial ${plan.trialDays}d, grace ${plan.graceDays}d`);
}
console.log(`\n  Not withholdable by any plan: ${ESSENTIAL_CAPABILITIES.join(', ')}`);

heading('1. A shop on the free plan issues 48 bills this month');
await desk.service.start(desk.actor, { planId: 'free', on: TODAY });
for (let i = 0; i < 48; i += 1) {
  await desk.service.recordUsage(desk.actor, { meter: 'invoices', idempotencyKey: `bill-${i}`, note: 'bill issued', on: TODAY });
}
const near = await desk.service.check(desk.actor, 'sales.issue_invoice', TODAY);
console.log(`  ${near.outcome}: ${near.reason['en-IN']}`);

heading('2. The 51st bill');
for (const i of [48, 49]) {
  await desk.service.recordUsage(desk.actor, { meter: 'invoices', idempotencyKey: `bill-${i}`, note: 'bill issued', on: TODAY });
}
const over = await desk.service.check(desk.actor, 'sales.issue_invoice', TODAY);
console.log(`  ${over.outcome}: ${over.reason['en-IN']}`);
console.log(`  In Hindi: ${over.reason['hi-IN']}`);

heading('3. The same shop, asking about a supplier and about GST — on the free plan, over its limit');
for (const capability of ['supplier.risk_warning', 'gst.compliance_warning', 'data.export']) {
  const entitlement = await desk.service.check(desk.actor, capability, TODAY);
  console.log(`  ${capability.padEnd(26)} ${entitlement.outcome}  ${entitlement.reason['en-IN']}`);
}

heading('4. Upgrading, and the limit lifting at once');
await desk.service.changePlan(desk.actor, { planId: 'growth', on: TODAY, reason: 'Busy season' });
const after = await desk.service.check(desk.actor, 'sales.issue_invoice', TODAY);
console.log(`  ${after.outcome}: ${after.reason['en-IN']}`);
console.log(`  The 50 bills already issued are still 50: ${(await desk.service.usage(desk.actor, TODAY)).find((total) => total.meter === 'invoices')?.used}`);

heading('5. Our own invoice for the month');
const invoice = await desk.service.issueServiceInvoice(desk.actor, { period: '2026-06', on: TODAY });
console.log(`  Net ${formatINR(invoice.net)} + GST ${formatINR(invoice.gst)} = ${formatINR(invoice.total)}  (${invoice.state})`);
console.log('  Not yet a compliant outbound GST invoice: that needs our own GSTIN, which is issue #49.');

heading('6. The card is declined');
desk.payments.declineNext = true;
const failed = await desk.service.chargeServiceInvoice(desk.actor, invoice.id, TODAY);
console.log(`  ${failed.state}: ${failed.failureReason}`);
const stillFine = await desk.service.check(desk.actor, 'sales.issue_invoice', TODAY);
console.log(`  And the shop can still work: ${stillFine.outcome} (${stillFine.state})`);

heading('7. Nobody pays. Three months later.');
const lapsed = await desk.service.account(desk.actor, day('2026-09-01'));
console.log(`  State: ${lapsed.state}`);
console.log(`  ${lapsed.stateWords['en-IN']}`);
const write = await desk.service.check(desk.actor, 'sales.issue_invoice', day('2026-09-01'));
console.log(`  Issuing a bill:  ${write.outcome}`);
for (const capability of ['reports.view.financial', 'data.export', 'gst.compliance_warning', 'supplier.risk_warning']) {
  const entitlement = await desk.service.check(desk.actor, capability, day('2026-09-01'));
  console.log(`  ${capability.padEnd(26)} ${entitlement.outcome}`);
}

heading('8. And the books themselves');
const balance = await desk.business.reports.trialBalance(desk.actor, { from: day('2026-04-01'), to: day('2026-09-01') });
console.log(`  Trial balance still reads back, and still balances: ${balance.body.balanced}`);
console.log('  Nothing was deleted, hidden or degraded. That is the whole point of the state being called read-only.\n');
