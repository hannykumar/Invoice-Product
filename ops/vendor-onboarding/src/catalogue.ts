/**
 * Issue #49 [X01] — what each kind of provider actually asks for.
 *
 * These lists are the point of the issue: "a provider receives company registration, PAN/GST
 * details when applicable, authorised contact, domain and product description in one reviewed
 * package". Written down per provider kind, the same document is assembled once and reused, and
 * the readiness check can say exactly which integration is waiting on which piece of paper.
 *
 * They are what a provider of that kind typically requires for onboarding, not a legal
 * requirement of ours; each contract governs, and the register is corrected when one differs.
 */
import type { Bilingual, DocumentKind, EntityType, VendorKind } from './model.ts';

export const DOCUMENT_LABELS: Readonly<Record<DocumentKind, Bilingual>> = {
  CERTIFICATE_OF_INCORPORATION: { 'en-IN': 'Certificate of incorporation', 'hi-IN': 'Company banne ka pramaan patra' },
  MOA_AOA: { 'en-IN': 'Memorandum and articles of association', 'hi-IN': 'MOA aur AOA' },
  COMPANY_PAN: { 'en-IN': "The company's PAN", 'hi-IN': 'Company ka PAN' },
  COMPANY_TAN: { 'en-IN': "The company's TAN, for deducting tax at source", 'hi-IN': 'Company ka TAN (TDS ke liye)' },
  GST_REGISTRATION: { 'en-IN': 'GST registration certificate', 'hi-IN': 'GST registration ka pramaan patra' },
  BANK_ACCOUNT_PROOF: { 'en-IN': 'Current account proof — a cancelled cheque or bank letter', 'hi-IN': 'Current account ka proof — cancelled cheque ya bank ka patra' },
  BOARD_RESOLUTION: { 'en-IN': 'Board resolution naming the authorised signatory', 'hi-IN': 'Board resolution jisme adhikrit hastakshar karta ka naam ho' },
  AUTHORISED_SIGNATORY_ID: { 'en-IN': "Authorised signatory's identity and address proof", 'hi-IN': 'Adhikrit vyakti ka pehchaan aur pata praman' },
  REGISTERED_ADDRESS_PROOF: { 'en-IN': 'Registered office address proof', 'hi-IN': 'Registered office ke pate ka praman' },
  DOMAIN_OWNERSHIP: { 'en-IN': 'Proof that the company owns its domain', 'hi-IN': 'Domain company ke naam par hone ka praman' },
  OFFICIAL_EMAIL: { 'en-IN': 'Working email addresses on the company domain', 'hi-IN': 'Company ke domain par chalu email' },
  DPIIT_RECOGNITION: { 'en-IN': 'DPIIT startup recognition, where it earns a concession', 'hi-IN': 'DPIIT startup manyata, jahan iska laabh ho' },
  SECURITY_QUESTIONNAIRE: { 'en-IN': 'A completed security questionnaire and our data-protection posture', 'hi-IN': 'Bhari hui security prashnavali aur data suraksha ki sthiti' },
  DATA_PROCESSING_AGREEMENT: { 'en-IN': 'A data-processing agreement we can sign', 'hi-IN': 'Data processing samjhauta jise hum sign kar sakein' },
  PROFESSIONAL_INDEMNITY_INSURANCE: { 'en-IN': 'Professional indemnity insurance, where a contract requires it', 'hi-IN': 'Professional indemnity bima, jahan anubandh mein zaroori ho' },
};

export const VENDOR_LABELS: Readonly<Record<VendorKind, Bilingual>> = {
  GSP_IRP: { 'en-IN': 'GST Suvidha Provider / Invoice Registration Portal', 'hi-IN': 'GST Suvidha Provider / IRP' },
  BANK_FEED: { 'en-IN': 'Bank statement and account feed partner', 'hi-IN': 'Bank statement aur feed saathi' },
  WHATSAPP_BSP: { 'en-IN': 'WhatsApp business solution provider', 'hi-IN': 'WhatsApp business solution provider' },
  VEHICLE_DATA: { 'en-IN': 'Authorised vehicle-record provider', 'hi-IN': 'Adhikrit vaahan record provider' },
  PAYMENTS: { 'en-IN': 'Payment gateway for our own subscriptions', 'hi-IN': 'Hamare apne subscription ke liye payment gateway' },
};

/** The GitHub issues each provider relationship unblocks. */
export const VENDOR_BLOCKS: Readonly<Record<VendorKind, readonly string[]>> = {
  GSP_IRP: ['#50', '#51', '#33', '#26', '#30'],
  BANK_FEED: ['#52', '#24', '#22'],
  WHATSAPP_BSP: ['#21', '#14', '#23'],
  VEHICLE_DATA: ['#53', '#29'],
  PAYMENTS: ['#42'],
};

/**
 * What each kind of provider asks for.
 *
 * The overlap is the useful part: seven of these are the same for everybody, which is why the pack
 * is assembled once. The differences are where the surprises live — a GSP wants the GST
 * registration itself, a bank-feed partner wants the security posture and a signed DPA before it
 * will talk about data.
 */
