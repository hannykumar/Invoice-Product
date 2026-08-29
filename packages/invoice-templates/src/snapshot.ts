/**
 * Issue #13 [E13] — freezing the design onto the bill.
 *
 * "Old invoices preserve their original template" is an acceptance criterion, and storing a
 * template id would not achieve it: a template can be edited, and then every old bill silently
 * changes. So the whole visual definition is copied onto the invoice when it is issued.
 */
import type { TemplateSnapshot } from './document.ts';
import type { Locale } from './document.ts';
import type { TemplateDefinition } from './template.ts';

export const captureSnapshot = (
  template: TemplateDefinition,
  locale: Locale,
  capturedOn: string,
): TemplateSnapshot => ({
  templateId: template.id,
  templateVersion: template.version,
  capturedOn,
  palette: { ...template.palette },
  typography: { ...template.typography },
  optionalFields: [...template.optionalFields],
  lineColumns: [...template.lineColumns],
  logo: { ...template.logo },
  footerNote: template.footerNote === null ? null : template.footerNote[locale],
});
