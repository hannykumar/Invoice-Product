/**
 * Issue #297 — the compliance calendar (#32) on the screen: the deadlines ahead, and marking one
 * done with what proves it.
 */
import { fields, get, need, nothing, post, text, type Route } from './route.ts';

const COMPLETE = need('mark a deadline done', 'compliance.calendar.complete');

const completion = fields({ key: text, reference: text, filedOn: text, note: text, idempotencyKey: text });

export const COMPLIANCE_ROUTES: readonly Route[] = [
  get('/api/compliance/calendar', { access: need('see the deadlines calendar', 'compliance.calendar.view'), input: nothing }, ({ app, actor }) => app.complianceCalendar(actor)),
  post('/api/compliance/calendar/complete', { access: COMPLETE, input: completion }, ({ app, actor, input }) => app.completeObligation(actor, input)),
];
