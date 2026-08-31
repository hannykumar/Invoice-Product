/**
 * Issue #52 [X04] — the routes, and what is honestly known about each.
 *
 * Almost everything here is `UNKNOWN`, and that is the deliverable rather than a gap. The facts
 * that decide this — coverage, price, whether the data licence permits bookkeeping at all — are
 * things only a provider can tell us, in writing, and nobody has asked them yet. Writing them in
 * as plausible numbers would produce a confident recommendation resting on nothing.
 *
 * The one route that *is* fully known is the statement upload we already built, because we wrote
 * it and its tests. That is why the comparison has an answer today.
 *
 * **No commercial term in this file was supplied by a provider.** When a quotation arrives, replace
 * the `unknown()` with `known(..., 'CONFIRMED', <who said it and where>, <date>)`.
 */
import { known, unknown, type Candidate } from './model.ts';

const BUILT = 'packages/bank-feeds and packages/bank-import in this repository';
const TODAY = '2026-08-31';

export const CANDIDATES: readonly Candidate[] = [
  {
    id: 'statement_upload',
    name: 'Statement upload (what we already do)',
    accessModel: 'STATEMENT_UPLOAD',
    summary: {
      'en-IN': 'The shopkeeper downloads a statement from their own bank and gives it to us. Built, tested and running today.',
      'hi-IN': 'Dukaandar apne bank se statement download kar ke hume deta hai. Yeh ban chuka hai, jaancha ja chuka hai aur aaj chal raha hai.',
    },
    assessments: {
      // Scored from our own code and tests, which is the only reason these are not UNKNOWN.
      consent_and_revocation: known(5, 'CONFIRMED', BUILT, TODAY, 'The customer hands over one file. There is nothing standing to revoke.'),
      accounting_use_permitted: known(5, 'CONFIRMED', BUILT, TODAY, 'It is the customer’s own statement given to us directly; no third party licences it.'),
      bank_coverage: known(5, 'CONFIRMED', BUILT, TODAY, 'Any bank that can produce a statement, which is all of them.'),
      cost: known(5, 'CONFIRMED', BUILT, TODAY, 'Nothing per business, nothing per fetch.'),
      history_depth: known(4, 'CONFIRMED', BUILT, TODAY, 'As far back as the customer can download, which is usually a year or more.'),
      data_freshness: known(1, 'CONFIRMED', BUILT, TODAY, 'Whenever somebody remembers to upload. This is the whole weakness, and the only thing a live feed buys.'),
      sandbox_availability: known(5, 'CONFIRMED', BUILT, TODAY, 'It is our own code and it has tests.'),
      startup_eligibility: known(5, 'CONFIRMED', BUILT, TODAY, 'No eligibility to meet.'),
    },
    cost: known(
      { monthlyPlatformFeePaise: 0n, perConnectionPaise: 0n, perSyncPaise: 0n, oneOffPaise: 0n },
      'CONFIRMED', BUILT, TODAY, 'Already built and paid for.',
    ),
    openQuestions: [],
  },
  {
    id: 'account_aggregator',
    name: 'Account Aggregator framework, through a licensed NBFC-AA',
    accessModel: 'ACCOUNT_AGGREGATOR',
    summary: {
      'en-IN': 'India’s consent framework: an RBI-licensed aggregator sits between the bank and us, the customer grants a consent naming purpose, duration and frequency, and can take it back. We would be a user of the information, never the aggregator.',
      'hi-IN': 'Bharat ka anumati dhaancha: RBI se licence-praapt aggregator bank aur hamare beech hota hai; grahak anumati deta hai jisme uddeshya, avadhi aur baarambaarta likhi hoti hai, aur wapas bhi le sakta hai. Hum jaankari ka upyog karne wale honge, aggregator kabhi nahin.',
    },
    assessments: {
      // Structurally the best fit for the consent criterion, but scoring it before a provider has
      // confirmed the terms would be exactly the guess this module refuses to make.
      consent_and_revocation: unknown('Structurally the strongest — consent is explicit, purpose-bound and revocable by design. Not scored until an aggregator confirms what their consent screen and revocation actually do.'),
      accounting_use_permitted: unknown('The decisive question: does the purpose code the aggregator supports cover bookkeeping and reconciliation, or only lending decisions?'),
      bank_coverage: unknown('Which of our customers’ banks are live as information providers, today, not on a roadmap.'),
      cost: unknown('No quotation obtained.'),
      history_depth: unknown('How far back a single consent can fetch.'),
      data_freshness: unknown('How soon after a transaction it can be fetched, and how often a consent permits fetching.'),
      sandbox_availability: unknown('Whether a sandbox is available before a signed agreement.'),
      startup_eligibility: unknown('Whether a newly incorporated company with no volume history is eligible at all.'),
    },
    cost: unknown('No quotation obtained.'),
    openQuestions: [
      'Ask each candidate aggregator: does your supported purpose cover accounting and reconciliation for an MSME’s own accounts, in writing?',
      'Ask each candidate aggregator: which banks are live today for current and cash-credit accounts?',
      'Ask each candidate aggregator: sandbox before contract, or only after?',
      'Ask each candidate aggregator: minimum commitment, and eligibility for a company incorporated this year?',
      'Ask counsel: what does our being a financial information user require of us, and what must the customer be told?',
    ],
  },
  {
    id: 'direct_bank_api',
    name: 'Direct corporate bank APIs',
    accessModel: 'DIRECT_BANK_API',
    summary: {
      'en-IN': 'Each large bank runs its own developer programme for corporate customers. One integration per bank, and the customer must bank with one we have integrated.',
      'hi-IN': 'Har bade bank ka apna developer programme hai. Har bank ke liye alag jodna padta hai, aur grahak ka khaata usi bank mein hona chahiye jise humne joda ho.',
    },
    assessments: {
      consent_and_revocation: unknown('Varies by bank; each has its own authorisation and revocation flow.'),
      accounting_use_permitted: unknown('Each bank’s API terms must be read.'),
      bank_coverage: unknown('One bank per integration. The real question is how many integrations before it is useful to a shopkeeper.'),
      cost: unknown('No quotation obtained.'),
      history_depth: unknown(''),
      data_freshness: unknown(''),
      sandbox_availability: unknown('Several banks publish sandboxes; whether they are reachable without a corporate relationship is the question.'),
      startup_eligibility: unknown('Most require an existing corporate banking relationship, which needs #49 first.'),
    },
    cost: unknown('No quotation obtained.'),
    openQuestions: [
      'Ask each bank: is the transaction API available to a software provider acting for its customers, or only to the account holder?',
      'Ask each bank: sandbox access without an existing corporate relationship?',
      'Count: how many bank integrations before a majority of our customers are covered? If the answer is more than three, this route is a programme rather than an integration.',
    ],
  },
  {
    id: 'partner_aggregator',
    name: 'A technology partner reselling aggregated feeds',
    accessModel: 'PARTNER_AGGREGATOR_API',
    summary: {
      'en-IN': 'One integration, several banks behind it, and somebody else maintaining them. The trade is a dependency and a per-business price.',
      'hi-IN': 'Ek hi jod, peeche kai bank, aur unhe sambhalne wala koi aur. Badle mein ek nirbharta aur har business par keemat.',
    },
    assessments: {
      consent_and_revocation: unknown('Whose consent screen does the shopkeeper see, and what does revocation reach?'),
      accounting_use_permitted: unknown('Their upstream licence has to permit what they are selling us.'),
      bank_coverage: unknown(''),
      cost: unknown('No quotation obtained.'),
      history_depth: unknown(''),
      data_freshness: unknown(''),
      sandbox_availability: unknown(''),
      startup_eligibility: unknown(''),
    },
    cost: unknown('No quotation obtained.'),
    openQuestions: [
      'Ask each partner: how do you obtain the data upstream — Account Aggregator, direct bank agreements, or something else?',
      'Ask each partner: if a bank withdraws, what happens to our customers, and what notice do we get?',
      'Ask each partner: what happens to our customers’ data when we stop paying you?',
    ],
  },
  {
    id: 'credential_sharing',
    name: 'Asking the customer for their netbanking login',
    accessModel: 'CREDENTIAL_SHARING',
    summary: {
      'en-IN': 'Some tools ask the shopkeeper for their banking password and sign in as them. It is listed here so the answer is on the record.',
      'hi-IN': 'Kuch tools dukaandar se banking password maang kar unke naam se login karte hain. Ise yahan isliye likha hai taaki jawab record par rahe.',
    },
    assessments: {},
    cost: unknown('Not applicable; this route is not available to us at any price.'),
    openQuestions: [],
  },
];
