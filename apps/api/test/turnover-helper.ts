/**
 * Issue #236 — the business's turnover band, saved the way the Business details screen saves it.
 *
 * The E-invoice screen no longer takes a turnover figure; it reads this saved answer. Tests that
 * need a bill to be one that must be e-invoiced say so here first.
 */
import { handleApi } from '../src/server.ts';

export type TurnoverBandAnswer = 'UP_TO_5_CRORE' | 'UP_TO_5_CRORE_EARLIER_ABOVE' | '5_TO_10_CRORE' | '10_CRORE_AND_ABOVE' | 'UNKNOWN';

export const saveTurnoverBand = async (sessionId: string, band: TurnoverBandAnswer): Promise<Record<string, any>> => {
  const authorization = `Bearer ${sessionId}`;
  const current = JSON.parse(String((await handleApi('GET', '/api/business-details', {}, authorization)).body)) as Record<string, any>;
  const saved = await handleApi('POST', '/api/business-details', { ...(current.details ?? current.prefill), turnoverBand: band }, authorization);
  if (saved.status !== 200) throw new Error(`Saving the turnover band failed: ${String(saved.body)}`);
  return JSON.parse(String(saved.body)) as Record<string, any>;
};
