/**
 * Issue #13 [E13] — what a template is, and what it may decide.
 *
 * A template decides how a bill *looks* and which *optional* things it shows. It cannot decide
 * what a tax invoice must contain — that section is assembled from the invoice itself and a
 * template has no field with which to remove it.
 */
import { invalid, type IsoDate } from '@invoice/kernel';
import { MANDATORY_FIELD_IDS, OPTIONAL_FIELDS } from './mandatory.ts';

export type BusinessType = 'RETAIL' | 'WHOLESALE' | 'BAKERY' | 'SERVICES' | 'TRANSPORT' | 'MANUFACTURING';

/** The shapes a bill is printed on. Each is a real constraint, not a style preset. */
export type PageFormat = 'A4' | 'THERMAL_80MM' | 'THERMAL_58MM' | 'MOBILE';

export interface Palette {
  /** Used for headings and rules. Must stay legible on white, and on a thermal printer. */
  readonly accent: string;
  readonly text: string;
  readonly muted: string;
  readonly border: string;
}

export interface Typography {
  /** A stack, not a font. Devanagari must have a fallback that actually exists on cheap phones. */
  readonly bodyStack: string;
  readonly headingStack: string;
  readonly baseSizePt: number;
}

export interface TemplateDefinition {
  readonly id: string;
  /** Bumped whenever anything visual changes, so an old bill can be reprinted as it was. */
  readonly version: string;
  readonly name: { readonly 'en-IN': string; readonly 'hi-IN': string };
  readonly businessTypes: readonly BusinessType[];
  readonly formats: readonly PageFormat[];
  readonly palette: Palette;
  readonly typography: Typography;
  /** Optional fields this template shows, in the order it shows them. */
  readonly optionalFields: readonly string[];
  /** Extra column headings for the line table, drawn from `optionalFields`. */
  readonly lineColumns: readonly string[];
  readonly logo: { readonly show: boolean; readonly maxHeightPt: number };
  readonly footerNote: { readonly 'en-IN': string; readonly 'hi-IN': string } | null;
  readonly publishedOn: IsoDate;
}

/**
 * Refuses a template that tries to reach into the compliance section, or that would print
 * something the renderer cannot produce.
 */
export const validateTemplate = (template: TemplateDefinition): void => {
  const optional = new Set(OPTIONAL_FIELDS);
  for (const fieldId of template.optionalFields) {
    if (MANDATORY_FIELD_IDS.has(fieldId)) {
      throw invalid(
        'TEMPLATE_TOUCHES_MANDATORY_FIELD',
        `"${fieldId}" is part of every tax invoice, so a template neither adds nor removes it.`,
      );
    }
    if (!optional.has(fieldId)) {
      throw invalid('TEMPLATE_UNKNOWN_FIELD', `This design asks for "${fieldId}", which the invoice does not have.`);
    }
  }
  for (const column of template.lineColumns) {
    if (!template.optionalFields.includes(column)) {
      throw invalid(
        'TEMPLATE_COLUMN_NOT_SHOWN',
        `"${column}" is set as a column but the design does not show it.`,
      );
    }
    if (!column.startsWith('line.')) {
      throw invalid('TEMPLATE_BAD_COLUMN', `"${column}" is not something that varies per line.`);
    }
  }
  if (template.formats.length === 0) {
    throw invalid('TEMPLATE_NO_FORMAT', 'A design must work on at least one paper size.');
  }
  if (template.typography.baseSizePt < 7) {
    throw invalid(
      'TEMPLATE_TEXT_TOO_SMALL',
      'Text below 7 point cannot be read reliably on a printed bill, so it is not allowed.',
    );
  }
  if (!template.typography.bodyStack.toLowerCase().includes('sans-serif') && !template.typography.bodyStack.toLowerCase().includes('serif')) {
    throw invalid(
      'TEMPLATE_NO_FONT_FALLBACK',
      'A font list must end in a generic family, or a phone without that font prints nothing readable.',
    );
  }
};

const DEVANAGARI_SAFE = "'Noto Sans Devanagari', 'Nirmala UI', 'Mangal', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

/**
 * The templates that ship.
 *
 * Each exists because a real business needs it, not because a designer wanted variety. The
 * wholesaler needs HSN, batch and transport; the bakery needs flavour, size and a delivery date;
 * the counter shop needs 58 millimetres of thermal paper and nothing else.
 */
