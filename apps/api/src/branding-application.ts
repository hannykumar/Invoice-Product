/**
 * Issues #146 and #147 wired into the running app — the screen where a business makes its bill
 * look like its own.
 *
 * It holds three things per company: the logo, the mark of the trade, and the colour. Every one of
 * them starts empty and stays empty until somebody sets it, and every one can be taken off again.
 *
 * The preview is a **real bill**. It goes through the same renderer, the same template snapshot and
 * the same document shape a finalised sale is printed with, on sample figures that are labelled as
 * sample. Showing a drawing of a bill here would let the screen and the printer disagree, which is
 * the one thing a business cannot be asked to check for itself.
 */
import { isoDate, rupees, zero, type CompanyId } from '@invoice/kernel';
import {
  EMPTY_BRANDING,
  brandedSnapshot,
  renderInvoice,
  templateById,
  tradeMarkFromLibrary,
  validateAccent,
  validateLogo,
  type CompanyBranding,
  type InvoiceDocument,
  type Locale,
  type PageFormat,
  type TemplateDefinition,
} from '@invoice/invoice-templates';
import { amountInWords } from '@invoice/invoice-templates';

const store = new Map<string, CompanyBranding>();

export const brandingOf = (companyId: CompanyId | string): CompanyBranding =>
  store.get(String(companyId)) ?? EMPTY_BRANDING;

const str = (value: unknown): string => String(value ?? '').trim();

const put = (companyId: CompanyId | string, next: CompanyBranding): CompanyBranding => {
  store.set(String(companyId), next);
  return next;
};

/** What the screen shows when it opens: what is set now, and what it is allowed to set. */
export const readBranding = (companyId: CompanyId | string) => ({
  branding: brandingOf(companyId),
  templates: TEMPLATE_CHOICES,
});

/**
 * Saves what the business changed. Each field is optional and each is separately removable, because
 * "take my logo off" is a thing a business asks for and must not require re-uploading everything
 * else to achieve.
 */
export const saveBranding = (companyId: CompanyId | string, body: unknown): { branding: CompanyBranding } => {
  const input = (body ?? {}) as {
    logoDataUri?: unknown;
    accent?: unknown;
    pictureId?: unknown;
    opacityPercent?: unknown;
    clear?: unknown;
  };
  const current = brandingOf(companyId);
  const clear = Array.isArray(input.clear) ? input.clear.map(String) : [];

  let logoDataUri = clear.includes('logo') ? null : current.logoDataUri;
  if (typeof input.logoDataUri === 'string' && input.logoDataUri !== '') {
    validateLogo(input.logoDataUri);
    logoDataUri = input.logoDataUri;
  }

  let accent = clear.includes('accent') ? null : current.accent;
  if (typeof input.accent === 'string' && input.accent !== '') {
    validateAccent(input.accent);
    accent = input.accent;
  }

  let tradeMark = clear.includes('tradeMark') ? null : current.tradeMark;
  const pictureId = str(input.pictureId);
  if (pictureId !== '') {
    // The cap lives in the module, not in the request: a screen may ask for anything, and what sits
    // under the watermark is the tax on the bill.
    const asked = Number(input.opacityPercent);
    tradeMark = Number.isFinite(asked) && asked > 0 ? tradeMarkFromLibrary(pictureId, asked) : tradeMarkFromLibrary(pictureId);
  }

  return { branding: put(companyId, { logoDataUri, tradeMark, accent }) };
};

const TEMPLATE_IDS = ['india-standard', 'bakery-warm', 'services-simple', 'transport-consignment'] as const;

const TEMPLATE_CHOICES = TEMPLATE_IDS.map((id) => templateById(id))
  .filter((t): t is TemplateDefinition => t !== undefined)
  .map((t) => ({ id: t.id, name: t.name }));

/**
 * The sample bill the preview is drawn from.
 *
 * Every figure on it is made up, and the screen says so in as many words. It exists to show what a
 * business's own branding does to a real page — not to stand in for that business's books.
 */
