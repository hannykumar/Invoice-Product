# Returns and transaction adjustments v1

Issue #45 owns linked sales credit notes and purchase debit notes. A return never edits, cancels,
or hides its original invoice. The note stores the original document and line identifiers, the
reason, actor, date, quantities, disposition, exact proportional tax snapshot, voucher, and
compliance state.

## Supported scenarios

- Full and partial sales returns reduce the customer balance through a balanced credit note.
- Full and partial purchase returns reduce the supplier balance through a balanced debit note.
- GST is reversed proportionally from the immutable original line amounts; a one-paise proration
  remainder is assigned to taxable value so the note always equals its share of the original.
- Accepted goods enter or leave usable stock. Damaged goods enter the explicitly selected damaged
  or quarantine godown. Scrapped goods are received and removed in linked movements. Replacement
  goods leave no sellable stock until the replacement is separately received.
- Repeated and concurrent requests share the original quantity ceiling and an idempotency key.
- Registered sales documents are marked `PENDING_ADJUSTMENT`; downstream e-invoice, e-way bill,
  GSTR-1/3B and ITC work consumes that explicit state instead of this module guessing a filing.
- A return dated in an open period may reference an invoice in a filed, hard-locked period. The
  original period is never reopened. A note dated inside a hard-locked period is refused; the
  ledger's reasoned override rules apply only to soft locks.

## Money and refunds

The credit or debit note changes the party subledger atomically with inventory and GST. It does
not silently move cash or bank money. If a settled customer invoice produces money owed back, the
user must approve a separate outbound `PAYMENT` through the receivables/payables contract (#20),
using its bank account, allocation, idempotency, and audit controls. Likewise, supplier money
received back is a separately approved `RECEIPT`. This separation prevents a goods-return click
from initiating an unreviewed bank refund.

## Assumptions and known limits

- Physical reverse-logistics tracking is outside this contract. A replacement disposition records
  that sellable stock has left; delivery and receipt of the replacement remain separate events.
- E-way bill (#27), GST return workspace (#30), and ITC reconciliation (#31) own submission and
  filing. Until they consume the note, `PENDING_ADJUSTMENT` is intentionally visible and auditable.
- A reverse-charge purchase return is supported. A reverse-charge bill with GST capitalised as
  ineligible ITC is refused with `RETURN_RCM_INELIGIBLE_REVIEW_REQUIRED` because the correct cost
  treatment cannot be inferred safely.
- Batch and serial facts must be supplied where the inventory master requires them. Missing facts
  refuse the whole transaction; no ledger note or stock movement remains.

## Persistence and API

`return_notes` and `return_note_lines` are tenant-isolated by company keys and forced PostgreSQL
row-level security. `GET /api/returns/documents` lists eligible originals. The preview and record
commands are `POST /api/returns/preview` and `POST /api/returns/record`; both derive company and
permissions from the authenticated session. Preview is read-only and record is atomic and
idempotent.
