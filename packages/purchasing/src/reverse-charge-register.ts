/**
 * Issue #289, part 2b — the reverse-charge register: every purchase on which the buyer pays the GST
 * (CGST s.9(3)), the facts its time of supply turns on, and the self-invoice the buyer issues for a
 * purchase from a supplier who is not registered.
 *
 * Law (read 21 Oct 2026 from the current CBIC text; see `reverse-charge-timing.ts` for the dates):
 *
 *  - CGST s.31(3)(f), as amended by s.122 of the Finance (No. 2) Act, 2024: the registered buyer
 *    liable under s.9(3)/(4) issues an invoice for what it receives from a supplier who is not
 *    registered, within the prescribed period. A supplier registered only for TDS (s.51) counts as
 *    not registered (Explanation).
 *  - CGST Rule 47A (Notification 20/2024-Central Tax, 08.10.2024, from 01.11.2024): within thirty
 *    days of receiving the supply. The same notification omitted Rule 46's old proviso that allowed
 *    one consolidated monthly invoice for s.9(4) supplies — so it is one self-invoice per purchase.
 *  - CGST Rule 46 — the invoice carries (a) the supplier's name and address (its GSTIN only where it
 *    has one), (b) a consecutive serial number of at most sixteen characters — letters, digits,
 *    hyphen and slash — unique for the financial year, (c) its date, (d) the recipient's name,
 *    address and GSTIN, (g) HSN/SAC, (h) description, (i) quantity and unit, (j) total value,
 *    (k) taxable value, (l) rate, (m) tax by head, (n) place of supply with the State's name for an
 *    inter-State supply, (p) that tax is payable on reverse charge, and (q) a signature.
 *
 * What this module never does: post to the ledger (the bill already did, #17) or decide whether a
 * line is under reverse charge (that is `reverse-charge-notified.ts`). Every record here is written
 * once and never changed — the same as the tables underneath (`reverse-charge-migrations.ts`).
 */
import { conflict, forbidden, invalid, notFound, financialYearOf, isoDate, type Clock, type CompanyId, type IsoDate } from "@invoice/kernel";
import type { ActorContext, AuditPort, TransactionParticipant } from "@invoice/ledger";
import type { Paise } from "../../masters/src/types.ts";
import { formatPaise } from "./money.ts";
import {
  rcmTimeOfSupply, selfInvoiceDue, selfInvoiceLastDay,
  type RcmSupplyKind, type RcmTimeOfSupply, type SelfInvoiceDue,
} from "./reverse-charge-timing.ts";

/** Issuing a self-invoice is part of recording the purchase, so it needs the same permission. */
export const SELF_INVOICE_PERMISSION = "ledger.post.purchase";

/** One line of a reverse-charge purchase, frozen as it was posted: everything a Rule 46 invoice needs. */
export interface ReverseChargeLine {
  readonly lineNumber: number;
  readonly description: string;
  readonly hsnSac: string;
  /** How many, as a person reads it ("200 KGS"); the unit is Rule 46(i)'s "unit or UQC". */
  readonly quantity: string;
  readonly unit: string;
  readonly taxableValuePaise: Paise;
  readonly gstRateBasisPoints: number;
  readonly cgstPaise: Paise;
  readonly sgstPaise: Paise;
  readonly igstPaise: Paise;
  readonly cessPaise: Paise;
}

export interface RegisterParty {
  readonly name: string;
  readonly addressLines: readonly string[];
  readonly gstin: string | null;
  readonly stateCode: string;
  readonly stateName: string;
}

