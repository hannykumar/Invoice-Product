/**
 * Issue #42 [E42] — the catalogue, and the guard that keeps it honest.
 *
 * `definePlan` throws if a plan tries to limit something essential. That is the whole of "all plans
 * receive compliance safeguards": it is checked when the catalogue is built, so a plan that
 * withholds a warning cannot exist, let alone be sold. Prices here are placeholders — settling them
 * is explicitly not this issue's job.
 */
import { isoDate, rupees, type IsoDate, type Money } from '@invoice/kernel';
import {
  ESSENTIAL_CAPABILITIES,
  METERS,
  isEssential,
  type Capability,
  type EssentialCapability,
  type MeterId,
  type Plan,
  type PlanLimit,
} from './model.ts';

export interface PlanDraft {
  readonly id: string;
  readonly name: Plan['name'];
  readonly description: Plan['description'];
  readonly effectiveFrom?: IsoDate;
  readonly monthlyPrice: Money;
  readonly trialDays: number;
  readonly graceDays: number;
  readonly limits: readonly PlanLimit[];
  /** Anything the plan would withhold. Present only so the guard can refuse it. */
  readonly withholds?: readonly string[];
}

export class WithheldSafeguardError extends Error {
  readonly capability: string;
  constructor(capability: string) {
    super(`A plan may limit how much a business does, never whether it is warned: "${capability}" cannot be withheld.`);
    this.name = 'WithheldSafeguardError';
    this.capability = capability;
  }
}

export const definePlan = (draft: PlanDraft): Plan => {
  for (const capability of draft.withholds ?? []) {
    if (isEssential(capability)) throw new WithheldSafeguardError(capability);
  }
  for (const limit of draft.limits) {
    if (!METERS.includes(limit.meter)) throw new Error(`"${limit.meter}" is not something this product counts.`);
    if (limit.perMonth !== null && limit.perMonth < 0n) throw new Error('A limit cannot be negative.');
  }
  if (draft.trialDays < 0 || draft.graceDays < 0) throw new Error('Trial and grace periods cannot be negative.');
  return {
    id: draft.id,
    name: draft.name,
    description: draft.description,
    effectiveFrom: draft.effectiveFrom ?? isoDate('2026-04-01'),
    monthlyPrice: draft.monthlyPrice,
    trialDays: draft.trialDays,
    graceDays: draft.graceDays,
    limits: draft.limits,
  };
};

/**
 * The shipped plans.
 *
 * The free plan exists because a shopkeeper who cannot pay ₹500 a month still has to file returns
 * correctly. It is smaller, not less careful: the limits are on how much, never on what the
 * product will tell them.
 */
export const SHIPPED_PLANS: readonly Plan[] = [
  definePlan({
    id: 'free',
    name: { 'en-IN': 'Free', 'hi-IN': 'मुफ़्त' },
    description: {
      'en-IN': 'For a shop finding its feet. Every warning and every check, with smaller numbers.',
      'hi-IN': 'छोटी दुकान के लिए। हर चेतावनी और हर जाँच, बस गिनती कम।',
    },
    monthlyPrice: rupees(0),
    trialDays: 0,
    graceDays: 0,
    limits: [
      { meter: 'invoices', perMonth: 50n },
      { meter: 'companies', perMonth: 1n },
      { meter: 'storage_mb', perMonth: 200n },
      { meter: 'ai_requests', perMonth: 30n },
      { meter: 'external_api_calls', perMonth: 100n },
    ],
  }),
  definePlan({
    id: 'starter',
    name: { 'en-IN': 'Starter', 'hi-IN': 'शुरुआत' },
    description: {
      'en-IN': 'For a business billing every day, with room for a second branch.',
      'hi-IN': 'रोज़ बिल बनाने वाले बिज़नेस के लिए, दूसरी ब्रांच की गुंजाइश के साथ।',
    },
    monthlyPrice: rupees(499),
    trialDays: 14,
    graceDays: 15,
    limits: [
      { meter: 'invoices', perMonth: 500n },
      { meter: 'companies', perMonth: 2n },
      { meter: 'storage_mb', perMonth: 2_000n },
      { meter: 'ai_requests', perMonth: 300n },
      { meter: 'external_api_calls', perMonth: 2_000n },
    ],
  }),
  definePlan({
    id: 'growth',
    name: { 'en-IN': 'Growth', 'hi-IN': 'वृद्धि' },
    description: {
      'en-IN': 'For several businesses under one owner, with no monthly ceiling on billing.',
      'hi-IN': 'एक ही मालिक के कई बिज़नेस के लिए, बिलिंग पर कोई महीने की सीमा नहीं।',
    },
    monthlyPrice: rupees(1_499),
    trialDays: 14,
    graceDays: 30,
    limits: [
      { meter: 'invoices', perMonth: null },
      { meter: 'companies', perMonth: 10n },
      { meter: 'storage_mb', perMonth: 20_000n },
      { meter: 'ai_requests', perMonth: 3_000n },
      { meter: 'external_api_calls', perMonth: null },
    ],
  }),
];

