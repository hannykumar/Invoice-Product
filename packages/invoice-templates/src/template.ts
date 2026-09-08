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

/**
 * Issue #140 — how the page is built, which is a deeper choice than how it is coloured.
 *
 * `BOXED` is how an Indian tax invoice is actually laid out — the whole page is one ruled grid,
 * every fact in its own cell, closed on all four sides. Every shipped design is boxed.
 *
 * `AIRY` is the original: white space, rules under the rows, a coloured heading band. No design
 * ships it any more. It stays only because a bill records the design it was printed with, so a bill
 * issued before this changed must still reprint as the page it was rather than silently changing
 * shape years later.
 *
 * This is a structural choice, so it cannot be expressed through the palette: it changes which
 * boxes exist, not what colour they are.
 */
export type PageLayout = 'AIRY' | 'BOXED';

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
  /** How the page is built. See `PageLayout`. */
  readonly layout: PageLayout;
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
 * **There is one correct bill.** Every design below is the same boxed page and carries the same
 * compliance section, item table, HSN summary and totals, because those come from the renderer and
 * a design has no field with which to remove them. What a design chooses is only which *optional*
 * extras it shows and which paper it fits on: the wholesaler wants batch and transport, the bakery
 * wants a note per line, the counter shop wants 58 millimetres of till roll and nothing else.
 *
 * A business is never offered a version of the bill that is missing something another version has.
 * The earlier airy design was deleted rather than kept as an alternative for anyone who preferred
 * the look, because a business that picked it would have got a worse bill with no way to know.
 */
export const SHIPPED_TEMPLATES: readonly TemplateDefinition[] = [
  {
    // Issue #140. First in this list on purpose: `recommendTemplates` offers the earliest matching
    // design first, and this is now what a wholesaler and a manufacturer should be shown.
    id: 'india-standard',
    version: '1.0.0',
    layout: 'BOXED',
    name: { 'en-IN': 'India standard, boxed', 'hi-IN': 'India standard, dabba' },
    businessTypes: ['WHOLESALE', 'MANUFACTURING', 'TRANSPORT', 'SERVICES'],
    formats: ['A4', 'THERMAL_80MM', 'THERMAL_58MM', 'MOBILE'],
    // Black on white with grey rules. A bill is photocopied, faxed and printed on a tired laser
    // printer, and a coloured heading band is the first thing to turn into a grey smear.
    palette: { accent: '#000000', text: '#000000', muted: '#444444', border: '#000000' },
    typography: { bodyStack: DEVANAGARI_SAFE, headingStack: DEVANAGARI_SAFE, baseSizePt: 8 },
    optionalFields: [
      'seller.logo', 'seller.phone', 'seller.email', 'seller.bankDetails', 'seller.pan',
      'document.dueDate', 'document.poReference',
      'line.batch', 'line.packages', 'line.discount', 'totals.outstanding', 'totals.amountPaid',
      'footer.terms', 'footer.declaration', 'footer.signature', 'footer.computerGenerated',
      'transport.vehicleNumber', 'transport.transporter', 'transport.eWayBillNumber',
      'transport.lrNumber', 'transport.document', 'transport.destination',
      'qr.eInvoice',
    ],
    lineColumns: ['line.discount', 'line.batch', 'line.packages'],
    logo: { show: true, maxHeightPt: 42 },
    // No footer note. A slogan or a returns policy is a commitment the business makes, and this
    // product does not make one on its behalf. The business fills in its own terms and declaration.
    footerNote: null,
    publishedOn: '2026-09-08' as IsoDate,
  },
  {
    id: 'bakery-warm',
    version: '1.0.0',
    layout: 'BOXED',
    name: { 'en-IN': 'Bakery', 'hi-IN': 'Bakery' },
    businessTypes: ['BAKERY', 'RETAIL'],
    formats: ['A4', 'THERMAL_80MM', 'MOBILE'],
    palette: { accent: '#8a4b2a', text: '#1a1a1a', muted: '#6b5344', border: '#c9a68c' },
    typography: { bodyStack: DEVANAGARI_SAFE, headingStack: DEVANAGARI_SAFE, baseSizePt: 10 },
    optionalFields: ['seller.logo', 'seller.phone', 'line.note', 'footer.thankYou', 'totals.amountPaid'],
    lineColumns: ['line.note'],
    logo: { show: true, maxHeightPt: 56 },
    footerNote: null,
    publishedOn: '2026-08-29' as IsoDate,
  },
  {
    id: 'counter-thermal',
    version: '1.0.0',
    layout: 'BOXED',
    name: { 'en-IN': 'Counter slip', 'hi-IN': 'Counter parchi' },
    businessTypes: ['RETAIL'],
    formats: ['THERMAL_58MM', 'THERMAL_80MM'],
    palette: { accent: '#000000', text: '#000000', muted: '#000000', border: '#000000' },
    typography: { bodyStack: DEVANAGARI_SAFE, headingStack: DEVANAGARI_SAFE, baseSizePt: 8 },
    optionalFields: ['seller.phone', 'totals.amountPaid', 'footer.thankYou'],
    lineColumns: [],
    logo: { show: false, maxHeightPt: 0 },
    footerNote: null,
    publishedOn: '2026-08-29' as IsoDate,
  },
  {
    id: 'services-simple',
    version: '1.0.0',
    layout: 'BOXED',
    name: { 'en-IN': 'Services', 'hi-IN': 'Service' },
    businessTypes: ['SERVICES'],
    formats: ['A4', 'MOBILE'],
    palette: { accent: '#2f5d50', text: '#111111', muted: '#4d4d4d', border: '#a8bdb6' },
    typography: { bodyStack: DEVANAGARI_SAFE, headingStack: DEVANAGARI_SAFE, baseSizePt: 10 },
    optionalFields: ['seller.logo', 'seller.email', 'seller.bankDetails', 'seller.pan', 'document.dueDate', 'line.note', 'footer.terms', 'footer.signature', 'footer.computerGenerated'],
    lineColumns: ['line.note'],
    logo: { show: true, maxHeightPt: 48 },
    footerNote: null,
    publishedOn: '2026-08-29' as IsoDate,
  },
  {
    id: 'transport-consignment',
    version: '1.0.0',
    layout: 'BOXED',
    name: { 'en-IN': 'Transport', 'hi-IN': 'Transport' },
    businessTypes: ['TRANSPORT'],
    formats: ['A4'],
    palette: { accent: '#5a3d7a', text: '#111111', muted: '#4d4d4d', border: '#b3a3c4' },
    typography: { bodyStack: DEVANAGARI_SAFE, headingStack: DEVANAGARI_SAFE, baseSizePt: 9 },
    optionalFields: [
      'seller.logo', 'seller.phone', 'seller.pan', 'document.poReference', 'line.note', 'line.packages',
      'transport.vehicleNumber', 'transport.transporter', 'transport.eWayBillNumber',
      'transport.lrNumber', 'transport.document', 'transport.destination',
      'footer.signature', 'footer.computerGenerated',
    ],
    lineColumns: ['line.note', 'line.packages'],
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