/** A posted purchase on which the buyer pays the GST. Written once, when the bill is posted. */
export interface ReverseChargePurchase {
  readonly companyId: CompanyId;
  readonly billId: string;
  readonly supplierPartyId: string;
  readonly supplier: RegisterParty;
  /**
   * Whether the supplier is the one who must issue the invoice. `false` for a supplier who is not
   * registered (or registered only for TDS): the buyer then issues the self-invoice.
   */
  readonly supplierRegistered: boolean;
  readonly supplyKind: RcmSupplyKind;
  /** The supplier's bill number and date (or other document), as typed. */
  readonly invoiceNumber: string;
  readonly invoiceDate: IsoDate;
  /** When the goods or the service reached the buyer: s.12(3)(a), and the start of Rule 47A's 30 days. */
  readonly receivedOn: IsoDate;
  /** When it went into the books: the provisos' fallback date. */
  readonly enteredOn: IsoDate;
  readonly interState: boolean;
  readonly lines: readonly ReverseChargeLine[];
  readonly recordedBy: string;
  readonly recordedAt: string;
}

/** The buyer's own invoice for a purchase from an unregistered supplier. Never changed once issued. */
export interface SelfInvoice {
  readonly id: string;
  readonly companyId: CompanyId;
  readonly billId: string;
  /** "SI/2026-27/0001" — fifteen characters, letters, digits, hyphen and slash (Rule 46(b)). */
  readonly number: string;
  readonly financialYear: string;
  readonly sequence: number;
  readonly issuedOn: IsoDate;
  readonly receivedOn: IsoDate;
  readonly supplier: RegisterParty;
  readonly recipient: RegisterParty;
  /** Rule 46(n): the place of supply, with the State's name and code. */
  readonly placeOfSupply: { readonly stateCode: string; readonly stateName: string };
  readonly interState: boolean;
  readonly lines: readonly ReverseChargeLine[];
  readonly taxableValuePaise: Paise;
  readonly cgstPaise: Paise;
  readonly sgstPaise: Paise;
  readonly igstPaise: Paise;
  readonly cessPaise: Paise;
  readonly issuedBy: string;
  readonly issuedAt: string;
  readonly idempotencyKey: string;
}

export interface ReverseChargeRegisterRepository {
  /** Refuses a second, different record for the same bill. */
  insertPurchase(purchase: ReverseChargePurchase): Promise<void>;
  purchaseFor(companyId: CompanyId, billId: string): Promise<ReverseChargePurchase | null>;
  purchases(companyId: CompanyId): Promise<readonly ReverseChargePurchase[]>;
  /** Refuses a second self-invoice for one bill, and a number already used that year. */
  insertSelfInvoice(invoice: SelfInvoice): Promise<void>;
  selfInvoiceFor(companyId: CompanyId, billId: string): Promise<SelfInvoice | null>;
  selfInvoiceByKey(companyId: CompanyId, idempotencyKey: string): Promise<SelfInvoice | null>;
  selfInvoices(companyId: CompanyId): Promise<readonly SelfInvoice[]>;
  /** The highest sequence used in that financial year, or 0. */
  lastSelfInvoiceSequence(companyId: CompanyId, financialYear: string): Promise<number>;
}

/** One wording for memory and PostgreSQL. */
export const reverseChargeAlreadyRecorded = () =>
  conflict("REVERSE_CHARGE_ALREADY_RECORDED", "This purchase is already in the reverse-charge register with different details. It was not changed.");
export const selfInvoiceAlreadyIssued = () =>
  conflict("SELF_INVOICE_ALREADY_ISSUED", "A self-invoice has already been issued for this purchase, so a second one was not made.");
export const selfInvoiceNumberTaken = () =>
  conflict("SELF_INVOICE_NUMBER_TAKEN", "That self-invoice number is already used this year. Nothing was issued; try again.");

const samePurchase = (a: ReverseChargePurchase, b: ReverseChargePurchase): boolean =>
  a.supplierPartyId === b.supplierPartyId && a.invoiceNumber === b.invoiceNumber && a.invoiceDate === b.invoiceDate
  && a.receivedOn === b.receivedOn && a.supplyKind === b.supplyKind && a.supplierRegistered === b.supplierRegistered
  && a.lines.length === b.lines.length
  && a.lines.every((line, index) => line.taxableValuePaise === b.lines[index]?.taxableValuePaise && line.gstRateBasisPoints === b.lines[index]?.gstRateBasisPoints);

