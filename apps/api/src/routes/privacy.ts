/**
 * Issue #352 — the privacy register and the backups, reachable in the running app.
 *
 * The account's subject is the account itself: `subjectId` defaults to the signed-in company, so
 * "export my data" and "delete my data" need no id at all. An export always runs to the end and
 * answers the data; a deletion answers what was scrubbed and, plainly, what was kept and why —
 * posted bills and the audit trail are never touched (decision 0010). Both go through the privacy
 * module's request register, so a repeated `requestId` replays the same request and a legal hold
 * or an unexpired retention stops a deletion with its reasons.
 */
import { RETAINED_PLAINLY } from '../privacy-application.ts';
import { anything, fields, get, list, need, nothing, post, text, type Route } from './route.ts';

const MANAGE = need('manage the privacy register', 'privacy.manage');
const EXPORT = need('export the account data', 'privacy.export');
const DELETE_ = need('delete the account data', 'privacy.delete');
const BACKUP = need('take a backup', 'backup.manage');
const DRILLS = need('see restore checks', 'backup.restore');

const purposesOf = (input: { readonly purposes?: unknown }): string[] =>
  Array.isArray(input.purposes) ? input.purposes.map((purpose) => String(purpose)) : [];

export const PRIVACY_ROUTES: readonly Route[] = [
  post('/api/privacy/notice', { access: MANAGE, input: fields({ version: text, effectiveAt: text, purposes: anything }) }, async ({ runtime, context, input }) => ({
    notice: await runtime.privacy.publishNotice(context, {
      version: String(input.version ?? ''),
      effectiveAt: String(input.effectiveAt ?? ''),
      purposes: purposesOf(input),
    }),
  })),

  post('/api/privacy/consents', { access: MANAGE, input: fields({ subjectId: text, noticeVersion: text, decision: text, purposes: anything }) }, async ({ runtime, context, input }) => ({
    consent: await runtime.privacy.recordConsent(context,
      String(input.subjectId ?? context.companyId),
      String(input.noticeVersion ?? ''),
      String(input.decision ?? '') as 'granted' | 'withdrawn',
      purposesOf(input)),
  })),

  list('/api/privacy/consents', { access: MANAGE, key: 'consents' }, async ({ runtime, context, input }) => ({
    consents: await runtime.privacy.consents(context, context.companyId,
      { ...(input.limit === undefined ? {} : { limit: input.limit }), ...(input.cursor === undefined ? {} : { after: input.cursor }) }),
  })),

  post('/api/privacy/legal-holds', { access: MANAGE, input: fields({ subjectId: text, reason: text }) }, async ({ runtime, context, input }) => ({
    hold: await runtime.privacy.placeLegalHold(context, String(input.subjectId ?? context.companyId), String(input.reason ?? '')),
  })),

  post('/api/privacy/legal-holds/:id/release', { access: MANAGE, input: fields({ reason: text }) }, async ({ runtime, context, params, input }) => ({
    hold: await runtime.privacy.releaseLegalHold(context, String(params.id), String(input.reason ?? '')),
  })),

  post('/api/privacy/retention', { access: MANAGE, input: fields({ subjectId: text, retainUntil: text }) }, async ({ runtime, context, input }) => {
    await runtime.privacy.setRetention(context, String(input.subjectId ?? context.companyId), String(input.retainUntil ?? ''));
    return { retained: true };
  }),

  get('/api/privacy/requests/:id', { access: EXPORT, input: nothing }, async ({ runtime, context, params }) => ({
    request: await runtime.privacy.get(context, String(params.id)),
  })),

  post('/api/privacy/export', { access: EXPORT, input: fields({ requestId: text }) }, async ({ runtime, context, input }) => {
    const request = await runtime.privacy.request(context, context.companyId, 'export', String(input.requestId ?? ''));
    if (request.status !== 'requested') return { request };
    const exported = await runtime.privacy.executeExport(context, request.id);
    return { request, export: exported };
  }),

  post('/api/privacy/deletion', { access: DELETE_, input: fields({ requestId: text }) }, async ({ runtime, context, input }) => {
    const request = await runtime.privacy.request(context, context.companyId, 'deletion', String(input.requestId ?? ''));
    if (request.status !== 'requested') return { request };
    const outcome = await runtime.privacy.executeDeletion(context, request.id);
    // Plain words, beside the numbers: what stays and the law that keeps it.
    return { request: outcome.request, deletedRecords: outcome.result?.deletedRecords ?? 0, retainedRecords: outcome.result?.retainedRecords ?? 0, kept: RETAINED_PLAINLY };
  }),

  post('/api/backups', { access: BACKUP, input: fields({ requestId: text, retentionDays: anything }) }, async ({ runtime, context, input }) => ({
    backup: await runtime.recovery.create(context, runtime.backupSource, 'karobar-1',
      Number.isInteger(Number(input.retentionDays)) && Number(input.retentionDays) > 0 ? Number(input.retentionDays) : 30,
      String(input.requestId ?? '')),
  })),

  list('/api/backups/drills', { access: DRILLS, key: 'drills' }, async ({ runtime, context, input }) => ({
    drills: await runtime.recovery.drills(context,
      { ...(input.limit === undefined ? {} : { limit: input.limit }), ...(input.cursor === undefined ? {} : { after: input.cursor }) }),
  })),
];
