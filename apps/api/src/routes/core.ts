/**
 * Issue #344 — signing in, the session, Home, reports, operations, the assistant, setting up a
 * business, its look and particulars, the catalogue, delivery choices and bringing books in.
 */
import { stateOfPincode } from '../../../../packages/masters/src/index.ts';
import { DemoApplication } from '../demo-application.ts';
import { finishOnboarding, previewOnboarding } from '../onboarding-application.ts';
import { chooseMark, searchMarks } from '../trade-mark-application.ts';
import { previewBranding, readBranding, saveBranding } from '../branding-application.ts';
import { currentStates, readBusinessDetails } from '../business-details-application.ts';
import { completeUpload, downloadLink, requestUpload } from '../files-application.ts';
import { analyseFile, approveAndPreview, commitImport, previewImport, remapColumns, rollbackImport, startMigration } from '../migration-application.ts';
import { isGovernmentConnector, receiveGovernmentWebhook } from '../government-webhooks.ts';
import { anything, fields, get, need, needAny, nothing, post, publicRoute, replyJson, replyWithCookie, signedIn, text, REFERENCE, type Route } from './route.ts';
import { AuthenticationError, canonicalAddress, clearedSessionCookie, sessionCookie } from '../sign-in.ts';
import { LIMITS, type Limit } from '../../../../packages/platform/src/rate-limits.ts';
import { spend, usageToday } from '../spending.ts';
import { outsideUnitOfWork } from '../../../../packages/platform/src/database.ts';
import type { ApiRuntime } from '../runtime.ts';
import type { RequestContext } from '../../../../packages/platform/src/index.ts';

const PARTIES = need('add or change customers, suppliers or transporters', 'masters.party.write');
const ITEMS = need('add or change items and the GST rate on them', 'masters.item.write', 'masters.item.rate.declare');
const BRANDING = need('change how your bills look', 'branding.write');
const MIGRATE = need('bring in books from another program', 'migration.run');
const TEAM = need('manage who can use this business', 'access.review');

/** A customer, supplier, transporter or address form: every field is read and checked by the master-data service. */
const partyForm = fields({ name: text, legalName: text, gstin: text, stateCode: text, pincode: text, reference: text });
const itemForm = fields({ itemId: text, name: text, hsn: text, hsnSac: text, unit: text, barcode: text, price: text, reference: text });
const customerOnly = fields({ customerId: text });
const workspace = fields({ workspaceId: text, batchId: text });
/** Bringing books in: which file, and how its columns map. `columns` is the service's own mapping shape. */
const migration = fields({ workspaceId: text, batchId: text, entity: text, fileName: text, content: text, columns: anything, fingerprint: text, reason: text, acceptDifferenceReason: text });
/** Setting up a business: the onboarding service reads and checks every answer itself. */
const onboarding = fields({ businessType: text, registration: text, legalName: text, tradeName: text, gstin: text, stateCode: text, pincode: text, booksStartDate: text });

/** Issue #342 — who is signed in, where, and the other businesses they can switch to. */
const sessionView = async (runtime: ApiRuntime, context: RequestContext) => ({
  company: runtime.companySummary(context.companyId),
  userId: context.actorId,
  permissions: [...context.permissions],
  companies: (await runtime.signIn.companies(context)).map((membership) => runtime.companySummary(membership.companyId)),
});

/**
 * Issue #341 — adding a file needs one of the rights a kind of file asks for, checked before the body
 * is read; the files service then checks the exact one for that kind (a bill needs purchase posting,
 * a logo branding). Opening a file is checked by the service, by kind, like every GET.
 */
const ADD_FILE = needAny('add a file', 'ledger.post.purchase', 'branding.write');