export const planById = (plans: readonly Plan[], id: string): Plan | null =>
  plans.find((plan) => plan.id === id) ?? null;

export const limitFor = (plan: Plan, meter: MeterId): bigint | null =>
  plan.limits.find((limit) => limit.meter === meter)?.perMonth ?? null;

/**
 * What the product can be asked to do, and what each costs.
 *
 * Everything essential is listed as a READ with no meter, so no plan and no state can stop it. That
 * is belt and braces with `definePlan`: one guards the catalogue, this guards the lookup.
 */
const ESSENTIAL_LABELS_HI: Readonly<Record<EssentialCapability, string>> = {
  'gst.compliance_warning': 'GST नियम चेतावनी',
  'einvoice.applicability_warning': 'ई-इनवॉइस लागू होने की चेतावनी',
  'supplier.risk_warning': 'सप्लायर जोखिम चेतावनी',
  'stock.negative_warning': 'स्टॉक माइनस जाने की चेतावनी',
  'ledger.balance_check': 'बही बराबरी जाँच',
  'credit.overdue_warning': 'उधार में देर की चेतावनी',
  'audit.read': 'ऑडिट देखना',
  'data.export': 'अपना डेटा निकालना',
  'reports.view.dues': 'बाक़ी राशि की रिपोर्ट देखना',
};

export const SHIPPED_CAPABILITIES: readonly Capability[] = [
  { name: 'sales.issue_invoice', kind: 'WRITE', meter: 'invoices', label: { 'en-IN': 'issue a bill', 'hi-IN': 'बिल बनाना' } },
  { name: 'purchase.record_bill', kind: 'WRITE', meter: null, label: { 'en-IN': 'record a purchase bill', 'hi-IN': 'ख़रीद का बिल लिखना' } },
  { name: 'payments.record', kind: 'WRITE', meter: null, label: { 'en-IN': 'record a payment', 'hi-IN': 'पैसा आना लिखना' } },
  { name: 'collections.send_reminder', kind: 'WRITE', meter: 'external_api_calls', label: { 'en-IN': 'send a payment reminder', 'hi-IN': 'रिमाइंडर भेजना' } },
  { name: 'assistant.ask', kind: 'READ', meter: 'ai_requests', label: { 'en-IN': 'ask the assistant a question', 'hi-IN': 'असिस्टेंट से सवाल पूछना' } },
  { name: 'agent.execute', kind: 'WRITE', meter: 'ai_requests', label: { 'en-IN': 'have the assistant do something', 'hi-IN': 'असिस्टेंट से काम करवाना' } },
  { name: 'einvoice.generate', kind: 'WRITE', meter: 'external_api_calls', label: { 'en-IN': 'register an e-invoice', 'hi-IN': 'ई-इनवॉइस रजिस्टर करना' } },
  { name: 'company.create', kind: 'WRITE', meter: 'companies', label: { 'en-IN': 'set up another business', 'hi-IN': 'एक और बिज़नेस बनाना' } },
  { name: 'documents.store', kind: 'WRITE', meter: 'storage_mb', label: { 'en-IN': 'keep a document', 'hi-IN': 'दस्तावेज़ रखना' } },
  { name: 'reports.view.financial', kind: 'READ', meter: null, label: { 'en-IN': 'read your reports', 'hi-IN': 'अपनी रिपोर्ट देखना' } },
  ...ESSENTIAL_CAPABILITIES.map((name): Capability => ({
    name,
    kind: 'READ',
    meter: null,
    label: { 'en-IN': name.replace(/[._]/g, ' '), 'hi-IN': ESSENTIAL_LABELS_HI[name] },
  })),
];

export const capabilityByName = (capabilities: readonly Capability[], name: string): Capability | null =>
  capabilities.find((capability) => capability.name === name) ?? null;