export const VENDOR_REQUIREMENTS: Readonly<Record<VendorKind, readonly DocumentKind[]>> = {
  GSP_IRP: [
    'CERTIFICATE_OF_INCORPORATION', 'MOA_AOA', 'COMPANY_PAN', 'GST_REGISTRATION',
    'BOARD_RESOLUTION', 'AUTHORISED_SIGNATORY_ID', 'REGISTERED_ADDRESS_PROOF',
    'DOMAIN_OWNERSHIP', 'OFFICIAL_EMAIL', 'SECURITY_QUESTIONNAIRE',
  ],
  BANK_FEED: [
    'CERTIFICATE_OF_INCORPORATION', 'MOA_AOA', 'COMPANY_PAN', 'GST_REGISTRATION',
    'BANK_ACCOUNT_PROOF', 'BOARD_RESOLUTION', 'AUTHORISED_SIGNATORY_ID',
    'DOMAIN_OWNERSHIP', 'OFFICIAL_EMAIL', 'SECURITY_QUESTIONNAIRE', 'DATA_PROCESSING_AGREEMENT',
  ],
  WHATSAPP_BSP: [
    'CERTIFICATE_OF_INCORPORATION', 'COMPANY_PAN', 'GST_REGISTRATION',
    'DOMAIN_OWNERSHIP', 'OFFICIAL_EMAIL', 'AUTHORISED_SIGNATORY_ID',
  ],
  VEHICLE_DATA: [
    'CERTIFICATE_OF_INCORPORATION', 'COMPANY_PAN', 'BOARD_RESOLUTION',
    'AUTHORISED_SIGNATORY_ID', 'DOMAIN_OWNERSHIP', 'OFFICIAL_EMAIL',
    'SECURITY_QUESTIONNAIRE', 'DATA_PROCESSING_AGREEMENT',
  ],
  PAYMENTS: [
    'CERTIFICATE_OF_INCORPORATION', 'COMPANY_PAN', 'GST_REGISTRATION',
    'BANK_ACCOUNT_PROOF', 'AUTHORISED_SIGNATORY_ID', 'DOMAIN_OWNERSHIP', 'OFFICIAL_EMAIL',
  ],
};

/** Every document any provider asks for, so the pack is assembled once rather than five times. */
export const FULL_DOCUMENT_PACK: readonly DocumentKind[] = [
  ...new Set(Object.values(VENDOR_REQUIREMENTS).flat()),
];

export interface EntityOption {
  readonly type: EntityType;
  readonly name: string;
  readonly suitsUs: Bilingual;
  readonly against: Bilingual;
}

/**
 * The entity types, described plainly.
 *
 * This is a decision aid, not advice: the issue's own first line of required work is "select entity
 * type **with professional advice**", and a chartered accountant or company secretary should settle
 * it. What is written here is what the choice turns on, so that conversation is a short one.
 */
export const ENTITY_OPTIONS: readonly EntityOption[] = [
  {
    type: 'PRIVATE_LIMITED',
    name: 'Private limited company',
    suitsUs: {
      'en-IN': 'What GSPs, banks and payment providers expect to contract with. Limited liability, a board resolution mechanism they already understand, and the only form that takes outside investment without restructuring.',
      'hi-IN': 'GSP, bank aur payment provider isi ke saath anubandh karna chahte hain. Seemit zimmedari, board resolution ka tarika jise woh pehle se samajhte hain, aur bahar se nivesh lene ke liye ekmatra saral roop.',
    },
    against: {
      'en-IN': 'The most compliance: audits, annual filings, board minutes and a company secretary’s time.',
      'hi-IN': 'Sabse zyada anupalan: audit, saalana filing, board ki karyavahi aur company secretary ka samay.',
    },
  },
  {
    type: 'LLP',
    name: 'Limited liability partnership',
    suitsUs: {
      'en-IN': 'Lighter annual compliance than a company, with limited liability. Fine for a services business.',
      'hi-IN': 'Company se halka saalana anupalan, aur seemit zimmedari. Seva vale business ke liye theek.',
    },
    against: {
      'en-IN': 'Several providers and most investors will not contract with an LLP, and converting later is slow. For a product that must sign with a GSP and a bank, this is the risk that matters.',
      'hi-IN': 'Kai provider aur zyadatar nivesh karne wale LLP ke saath anubandh nahin karte, aur baad mein badalna dheema hai. Jis product ko GSP aur bank ke saath sign karna hai, uske liye yahi asli khatra hai.',
    },
  },
  {
    type: 'OPC',
    name: 'One person company',
    suitsUs: {
      'en-IN': 'A single founder gets limited liability without a second shareholder.',
      'hi-IN': 'Akele sansthapak ko doosre shareholder ke bina seemit zimmedari milti hai.',
    },
    against: {
      'en-IN': 'Turnover and capital ceilings force a conversion as the business grows, and some providers treat it as a proprietorship.',
      'hi-IN': 'Turnover aur poonji ki seema badhne par badalna padta hai, aur kuch provider ise proprietorship jaisa maante hain.',
    },
  },
  {
    type: 'PARTNERSHIP',
    name: 'Registered partnership',
    suitsUs: { 'en-IN': 'Quick and cheap to form.', 'hi-IN': 'Jaldi aur sasta ban jata hai.' },
    against: {
      'en-IN': 'Unlimited personal liability. For software that touches other people’s tax filings and bank data, that is the wrong risk to carry personally.',
      'hi-IN': 'Aseemit vyaktigat zimmedari. Jo software doosron ki tax filing aur bank data ko chhuta hai, uske liye yeh khatra khud uthana theek nahin.',
    },
  },
  {
    type: 'PROPRIETORSHIP',
    name: 'Sole proprietorship',
    suitsUs: { 'en-IN': 'Nothing to form; the founder is the business.', 'hi-IN': 'Kuch banana nahin padta; sansthapak hi business hai.' },
    against: {
      'en-IN': 'Unlimited liability, and every vendor account is by definition a founder’s personal account — which the acceptance criterion of this issue is written to prevent.',
      'hi-IN': 'Aseemit zimmedari, aur har vendor account apne aap sansthapak ka niji account hota hai — jise rokne ke liye hi is issue ki shart likhi gayi hai.',
    },
  },
];
