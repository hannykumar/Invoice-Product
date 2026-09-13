/**
 * Issue #51 [X03] — the go-live conditions, written once.
 *
 * Each line is one of the issue's own required-work items or acceptance criteria, turned into
 * something with an owner and a consequence. The order is the order they have to happen in: a
 * security review of an integration nobody has chosen is a waste of a week, and a pilot customer
 * cannot consent to an agreement that has not been signed.
 */
import { bilingual, type GoLiveStep } from './model.ts';

export const GO_LIVE_STEPS: readonly GoLiveStep[] = Object.freeze([
  {
    id: 'COMPANY_AND_DOCUMENT_PACK',
    label: bilingual('A company exists, with the document pack a GSP asks for', 'Company bani hai, aur GSP jo kaagaz maangta hai woh taiyar hain'),
    why: 'A GSP contracts with a legal entity and asks for the incorporation certificate, PAN, GST registration, a board resolution and the signatory’s identity. Issue #49 holds that register; nothing here can be signed before it is complete.',
    answerable: 'PERSON',
    blocks: ['#51'],
  },
  {
    id: 'PROVIDER_CHOSEN',
    label: bilingual('A provider is chosen from written proposals', 'Likhit proposals dekhkar provider chuna gaya hai'),
    why: 'Issue #50 refuses a recommendation until two written quotations and the essential facts are in hand. Signing with a provider nobody compared is how a product ends up unable to leave.',
    answerable: 'PERSON',
    blocks: ['#51'],
  },
  {
    id: 'SECURITY_REVIEW',
    label: bilingual('The integration has had a written security review', 'Integration ki likhit security jaanch ho chuki hai'),
    why: 'What leaves this product, where credentials live, who may authorise and revoke, and what the logs keep. The answers already exist — #33 stores a vault reference and redacts by field name — but a review is somebody other than the author checking that, on a date, in writing.',
    answerable: 'PERSON',
    blocks: ['#51'],
  },
  {
    id: 'LEGAL_REVIEW',
    label: bilingual('The contract and data terms have had a legal review', 'Contract aur data ki shartein vakil ne dekh li hain'),
    why: 'A GSP processes a customer’s tax data on our instruction. Who is controller and who is processor, which sub-processors are allowed, where the data sits, what happens on termination, and who is liable when a filing is late are contract terms, not engineering choices.',
    answerable: 'PERSON',
    blocks: ['#51'],
  },
  {
    id: 'AGREEMENT_AND_SLA',
    label: bilingual('A commercial agreement and an SLA are signed', 'Commercial agreement aur SLA sign ho chuke hain'),
    why: 'An SLA with stated uptime, support hours, incident response times and published rate limits is what makes an outage a breach rather than a surprise. A shopkeeper who cannot generate an e-way bill at eight in the evening needs somebody to be answerable.',
    answerable: 'PERSON',
    blocks: ['#51'],
  },
  {
    id: 'PRODUCTION_NETWORK_AND_DOMAIN',
    label: bilingual('Production addresses, domain and email are in the company’s name', 'Production ka address, domain aur email company ke naam par hain'),
    why: 'NIC ties an API session to the calling address, so production needs fixed egress addresses registered with the provider. The domain and the official email must belong to the company rather than to a founder, or an account is lost when a person leaves.',
    answerable: 'PERSON',
    blocks: ['#51'],
  },
  {
    id: 'CREDENTIAL_CUSTODY_AND_ROTATION',
    label: bilingual('Production credentials are held in the vault, with two custodians and a rotation drill', 'Production ke credentials vault mein hain, do custodian aur rotation ka abhyas ke saath'),
    why: 'A credential one person can reach is a credential that leaves with them. The software side — rotation without downtime, revocation stopping the next call — is proven by the drill in this module; the custody is a person’s job.',
    answerable: 'PERSON',
    blocks: ['#51'],
  },
  {
    id: 'CUSTOMER_AUTHORISATION_PROCEDURE',
    label: bilingual('A customer can authorise its own GST number, and take that back', 'Customer apna GST number khud jod sakta hai, aur wapas bhi le sakta hai'),
    why: 'Consent is per GST number, recorded with the wording the person was shown, and revocable. Issue #33 implements the dance — API user, one-time password, consent, revocation — and the drill in this module runs it end to end.',
    answerable: 'REPOSITORY',
    blocks: ['#51'],
  },
  {
    id: 'FALLBACK_WORKFLOW',
    label: bilingual('The manual fallback works with the provider disconnected', 'Provider band ho to bhi manual tareeka chalta hai'),
    why: 'The issue requires the fallback to remain available. A business whose GSP is down, or whose authorisation has just been revoked, must still be able to produce the government’s own JSON and upload it by hand. The drill proves it with the connection revoked.',
    answerable: 'REPOSITORY',
    blocks: ['#51'],
  },
  {
    id: 'PILOT_CUSTOMER_CONSENT',
    label: bilingual('A named pilot customer has agreed, in writing, to go first', 'Ek naam wala pilot customer likhit mein pehle aane ko raazi hai'),
    why: 'The first production call is made on somebody’s real registration and produces a real IRN. That business has to know it is the pilot, what is being sent, and how to stop.',
    answerable: 'PERSON',
    blocks: ['#51'],
  },
  {
    id: 'INCIDENT_AND_SUPPORT',
    label: bilingual('There is an incident and support process on both sides', 'Dono taraf incident aur support ka tareeka tay hai'),
    why: 'Who is called when the portal rejects everything, in what order, and how a customer is told. The provider’s escalation path and ours have to exist before the night they are needed.',
    answerable: 'PERSON',
    blocks: ['#51'],
  },
  {
    id: 'EXIT_AND_PORTABILITY',
    label: bilingual('Leaving the provider is a documented procedure', 'Provider chhodne ka tareeka likha hua hai'),
    why: 'What happens to authorisations, credentials and the record of what was filed when we stop paying, and how a customer moves without re-registering every GST number by hand. Agreed before signing, or it is agreed from a position of no leverage.',
    answerable: 'PERSON',
    blocks: ['#51'],
  },
  {
    id: 'CONTROLLED_PRODUCTION_SMOKE_TEST',
    label: bilingual('One controlled operation has been run on the pilot’s registration', 'Pilot ke registration par ek controlled kaam chalaya gaya hai'),
    why: 'The issue’s own test: a real IRN or e-way bill, generated and then cancelled, with the pilot watching. It can only happen after everything above.',
    answerable: 'PERSON',
    blocks: ['#51'],
  },
]);

export const stepById = (id: string): GoLiveStep | undefined => GO_LIVE_STEPS.find((step) => step.id === id);