/** The register in memory, rolling back with the ledger store it joins. */
export class InMemoryReverseChargeRegister implements ReverseChargeRegisterRepository, TransactionParticipant {
  #purchases: ReverseChargePurchase[] = [];
  #invoices: SelfInvoice[] = [];

  snapshot(): unknown { return { purchases: [...this.#purchases], invoices: [...this.#invoices] }; }
  restore(taken: unknown): void {
    const held = taken as { purchases: ReverseChargePurchase[]; invoices: SelfInvoice[] };
    this.#purchases = [...held.purchases];
    this.#invoices = [...held.invoices];
  }

  async insertPurchase(purchase: ReverseChargePurchase): Promise<void> {
    const held = this.#purchases.find((row) => row.companyId === purchase.companyId && row.billId === purchase.billId);
    if (held !== undefined) {
      if (samePurchase(held, purchase)) return;
      throw reverseChargeAlreadyRecorded();
    }
    this.#purchases.push(Object.freeze(purchase));
  }
  async purchaseFor(companyId: CompanyId, billId: string) {
    return this.#purchases.find((row) => row.companyId === companyId && row.billId === billId) ?? null;
  }
  async purchases(companyId: CompanyId) { return this.#purchases.filter((row) => row.companyId === companyId); }

  async insertSelfInvoice(invoice: SelfInvoice): Promise<void> {
    const mine = this.#invoices.filter((row) => row.companyId === invoice.companyId);
    if (mine.some((row) => row.billId === invoice.billId || row.idempotencyKey === invoice.idempotencyKey)) throw selfInvoiceAlreadyIssued();
    if (mine.some((row) => row.number === invoice.number)) throw selfInvoiceNumberTaken();
    this.#invoices.push(Object.freeze(invoice));
  }
  async selfInvoiceFor(companyId: CompanyId, billId: string) {
    return this.#invoices.find((row) => row.companyId === companyId && row.billId === billId) ?? null;
  }
  async selfInvoiceByKey(companyId: CompanyId, idempotencyKey: string) {
    return this.#invoices.find((row) => row.companyId === companyId && row.idempotencyKey === idempotencyKey) ?? null;
  }
  async selfInvoices(companyId: CompanyId) { return this.#invoices.filter((row) => row.companyId === companyId); }
  async lastSelfInvoiceSequence(companyId: CompanyId, financialYear: string) {
    return this.#invoices.filter((row) => row.companyId === companyId && row.financialYear === financialYear)
      .reduce((highest, row) => Math.max(highest, row.sequence), 0);
  }
}

/** Rule 46(b): at most sixteen characters of letters, digits, hyphen and slash. */
export const RULE_46_SERIAL = /^[A-Za-z0-9/-]{1,16}$/;

/** "SI/2026-27/0001". Fifteen characters while the year has fewer than 10,000 self-invoices. */
export const selfInvoiceNumber = (financialYear: string, sequence: number): string => {
  const number = `SI/${financialYear}/${String(sequence).padStart(4, "0")}`;
  if (!RULE_46_SERIAL.test(number)) {
    throw invalid("SELF_INVOICE_SERIES_FULL", `This year's self-invoice series has run past ${sequence - 1}, and a longer number would break the 16-character limit of CGST Rule 46(b). Nothing was issued.`);
  }
  return number;
};

export interface SelfInvoiceReminder {
  readonly billId: string;
  readonly supplierName: string;
  readonly invoiceNumber: string;
  readonly receivedOn: IsoDate;
  readonly taxPaise: Paise;
  readonly due: SelfInvoiceDue;
  readonly selfInvoiceNumber: string | null;
}

export interface ReverseChargeServiceDeps {
  readonly register: ReverseChargeRegisterRepository;
  readonly audit: AuditPort;
  readonly clock: Clock;
  readonly idFactory?: () => string;
}

const MAX_SEQUENCE_RETRIES = 3;

const taxOf = (lines: readonly ReverseChargeLine[]): Paise =>
  lines.reduce((total, line) => total + line.cgstPaise + line.sgstPaise + line.igstPaise + line.cessPaise, 0n);

/** India's calendar date at an instant (UTC+05:30, no summer time). */
const indiaDate = (at: Date): IsoDate => isoDate(new Date(at.getTime() + 330 * 60_000).toISOString().slice(0, 10));

export class ReverseChargeService {
  readonly #register: ReverseChargeRegisterRepository;
  readonly #audit: AuditPort;
  readonly #clock: Clock;
  readonly #newId: () => string;

  constructor(deps: ReverseChargeServiceDeps) {
    this.#register = deps.register;
    this.#audit = deps.audit;
    this.#clock = deps.clock;
    this.#newId = deps.idFactory ?? (() => crypto.randomUUID());
  }

  /**
   * Puts a just-posted reverse-charge bill in the register. A retry with the same facts is a no-op;
   * different facts for the same bill are refused. A goods-received date after today, or a bill
   * mixing goods and services (whose tax points follow different sections), never gets here: the
   * caller checks with `checkReverseChargeEntry` before posting.
   */
  async recordPurchase(actor: ActorContext, purchase: Omit<ReverseChargePurchase, "companyId" | "recordedBy" | "recordedAt">): Promise<ReverseChargePurchase> {
    const record: ReverseChargePurchase = { ...purchase, companyId: actor.companyId, recordedBy: actor.userId, recordedAt: this.#clock.now().toISOString() };
    checkReverseChargeEntry({ receivedOn: record.receivedOn, today: indiaDate(this.#clock.now()), supplyKinds: [record.supplyKind] });
    const held = await this.#register.purchaseFor(actor.companyId, record.billId);
    if (held !== null) {
      if (samePurchase(held, record)) return held;
      throw reverseChargeAlreadyRecorded();
    }
    await this.#register.insertPurchase(record);
    return record;
  }

  async purchaseFor(companyId: CompanyId, billId: string) { return this.#register.purchaseFor(companyId, billId); }
  async selfInvoiceFor(companyId: CompanyId, billId: string) { return this.#register.selfInvoiceFor(companyId, billId); }
  async selfInvoices(companyId: CompanyId) { return this.#register.selfInvoices(companyId); }

  /** The time of supply of a registered bill, given the earliest payment against it (if any). */
  async timeOfSupply(companyId: CompanyId, billId: string, paidOn: IsoDate | null): Promise<RcmTimeOfSupply | null> {
    const purchase = await this.#register.purchaseFor(companyId, billId);
    if (purchase === null) return null;
    const selfInvoice = purchase.supplierRegistered ? null : await this.#register.selfInvoiceFor(companyId, billId);
    return timeOfSupplyOf(purchase, paidOn, selfInvoice?.issuedOn ?? null);
  }

  /**
   * Issues the self-invoice for one purchase from an unregistered supplier (s.31(3)(f), Rule 47A).
   * Once per purchase: pressing it again, or retrying with the same key, returns the one already
   * issued. Its date may not be before the goods arrived, nor after today.
   */
  async issueSelfInvoice(actor: ActorContext, input: {
    readonly billId: string;
    readonly issuedOn: IsoDate;
    readonly idempotencyKey: string;
    readonly recipient: RegisterParty;
    readonly billReversed: boolean;
  }): Promise<{ readonly invoice: SelfInvoice; readonly deduplicated: boolean }> {
    if (!actor.permissions.includes(SELF_INVOICE_PERMISSION)) {
      throw forbidden("PERMISSION_DENIED", "You do not have permission to issue a self-invoice. Ask the owner to give you access.", { details: { permission: SELF_INVOICE_PERMISSION } });
    }
    const byKey = await this.#register.selfInvoiceByKey(actor.companyId, input.idempotencyKey);
    if (byKey !== null) {
      if (byKey.billId !== input.billId) throw conflict("SELF_INVOICE_KEY_REUSED", "This entry was already used for a different purchase. Nothing new was issued; start a fresh entry.");
      return { invoice: byKey, deduplicated: true };
    }
    const purchase = await this.#register.purchaseFor(actor.companyId, input.billId);
    if (purchase === null) {
      throw notFound("SELF_INVOICE_NOT_REVERSE_CHARGE", "That bill is not a reverse-charge purchase, so no self-invoice is made for it.");
    }
    const issued = await this.#register.selfInvoiceFor(actor.companyId, input.billId);
    if (issued !== null) return { invoice: issued, deduplicated: true };
    if (purchase.supplierRegistered) {
      throw invalid("SELF_INVOICE_NOT_NEEDED", `${purchase.supplier.name} has a GST number, so their own bill is the invoice and you issue none. A self-invoice is only for a purchase from a supplier who is not registered (CGST s.31(3)(f)).`);
    }
    if (input.billReversed) {
      throw invalid("SELF_INVOICE_BILL_REVERSED", `Bill ${purchase.invoiceNumber} from ${purchase.supplier.name} was reversed, so there is no purchase left to issue a self-invoice for.`);
    }
    const today = indiaDate(this.#clock.now());
    if (input.issuedOn > today) {
      throw invalid("SELF_INVOICE_DATE_FUTURE", `A self-invoice cannot be dated later than today. Choose today or an earlier date, on or after ${purchase.receivedOn}, when it was received.`);
    }
    if (input.issuedOn < purchase.receivedOn) {
      throw invalid("SELF_INVOICE_BEFORE_RECEIPT", `The self-invoice is issued for what you received (CGST s.31(3)(f)), so it cannot be dated before ${purchase.receivedOn}, the day it reached you.`);
    }
    const financialYear = financialYearOf(input.issuedOn);
    for (let attempt = 0; ; attempt += 1) {
      const sequence = (await this.#register.lastSelfInvoiceSequence(actor.companyId, financialYear)) + 1;
      const invoice: SelfInvoice = {
        id: this.#newId(),
        companyId: actor.companyId,
        billId: purchase.billId,
        number: selfInvoiceNumber(financialYear, sequence),
        financialYear,
        sequence,
        issuedOn: input.issuedOn,
        receivedOn: purchase.receivedOn,
        supplier: purchase.supplier,
        recipient: input.recipient,
        // Rule 46(n). Goods: where their movement ends for delivery to us (IGST s.10(1)(a)) — our
        // godown. Services to a registered person: our location (IGST s.12(2)(a)). Both are the
        // buyer's State, which is how the bill's tax head was decided. Not handled: rent of property
        // in another State, whose place of supply is where the property is (IGST s.12(3)(a)).
        placeOfSupply: { stateCode: input.recipient.stateCode, stateName: input.recipient.stateName },
        interState: purchase.interState,
        lines: purchase.lines,
        taxableValuePaise: purchase.lines.reduce((total, line) => total + line.taxableValuePaise, 0n),
        cgstPaise: purchase.lines.reduce((total, line) => total + line.cgstPaise, 0n),
        sgstPaise: purchase.lines.reduce((total, line) => total + line.sgstPaise, 0n),
        igstPaise: purchase.lines.reduce((total, line) => total + line.igstPaise, 0n),
        cessPaise: purchase.lines.reduce((total, line) => total + line.cessPaise, 0n),
        issuedBy: actor.userId,
        issuedAt: this.#clock.now().toISOString(),
        idempotencyKey: input.idempotencyKey,
      };
      try {
        await this.#register.insertSelfInvoice(invoice);
      } catch (error) {
        // Two people pressing at once: the loser of the race for a number takes the next one; the
        // loser of the race for the bill gets the winner's invoice back.
        const code = (error as { code?: string }).code;
        if (code === "SELF_INVOICE_NUMBER_TAKEN" && attempt < MAX_SEQUENCE_RETRIES) continue;
        if (code === "SELF_INVOICE_ALREADY_ISSUED") {
          const winner = await this.#register.selfInvoiceFor(actor.companyId, input.billId);
          if (winner !== null) return { invoice: winner, deduplicated: true };
        }
        throw error;
      }
      await this.#audit.record({
        companyId: actor.companyId,
        actorId: actor.userId,
        at: invoice.issuedAt,
        action: "purchase.self_invoice_issued",
        subjectType: "self_invoice",
        subjectId: invoice.id,
        summary: `Self-invoice ${invoice.number} dated ${invoice.issuedOn} issued for bill ${purchase.invoiceNumber} from ${purchase.supplier.name}: ${formatPaise(taxOf(invoice.lines))} of GST payable on reverse charge.`,
        details: {
          number: invoice.number,
          billId: purchase.billId,
          supplier: purchase.supplier.name,
          issuedOn: invoice.issuedOn,
          lastDay: selfInvoiceLastDay(purchase.receivedOn),
          tax: formatPaise(taxOf(invoice.lines)),
        },
      });
      return { invoice, deduplicated: false };
    }
  }

  /**
   * Every purchase from an unregistered supplier on reverse charge, with where its self-invoice
   * stands today: issued, in good time, due within five days, its last day, or late. Newest first.
   */
  async reminders(companyId: CompanyId, today: IsoDate, isLive: (billId: string) => boolean = () => true): Promise<readonly SelfInvoiceReminder[]> {
    const purchases = (await this.#register.purchases(companyId)).filter((row) => !row.supplierRegistered && isLive(row.billId));
    const invoices = await this.#register.selfInvoices(companyId);
    return purchases.map((purchase) => {
      const invoice = invoices.find((row) => row.billId === purchase.billId) ?? null;
      return {
        billId: purchase.billId,
        supplierName: purchase.supplier.name,
        invoiceNumber: purchase.invoiceNumber,
        receivedOn: purchase.receivedOn,
        taxPaise: taxOf(purchase.lines),
        due: selfInvoiceDue(purchase.receivedOn, today, invoice?.issuedOn ?? null),
        selfInvoiceNumber: invoice?.number ?? null,
      };
    }).sort((a, b) => (a.receivedOn < b.receivedOn ? 1 : a.receivedOn > b.receivedOn ? -1 : 0));
  }
}

/** The time of supply of one registered purchase. */
export const timeOfSupplyOf = (purchase: ReverseChargePurchase, paidOn: IsoDate | null, selfInvoiceOn: IsoDate | null): RcmTimeOfSupply =>
  rcmTimeOfSupply({
    supplyKind: purchase.supplyKind,
    supplierDocumentDate: purchase.invoiceDate,
    supplierIssuesInvoice: purchase.supplierRegistered,
    receivedOn: purchase.receivedOn,
    paidOn,
    selfInvoiceOn,
    enteredInBooksOn: purchase.enteredOn,
  });

/**
 * The checks made before a reverse-charge bill is posted, so it is never posted and then refused by
 * the register:
 *  - the goods (or service) cannot have arrived after today;
 *  - one bill is one time of supply, and goods (s.12(3)) and services (s.13(3)) follow different
 *    rules, so a bill with reverse-charge lines of both is refused with a way round.
 */
export const checkReverseChargeEntry = (input: { readonly receivedOn: IsoDate; readonly today: IsoDate; readonly supplyKinds: readonly RcmSupplyKind[] }): RcmSupplyKind => {
  if (input.receivedOn > input.today) {
    throw invalid("REVERSE_CHARGE_RECEIVED_FUTURE", "The date it reached you cannot be later than today. Enter the day the goods or the service actually reached you.");
  }
  const kinds = [...new Set(input.supplyKinds)];
  if (kinds.length > 1) {
    throw invalid("REVERSE_CHARGE_GOODS_AND_SERVICES", "This bill has reverse-charge goods and reverse-charge services together. Their GST falls due on different dates (goods: CGST s.12(3); services: s.13(3)), so enter the goods as one bill and the services as another, with the same bill number and a suffix such as -A and -B. Nothing was recorded.");
  }
  return kinds[0] ?? "GOODS";
};