export const CORE_ROUTES: readonly Route[] = [
  // Issue #341 — private file storage: an address to upload to, the screening when it has arrived, a short-lived address to open it.
  post('/api/files/uploads', { access: ADD_FILE, input: fields({ purpose: text, fileName: text, contentType: text, sizeBytes: anything }) },
    ({ runtime, actor, input }) => requestUpload(runtime.database, actor, input)),
  post('/api/files/:file/complete', { access: ADD_FILE, input: nothing },
    ({ runtime, actor, params }) => completeUpload(runtime.database, actor, { fileId: params.file })),
  get('/api/files/:file/link', { access: needAny('open a file', 'purchases.view', 'business.settings.read', 'branding.write', 'ledger.post.purchase'), input: nothing },
    ({ runtime, actor, params }) => downloadLink(runtime.database, actor, params.file!)),
  // Issue #342 — signing in with a one-time code to a phone number or email (ADR D1). The session
  // comes back only as an HttpOnly cookie (ADR D2): the reply body never carries it.
  // Issue #350 — every code costs an SMS: per number or email, per day, per IP, and Karobar's daily cap.
  post('/api/auth/code', { access: publicRoute('asking for a sign-in code: there is no session yet'), input: fields({ address: text }) },
    async ({ runtime, input, clientIp }) => {
      const address = canonicalAddress(String(input.address ?? '')).value;
      if (clientIp !== undefined) await runtime.limits.take(LIMITS.codeRequestsPerIp, clientIp);
      await runtime.limits.take(LIMITS.codeRequestsPerAddress, address);
      await runtime.limits.take(LIMITS.codesPerAddressPerDay, address);
      await spend(runtime.limits, 'sms', null);
      return runtime.signIn.sendCode(address);
    }),
  post('/api/auth/sign-in', { access: publicRoute('signing in: there is no session yet to hold a permission'), input: fields({ address: text, code: text, companyId: text, invitation: text }) },
    async ({ runtime, input, authorization, clientIp }) => {
      // Issue #350 — every attempt is counted before the code is checked, so guesses sent all at once
      // are counted too; a right code is given back, so only wrong ones add up. Once there are too
      // many, even the right one waits.
      const address = canonicalAddress(String(input.address ?? '')).value;
      const counters: [Limit, string][] = [[LIMITS.wrongCodesPerAddress, address], ...(clientIp === undefined ? [] : [[LIMITS.wrongCodesPerIp, clientIp] as [Limit, string]])];
      for (const [limit, key] of counters) await runtime.limits.take(limit, key);
      let opened;
      try {
        opened = await runtime.signIn.checkCode(String(input.address ?? ''), String(input.code ?? ''), input.companyId === undefined ? undefined : String(input.companyId), input.invitation === undefined ? undefined : String(input.invitation));
      } catch (error) {
        // A wrong code stays counted; anything else (no business yet, an outage) was not a guess.
        if (!(error instanceof AuthenticationError)) for (const [limit, key] of counters) await runtime.limits.giveBack(limit, key);
        throw error;
      }
      for (const [limit, key] of counters) await runtime.limits.giveBack(limit, key);
      await runtime.signIn.replaceSession(/^Bearer\s+(\S+)$/i.exec(authorization ?? '')?.[1]);
      return replyWithCookie({ company: runtime.companySummary(opened.companyId), expiresAt: opened.expiresAt }, sessionCookie(opened.token));
    }),
  post('/api/auth/sign-out', { access: signedIn('anyone signed in may end their own session'), input: nothing },
    async ({ runtime, context }) => { await runtime.signIn.signOut(context); return replyWithCookie({ signedOut: true }, clearedSessionCookie()); }),
  // Another of the person's own businesses: a new session, no second sign-in. The company named here
  // is only a choice, checked against their memberships; every later request reads it from the session.
  post('/api/session/company', { access: signedIn('switching to another business the person belongs to; checked against their memberships'), input: fields({ companyId: text, branchId: text }) },
    async ({ runtime, context, input }) => {
      // On PostgreSQL every signed-in request runs in its company's unit of work; the new session belongs
      // to another company, so it is written outside it (one action never touches two companies, #363).
      const opened = await outsideUnitOfWork(() => runtime.signIn.switchCompany(context, String(input.companyId ?? ''), input.branchId === undefined ? undefined : String(input.branchId)));
      return replyWithCookie({ company: runtime.companySummary(opened.companyId), expiresAt: opened.expiresAt }, sessionCookie(opened.token));
    }),
  get('/api/status', { access: publicRoute('the health check a load balancer reads; says nothing about any company'), input: nothing },
    ({ runtime }) => runtime.publicStatus()),
  // Issue #123 — a provider's callback about a government call. No session: it authenticates by
  // signing the bytes it sent, so it reads the raw body rather than the parsed one.
  post('/api/webhooks/government/:kind', { access: publicRoute('the government provider proves itself by signing the bytes it sent'), input: anything },
    async ({ params, delivery, runtime }) => {
      if (!isGovernmentConnector(params.kind!)) return replyJson(404, { state: 'failed', title: 'Not found', message: 'That is not a government callback address.' });
      const received = await receiveGovernmentWebhook(params.kind!, delivery?.rawBody ?? '', delivery?.signature ?? '', runtime.database);
      return replyJson(received.status, { state: 'received', outcome: received.outcome });
    }),

  // Issue #343 — the people in this business. Inviting, changing a role, removing and handing over
  // need `access.review`; the team service adds the owner-only rules. Leaving is anyone's own choice.
  get('/api/team', { access: TEAM, input: nothing }, ({ runtime, context }) => runtime.team.list(context)),
  post('/api/team/invite', { access: TEAM, input: fields({ address: text, role: text }) }, async ({ runtime, context, input }) => {
    const { invitation, token } = await runtime.team.invite(context, canonicalAddress(String(input.address ?? '')).value, String(input.role ?? ''));
    // The link is shown once, to the person inviting, who sends it on; only its hash is kept.
    return { state: 'invited', invitation, link: `/#join=${encodeURIComponent(token)}` };
  }),
  post('/api/team/role', { access: TEAM, input: fields({ userId: text, role: text }) },
    async ({ runtime, context, input }) => { await runtime.team.changeRole(context, String(input.userId ?? ''), String(input.role ?? '')); return runtime.team.list(context); }),
  post('/api/team/remove', { access: TEAM, input: fields({ userId: text }) },
    async ({ runtime, context, input }) => { await runtime.team.remove(context, String(input.userId ?? '')); return runtime.team.list(context); }),
  post('/api/team/transfer', { access: need('hand the business over', 'business.transfer'), input: fields({ userId: text }) },
    async ({ runtime, context, input }) => { await runtime.team.transfer(context, String(input.userId ?? '')); return runtime.team.list(context); }),
  post('/api/team/leave', { access: signedIn('anyone may leave a business they belong to; the last owner is refused by the team service'), input: nothing },
    async ({ runtime, context }) => { await runtime.team.leave(context); await runtime.signIn.signOut(context); return replyWithCookie({ left: true }, clearedSessionCookie()); }),

  // Issue #350 — what this business used today of each paid service, and its daily allowance.
  get('/api/usage', { access: need('see your plan', 'subscription.view'), input: nothing },
    async ({ runtime, context }) => ({ services: await usageToday(runtime.limits, context.companyId) })),

  get('/api/session', { access: signedIn('who is signed in, where, and their own businesses: every member may see their own'), input: nothing }, ({ runtime, context }) => sessionView(runtime, context)),
  get('/api/dashboard', { access: need('see the Home page', 'dashboard.read'), input: nothing }, ({ app, actor }) => app.dashboard(actor)),
  get('/api/reports', { access: needAny('see reports', 'reports.view.financial', 'reports.view.sales', 'reports.view.purchase', 'reports.view.stock', 'reports.view.dues', 'reports.view.gst'), input: nothing }, ({ app, actor }) => app.reports(actor)),
  get('/api/operations', { access: need('see whether the service is working', 'operations.read'), input: nothing }, ({ runtime, context }) => runtime.operationsWorkspace(context)),
  post('/api/operations/jobs/replay', { access: need('replay a stuck job', 'queue.replay'), input: fields({ jobId: text }) },
    ({ runtime, context, input }) => runtime.replayOperationalJob(context, input)),
  // Issue #358 — proves a fault reaches the error tracker: throws on purpose, in staging only. Anywhere
  // else it is not there at all. Operators only, like replaying a job.
  post('/api/operations/error-check', { access: need('check that errors reach the error tracker', 'queue.replay'), input: nothing }, ({ requestId }) => {
    if (process.env.NODE_ENV !== 'staging') return replyJson(404, { state: 'failed', title: 'Not found', message: 'That API route does not exist. Nothing was saved.', requestId });
    throw new TypeError(`Error-tracker check, request ${requestId}: this error was thrown on purpose.`);
  }),
  post('/api/operations/support-grants', { access: need('give support staff access', 'support.access.grant'), input: fields({ supportActorId: text, reason: text, durationMinutes: text, scopes: anything }) },
    ({ runtime, context, input }) => runtime.grantSupportAccess(context, input)),

  // Issue #34 — ask about this company's own books; the answer cites the report every figure came
  // from, and the notification behind every rule it quotes.
  get('/api/assistant/examples', { access: need('ask about the books', 'assistant.ask'), input: nothing }, () => ({ examples: DemoApplication.assistantExamples() })),
  post('/api/assistant/ask', { access: need('ask about the books', 'assistant.ask'), input: fields({ question: text }) },
    ({ app, actor, input }) => app.ask(actor, input)),

  // Issue #237 — the one list of current states, for setting up a business.
  get('/api/states', { access: REFERENCE, input: nothing }, () => ({ states: currentStates() })),
  // Issue #288 — the state a PIN code is in, so the customer form fills it in.
  post('/api/pincode/state', { access: signedIn('a lookup in the public PIN table: reads nothing of the company, stores nothing'), input: fields({ pincode: text }) },
    ({ input }) => ({ stateCode: stateOfPincode(String(input.pincode ?? '')) })),
  // Setting up a business runs against its own fresh company, so it needs a signed-in session but
  // not the session's company.
  post('/api/onboarding/preview', { access: need('set up a business', 'onboarding.run'), input: onboarding },
    ({ context, input }) => previewOnboarding(input, context.companyId)),
  post('/api/onboarding/finish', { access: need('set up a business', 'onboarding.finish'), input: onboarding },
    ({ context, input }) => finishOnboarding(input, context.companyId)),

  // Issue #147 — the mark of a trade: search the picture library, then keep what was picked.
  post('/api/trade-marks/search', { access: BRANDING, input: fields({ query: text, limit: text }) }, ({ input }) => searchMarks(input)),
  post('/api/trade-marks/choose', { access: BRANDING, input: fields({ pictureId: text, opacityPercent: text }) }, ({ input }) => chooseMark(input)),
  // Issues #146 and #147 — the business's own logo, mark and colour, and a real bill to see them on.
  get('/api/branding', { access: need('see how your bills look', 'business.settings.read'), input: nothing }, ({ context }) => readBranding(context.companyId)),
  post('/api/branding', { access: BRANDING, input: fields({ logoDataUri: text, accent: text, pictureId: text, opacityPercent: text, templateId: text, clear: anything }) },
    ({ context, input }) => saveBranding(context.companyId, input)),
  post('/api/branding/preview', { access: BRANDING, input: fields({ logoDataUri: text, accent: text, pictureId: text, templateId: text, locale: text, format: text }) },
    ({ runtime, context, input }) => previewBranding(context.companyId, runtime.companySummary(context.companyId).name, input)),
  // Issue #144 — the UPI id the pay-by-scan square on every bill pays to.
  post('/api/branding/upi', { access: need('change the UPI id customers pay into', 'payments.upi.write'), input: fields({ upiId: text, clear: anything }) },
    ({ app, actor, input }) => app.saveUpiId(actor, input)),
  // Issue #180 — the business's own name, address, PIN code, phone, PAN and bank, in one place.
  get('/api/business-details', { access: need('see your business details', 'business.settings.read'), input: nothing },
    ({ runtime, context }) => readBusinessDetails(context.companyId, runtime.companyIdentity(context.companyId))),
  post('/api/business-details', { access: need('change your business details', 'business.settings.write'),
    input: fields({ legalName: text, tradeName: text, address1: text, address2: text, city: text, pincode: text, stateCode: text, phone: text, email: text, pan: text, bankName: text, accountNumber: text, ifsc: text, branch: text }) },
  ({ runtime, app, actor, context, input }) => app.saveBusinessDetails(actor, runtime.companyIdentity(context.companyId), input)),

  // Issue #181 — the customers and items this business keeps; #228 the businesses it buys from.
  get('/api/catalogue', { access: need('see customers, suppliers and items', 'masters.read'), input: nothing }, ({ app, actor }) => app.catalogue(actor)),
  post('/api/customers', { access: PARTIES, input: partyForm }, ({ app, actor, input }) => app.addCustomer(actor, input)),
  post('/api/suppliers', { access: PARTIES, input: partyForm }, ({ app, actor, input }) => app.addSupplier(actor, input)),
  post('/api/items', { access: ITEMS, input: itemForm }, ({ app, actor, input }) => app.addItem(actor, input)),
  post('/api/items/code', { access: ITEMS, input: itemForm }, ({ app, actor, input }) => app.changeItemCode(actor, input)),
  // Issue #308 — the item's own edit dialog, and what the item picker ranks and prices with.
  post('/api/items/edit', { access: ITEMS, input: itemForm }, ({ app, actor, input }) => app.editItem(actor, input)),
  post('/api/items/selling', { access: need('start a bill', 'sales.draft.write'), input: customerOnly }, ({ app, actor, input }) => app.itemSelling(actor, input)),
  // Issue #182 — where the goods go and who carries them.
  post('/api/delivery/choices', { access: needAny('choose where goods go', 'sales.draft.write', 'challan.issue'), input: customerOnly },
    ({ app, actor, input }) => app.deliveryChoices(actor, String(input.customerId ?? ''))),
  post('/api/transporters', { access: PARTIES, input: fields({ name: text, transporterId: text, phone: text }) }, ({ app, actor, input }) => app.addTransporter(actor, input)),
  post('/api/shipping-addresses', { access: PARTIES, input: fields({ customerId: text, customer: text, label: text, line1: text, line2: text, city: text, pincode: text, stateCode: text, gstin: text }) },
    ({ app, actor, input }) => app.addShippingAddress(actor, input)),
  post('/api/customer-address', { access: PARTIES, input: customerOnly }, ({ app, actor, input }) => app.customerAddress(actor, String(input.customerId ?? ''))),
  post('/api/customer-address/correct', { access: PARTIES, input: fields({ customerId: text, customer: text, creditLimit: text }) },
    ({ app, actor, input }) => app.correctCustomerAddress(actor, input)),

  // Issue #37 — bringing a business in from Tally, BUSY or Vyapar, against its own fresh company.
  post('/api/migration/start', { access: MIGRATE, input: nothing }, ({ context }) => startMigration(context)),
  post('/api/migration/analyse', { access: MIGRATE, input: migration }, ({ context, input }) => analyseFile(context, input)),
  post('/api/migration/mapping', { access: MIGRATE, input: migration }, ({ context, input }) => remapColumns(context, input)),
  post('/api/migration/approve', { access: MIGRATE, input: migration }, ({ context, input }) => approveAndPreview(context, input)),
  post('/api/migration/preview', { access: MIGRATE, input: workspace }, ({ context, input }) => previewImport(context, input)),
  post('/api/migration/commit', { access: need('bring in books from another program', 'migration.commit'), input: migration }, ({ context, input }) => commitImport(context, input)),
  post('/api/migration/rollback', { access: need('undo books brought in', 'migration.rollback'), input: migration }, ({ context, input }) => rollbackImport(context, input)),
];