const sampleDocument = (companyName: string, branding: CompanyBranding): InvoiceDocument => {
  const nil = zero('INR');
  return {
    title: 'TAX_INVOICE',
    number: 'SAMPLE/0001',
    date: isoDate('2026-09-12'),
    dueDate: null,
    seller: {
      name: companyName,
      addressLines: ['Your address prints here'],
      gstin: '29AAAAA0000A1Z5',
      stateCode: '29',
      stateName: 'Karnataka',
    },
    buyer: {
      name: 'A sample customer',
      addressLines: ['Their address prints here'],
      gstin: '29BBBBB1111B1Z3',
      stateCode: '29',
      stateName: 'Karnataka',
    },
    shipTo: null,
    placeOfSupplyStateCode: '29',
    placeOfSupplyStateName: 'Karnataka',
    reverseCharge: false,
    supplyKind: 'GOODS',
    split: 'CGST_SGST',
    lines: [
      {
        lineId: 'sample-1',
        description: 'A sample item',
        hsnOrSac: '1905',
        kind: 'GOODS',
        quantityText: '10 PCS',
        unitPrice: rupees(100),
        discount: null,
        taxableValue: rupees(1000),
        ratePercentTimes100: 1800n,
        taxAmount: rupees(180),
        cgst: rupees(90),
        sgst: rupees(90),
        utgst: nil,
        igst: nil,
        cess: nil,
        reverseCharge: false,
        batch: null,
        note: null,
      },
    ],
    totals: {
      taxableValue: rupees(1000),
      cgst: rupees(90),
      sgst: rupees(90),
      utgst: nil,
      igst: nil,
      cess: nil,
      roundOff: nil,
      invoiceValue: rupees(1180),
      reverseChargeTax: nil,
      amountPaid: null,
      outstanding: null,
    },
    transport: null,
    eInvoice: null,
    amountInWordsText: amountInWords(rupees(1180)),
    taxAmountInWordsText: amountInWords(rupees(180)),
    declaredRateNotice: null,
    logoDataUri: branding.logoDataUri,
    tradeMark: branding.tradeMark,
    bankDetails: null,
    bank: null,
    references: null,
    terms: null,
    declaration: null,
    signatureDataUri: null,
    poReference: null,
  };
};

/**
 * A real bill, rendered with whatever the business has set so far.
 *
 * Unsaved changes are accepted in the request so the screen can show the effect of a picture before
 * anybody commits to it. Nothing sent here is stored.
 */
export const previewBranding = (
  companyId: CompanyId | string,
  companyName: string,
  body: unknown,
): { html: string; templateId: string; format: PageFormat } => {
  const input = (body ?? {}) as {
    templateId?: unknown;
    format?: unknown;
    locale?: unknown;
    logoDataUri?: unknown;
    accent?: unknown;
    pictureId?: unknown;
  };
  const saved = brandingOf(companyId);

  const logoDataUri = typeof input.logoDataUri === 'string' && input.logoDataUri !== '' ? input.logoDataUri : saved.logoDataUri;
  if (logoDataUri !== null) validateLogo(logoDataUri);
  const accent = typeof input.accent === 'string' && input.accent !== '' ? input.accent : saved.accent;
  if (accent !== null) validateAccent(accent);
  const pictureId = str(input.pictureId);
  const tradeMark = pictureId === '' ? saved.tradeMark : tradeMarkFromLibrary(pictureId);

  const branding: CompanyBranding = { logoDataUri, tradeMark, accent };
  const template = templateById(str(input.templateId) === '' ? 'india-standard' : str(input.templateId));
  if (template === undefined) throw new Error('That bill design is not one we have.');
  const locale: Locale = input.locale === 'hi-IN' ? 'hi-IN' : 'en-IN';
  const format: PageFormat = input.format === 'THERMAL_80MM' ? 'THERMAL_80MM' : 'A4';

  const snapshot = brandedSnapshot(template, locale, new Date().toISOString().slice(0, 10), branding);
  return {
    html: renderInvoice(sampleDocument(companyName, branding), snapshot, { format, locale }),
    templateId: template.id,
    format,
  };
};