export const SHIPPED_TEMPLATES: readonly TemplateDefinition[] = [
  {
    id: 'wholesale-classic',
    version: '1.0.0',
    name: { 'en-IN': 'Wholesale, plain', 'hi-IN': 'Thok, saada' },
    businessTypes: ['WHOLESALE', 'MANUFACTURING'],
    formats: ['A4', 'MOBILE'],
    palette: { accent: '#1f4e79', text: '#111111', muted: '#555555', border: '#999999' },
    typography: { bodyStack: DEVANAGARI_SAFE, headingStack: DEVANAGARI_SAFE, baseSizePt: 9 },
    optionalFields: [
      'seller.logo', 'seller.phone', 'seller.bankDetails', 'document.dueDate', 'document.poReference',
      'line.batch', 'line.discount', 'totals.outstanding', 'footer.terms', 'footer.signature',
      'transport.vehicleNumber', 'transport.transporter', 'transport.eWayBillNumber', 'qr.eInvoice',
    ],
    lineColumns: ['line.batch', 'line.discount'],
    logo: { show: true, maxHeightPt: 42 },
    footerNote: {
      'en-IN': 'Goods once sold are taken back only as agreed.',
      'hi-IN': 'Becha hua maal sirf tay shart par wapas liya jayega.',
    },
    publishedOn: '2026-08-29' as IsoDate,
  },
  {
    id: 'bakery-warm',
    version: '1.0.0',
    name: { 'en-IN': 'Bakery', 'hi-IN': 'Bakery' },
    businessTypes: ['BAKERY', 'RETAIL'],
    formats: ['A4', 'THERMAL_80MM', 'MOBILE'],
    palette: { accent: '#8a4b2a', text: '#1a1a1a', muted: '#6b5344', border: '#c9a68c' },
    typography: { bodyStack: DEVANAGARI_SAFE, headingStack: DEVANAGARI_SAFE, baseSizePt: 10 },
    optionalFields: ['seller.logo', 'seller.phone', 'line.note', 'footer.thankYou', 'totals.amountPaid'],
    lineColumns: ['line.note'],
    logo: { show: true, maxHeightPt: 56 },
    footerNote: { 'en-IN': 'Thank you, and come again.', 'hi-IN': 'Dhanyavaad, phir aaiyega.' },
    publishedOn: '2026-08-29' as IsoDate,
  },
  {
    id: 'counter-thermal',
    version: '1.0.0',
    name: { 'en-IN': 'Counter slip', 'hi-IN': 'Counter parchi' },
    businessTypes: ['RETAIL'],
    formats: ['THERMAL_58MM', 'THERMAL_80MM'],
    palette: { accent: '#000000', text: '#000000', muted: '#000000', border: '#000000' },
    typography: { bodyStack: DEVANAGARI_SAFE, headingStack: DEVANAGARI_SAFE, baseSizePt: 8 },
    optionalFields: ['seller.phone', 'totals.amountPaid', 'footer.thankYou'],
    lineColumns: [],
    logo: { show: false, maxHeightPt: 0 },
    footerNote: { 'en-IN': 'Thank you.', 'hi-IN': 'Dhanyavaad.' },
    publishedOn: '2026-08-29' as IsoDate,
  },
  {
    id: 'services-simple',
    version: '1.0.0',
    name: { 'en-IN': 'Services', 'hi-IN': 'Service' },
    businessTypes: ['SERVICES'],
    formats: ['A4', 'MOBILE'],
    palette: { accent: '#2f5d50', text: '#111111', muted: '#4d4d4d', border: '#a8bdb6' },
    typography: { bodyStack: DEVANAGARI_SAFE, headingStack: DEVANAGARI_SAFE, baseSizePt: 10 },
    optionalFields: ['seller.logo', 'seller.email', 'seller.bankDetails', 'document.dueDate', 'line.note', 'footer.terms', 'footer.signature'],
    lineColumns: ['line.note'],
    logo: { show: true, maxHeightPt: 48 },
    footerNote: { 'en-IN': 'Payable within the agreed days.', 'hi-IN': 'Tay dinon ke andar dena hai.' },
    publishedOn: '2026-08-29' as IsoDate,
  },
  {
    id: 'transport-consignment',
    version: '1.0.0',
    name: { 'en-IN': 'Transport', 'hi-IN': 'Transport' },
    businessTypes: ['TRANSPORT'],
    formats: ['A4'],
    palette: { accent: '#5a3d7a', text: '#111111', muted: '#4d4d4d', border: '#b3a3c4' },
    typography: { bodyStack: DEVANAGARI_SAFE, headingStack: DEVANAGARI_SAFE, baseSizePt: 9 },
    optionalFields: ['seller.logo', 'seller.phone', 'document.poReference', 'line.note', 'transport.vehicleNumber', 'transport.transporter', 'transport.eWayBillNumber', 'footer.signature'],
    lineColumns: ['line.note'],
    logo: { show: true, maxHeightPt: 42 },
    footerNote: null,
    publishedOn: '2026-08-29' as IsoDate,
  },
];

/**
 * Suggests templates for a business type, best first.
 *
 * A suggestion is never a legal fact and never changes what is printed in the compliance section
 * — it changes which optional things a business is offered.
 */
export const recommendTemplates = (businessType: BusinessType): readonly TemplateDefinition[] => {
  const direct = SHIPPED_TEMPLATES.filter((t) => t.businessTypes[0] === businessType);
  const also = SHIPPED_TEMPLATES.filter((t) => t.businessTypes.includes(businessType) && !direct.includes(t));
  const rest = SHIPPED_TEMPLATES.filter((t) => !direct.includes(t) && !also.includes(t));
  return [...direct, ...also, ...rest];
};

export const templateById = (id: string): TemplateDefinition | undefined =>
  SHIPPED_TEMPLATES.find((t) => t.id === id);
