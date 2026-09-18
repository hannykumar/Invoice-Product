/**
 * Issue #148 [GPT 3] — how the bill reserves space for facts that are not real yet.
 *
 * Some things on a bill cannot carry a real value until an outside connection is live. The
 * government e-invoice QR picture, the IRN and the acknowledgement number and date all wait on a
 * provider (#51). The pay-by-scan UPI square waits on a business saving its UPI id (#144), and the
 * signature image waits on the business uploading one (#146).
 *
 * The instruction was to build the layout now with the space blocked out, so the finished page can
 * be seen and approved before those arrive. That is what this file is. It exists so that the rule
 * is decided **once**: every issue that later fills one of these in draws its empty state from
 * here, and none of them invents its own.
 *
 * The rule, in full:
 *
 *  1. A reserved slot is a bordered box **at the size the real thing will take**, with a short,
 *     quiet label saying what will appear there **and that it has not arrived**. It is never an
 *     empty gap, never a broken image, and never a collapsed row. The label has to carry the "not
 *     yet": an empty box next to the words "Government reference" reads as a bill that has been
 *     registered with the government and lost its number, which is a far worse claim to make than
 *     leaving the space out.
 *  2. Because the box is already the final size, nothing on the page moves when the real value
 *     arrives. The value is drawn inside the same box.
 *  3. Reserved slots are **dropped entirely on 58 mm and 80 mm till-roll paper**. There is no room
 *     for a placeholder on a counter slip, and a customer holding one does not need to be told
 *     what is not there yet.
 *  4. ~~The screen preview and the print show the slot identically.~~ Replaced by issue #189, below.
 *
 * Issue #189 — the labels belong on the design preview, not on a bill a customer receives.
 *
 * Every issued bill used to print "Government QR, not received yet", "UPI id not saved yet" and
 * "Signature not uploaded yet". Most small businesses never register their bills with the government
 * at all (that is only required above ₹5 crore of turnover), so a buyer's accountant read those words
 * as "this bill is waiting for something" and could hold the payment. "Signature not uploaded yet"
 * printed exactly where the owner signs by hand.
 *
 * Samay was asked on 2026-09-18 and left the choice to us: "take action accordingly which you think
 * is better because it is just for small till we are done with everything". Option A was chosen:
 *
 *  - `DESIGN_PREVIEW` (the Bill design screen and the demo pages): the labelled boxes, exactly as
 *    #148 built them, so the finished layout can still be seen and approved.
 *  - `ISSUED` (the default — every bill, PDF, challan, credit note and quotation a customer gets):
 *    only real things. The signing space is blank, at the same size, above "Authorised Signatory".
 *    The e-invoice block prints only for a bill that is meant to be registered, as a blank area of
 *    the same size until the government's reply arrives. The UPI square prints only once a UPI id
 *    is saved. Nothing on an issued bill says "not yet".
 *
 * Rules 1 to 3 still hold for the preview, and the sizes are unchanged, so nothing moves when a real
 * value lands.
 */
import type { Locale } from './document.ts';
import type { PageFormat } from './template.ts';

/**
 * Issue #189 — who the page is for. `ISSUED` is a bill a customer receives; `DESIGN_PREVIEW` is the
 * layout a business looks at before approving it. A caller that says nothing gets `ISSUED`, so a
 * forgotten option can only ever produce the customer-safe page.
 */
export type RenderPurpose = 'ISSUED' | 'DESIGN_PREVIEW';

export type ReservedSlotId =
  | 'einvoice.qr'
  | 'einvoice.irn'
  | 'einvoice.ackNumber'
  | 'einvoice.ackDate'
  | 'upi.qr'
  | 'signature';

export interface ReservedSlotSpec {
  readonly id: ReservedSlotId;
  /** The final size of the real thing, in millimetres. The empty box is exactly this big. */
  readonly widthMm: number;
  readonly heightMm: number;
  /** The quiet label printed inside the empty box. Kept to a few words; it has to fit. */
  readonly label: { readonly 'en-IN': string; readonly 'hi-IN': string };
  /** What has to happen before this can hold a real value. For people reading the code. */
  readonly waitingOn: string;
}

