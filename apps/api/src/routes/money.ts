/**
 * Issue #344 — the business's plan (#42), the assistant that does things (#47), payment reminders
 * (#23) and bank feeds.
 */
import { anything, fields, get, need, nothing, list, post, text, type Route } from './route.ts';

const PLAN = need('change your plan', 'subscription.manage');
const SEND = need('send payment reminders', 'collections.reminders.send');
const DISPUTES = need('handle a disputed bill', 'collections.dispute.manage');
const BANK = need('connect a bank account', 'bank.feed.manage');

const subscription = fields({ planId: text, reason: text });
const agent = fields({ request: text, today: anything, planId: text, fingerprint: text, idempotencyKey: text });
const reminder = fields({
  today: anything, documentId: anything, reminderId: text, partyId: text, reason: text, amount: anything, promisedOn: text, note: anything,
  disputeId: text, resolution: text,
});
const bankFeed = fields({ provider: text, redirectUri: text, connectionId: text, authorizationCode: text, idempotencyKey: text });

export const MONEY_ROUTES: readonly Route[] = [
  // Issue #42 — what this business's plan covers, what it has used, and paying for it.
  get('/api/subscription', { access: need('see your plan', 'subscription.view'), input: subscription }, ({ app, actor, input }) => app.subscriptionAccount(actor, input)),
  post('/api/subscription/plan', { access: PLAN, input: subscription }, ({ app, actor, input }) => app.changeSubscriptionPlan(actor, input)),
  post('/api/subscription/pay', { access: PLAN, input: subscription }, ({ app, actor, input }) => app.issueSubscriptionInvoice(actor, input)),

  // Issue #47 — asking the assistant to do something: what it would do, and then doing it.
  get('/api/agent/capabilities', { access: need('plan work for the assistant', 'agent.plan'), input: nothing }, ({ app, actor }) => app.agentCapabilities(actor)),
  list('/api/agent/history', { access: need('plan work for the assistant', 'agent.plan'), key: 'plans' }, ({ app, actor }) => app.agentHistory(actor)),
  post('/api/agent/plan', { access: need('ask the assistant to do something', 'agent.plan'), input: agent }, ({ app, actor, input }) => app.agentPlan(actor, input)),
  post('/api/agent/approve', { access: need('approve what the assistant will do', 'agent.approve'), input: agent }, ({ app, actor, input }) => app.agentApprove(actor, input)),
  post('/api/agent/execute', { access: need('let the assistant do something', 'agent.execute'), input: agent }, ({ app, actor, input }) => app.agentExecute(actor, input)),

  // Issue #23 — who is being chased for money, who is deliberately not, and what was sent.
  get('/api/reminders', { access: need('see payment reminders', 'collections.reminders.view'), input: reminder }, ({ app, actor, input }) => app.reminders(actor, input)),
  post('/api/reminders', { access: need('see payment reminders', 'collections.reminders.view'), input: reminder }, ({ app, actor, input }) => app.reminders(actor, input)),
  post('/api/reminders/send', { access: SEND, input: reminder }, ({ app, actor, input }) => app.sendReminder(actor, input)),
  post('/api/reminders/send-all', { access: SEND, input: reminder }, ({ app, actor, input }) => app.sendAllReminders(actor, input)),
  post('/api/reminders/retry', { access: SEND, input: reminder }, ({ app, actor, input }) => app.retryReminder(actor, input)),
  post('/api/reminders/stop', { access: SEND, input: reminder }, ({ app, actor, input }) => app.stopReminders(actor, input)),
  post('/api/reminders/resume', { access: SEND, input: reminder }, ({ app, actor, input }) => app.resumeReminders(actor, input)),
  post('/api/reminders/promise', { access: need('record a promise to pay', 'collections.promise.record'), input: reminder }, ({ app, actor, input }) => app.recordPromiseToPay(actor, input)),
  post('/api/reminders/dispute', { access: DISPUTES, input: reminder }, ({ app, actor, input }) => app.raiseBillDispute(actor, input)),
  post('/api/reminders/dispute/resolve', { access: DISPUTES, input: reminder }, ({ app, actor, input }) => app.resolveBillDispute(actor, input)),

  get('/api/bank-feeds', { access: need('see bank balances', 'bank.balance.read'), input: nothing }, ({ app, actor }) => app.bankFeedWorkspace(actor)),
  post('/api/bank-feeds/consent', { access: BANK, input: bankFeed }, ({ app, actor, input }) => app.startBankFeedConsent(actor, input)),
  post('/api/bank-feeds/consent/complete', { access: BANK, input: bankFeed }, ({ app, actor, input }) => app.completeBankFeedConsent(actor, input)),
  post('/api/bank-feeds/sync', { access: need('fetch bank entries', 'bank.feed.sync'), input: bankFeed }, ({ app, actor, input }) => app.syncBankFeed(actor, input)),
  post('/api/bank-feeds/disconnect', { access: BANK, input: bankFeed }, ({ app, actor, input }) => app.disconnectBankFeed(actor, input)),
];