const slot = (
  id: ReservedSlotId,
  widthMm: number,
  heightMm: number,
  en: string,
  hi: string,
  waitingOn: string,
): ReservedSlotSpec => ({ id, widthMm, heightMm, label: { 'en-IN': en, 'hi-IN': hi }, waitingOn });

/**
 * Every reserved slot the printed bill knows about.
 *
 * The sizes are the real ones. 26 mm is the smallest square a phone camera reliably scans a dense
 * QR from at arm's length, and it is what the e-invoice QR already prints at, so the empty box and
 * the filled one are the same box. The IRN box holds 64 characters of code on two lines.
 */
export const RESERVED_SLOTS: readonly ReservedSlotSpec[] = [
  slot('einvoice.qr', 26, 26, 'Government QR, not received yet', 'Sarkari QR, abhi nahin mila', 'e-invoice provider access, issue #51'),
  slot('einvoice.irn', 72, 9, 'Government reference (IRN), not received yet', 'Sarkari reference (IRN), abhi nahin mila', 'e-invoice provider access, issue #51'),
  slot('einvoice.ackNumber', 44, 8, 'Ack number, not received yet', 'Ack number, abhi nahin mila', 'e-invoice provider access, issue #51'),
  slot('einvoice.ackDate', 44, 8, 'Ack date, not received yet', 'Ack ki taarikh, abhi nahin mili', 'e-invoice provider access, issue #51'),
  slot('upi.qr', 26, 26, 'Pay by scan, UPI id not saved yet', 'Scan karke payment, UPI id abhi save nahin', 'the business saving its UPI id, issue #144'),
  // Sized to the space a scanned signature actually needs above the "Authorised Signatory" rule.
  slot('signature', 48, 16, 'Signature not uploaded yet', 'Hastakshar abhi upload nahin hue', 'the business uploading its signature, issue #146'),
];

export const reservedSlot = (id: ReservedSlotId): ReservedSlotSpec => {
  const found = RESERVED_SLOTS.find((s) => s.id === id);
  if (found === undefined) throw new Error(`No reserved slot is defined for "${id}".`);
  return found;
};

/**
 * Till-roll paper gets no reserved slots at all.
 *
 * A phone screen does, because it is the shape a business checks the bill on before sending it,
 * and that check is the whole point of reserving the space.
 */
export const printsReservedSlots = (format: PageFormat): boolean =>
  format !== 'THERMAL_58MM' && format !== 'THERMAL_80MM';

/**
 * The empty box.
 *
 * On the design preview it is the labelled box. On an issued bill the signing space and a pending
 * e-invoice area stay at their full size with no border and no words, and the UPI square is left
 * out altogether — a bill with no UPI id simply has no way to pay by scan.
 *
 * `escape` is passed in rather than imported so this file has no opinion about how the renderer
 * escapes; there is exactly one escaping function in the module and it stays there.
 */
export const renderReservedSlot = (
  id: ReservedSlotId,
  format: PageFormat,
  locale: Locale,
  escape: (value: string) => string,
  purpose: RenderPurpose = 'ISSUED',
): string => {
  if (!printsReservedSlots(format)) return '';
  const spec = reservedSlot(id);
  const size = `width:${spec.widthMm}mm;height:${spec.heightMm}mm`;
  if (purpose === 'DESIGN_PREVIEW') {
    return `<div class="reserved" data-reserved="${escape(spec.id)}" style="${size}"><span>${escape(spec.label[locale])}</span></div>`;
  }
  if (id === 'upi.qr') return '';
  return `<div class="reserved-blank" data-reserved="${escape(spec.id)}" style="${size}"></div>`;
};

/** The one style block for reserved slots, so they cannot drift apart between callers. */
export const reservedSlotStyles = (border: string, muted: string, labelSizePt: number): string => `
    .reserved {
      border: 1px dashed ${border}; color: ${muted}; background: #fff;
      display: flex; align-items: center; justify-content: center; text-align: center;
      font-size: ${labelSizePt}pt; line-height: 1.2; padding: 1mm;
      /* Fixed, because the whole purpose is that the page does not move when the value lands. */
      flex: none;
    }
    @media print { .reserved { border: 1px dashed ${border}; background: #fff; } }
    /* Issue #189 — the same space on an issued bill, with nothing drawn in it. */
    .reserved-blank { flex: none; }`;
