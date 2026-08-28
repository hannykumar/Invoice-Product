<!-- GENERATED FILE — do not edit by hand.
     Source: docs/product/spec/glossary.json
     Regenerate: node --experimental-strip-types tools/spec-docs/generate.ts -->

# Financial and GST glossary

Issue [#1](./README.md) defines these words once so that every agent, API field and screen means the same thing by them.

Glossary version **1.0.0**, effective from **2026-01-01**.

Each entry gives the word we use in code and contracts, the plain sentence we show a business owner, what it means, and what it must never be confused with.

## Account

`account`

- **Plain (en-IN)**: A named pocket in your books
- **Plain (hi-IN)**: Hisaab ka ek khaana
- **Means**: A named bucket that collects journal lines, such as Cash, Bank, Sales, Purchases, Output CGST, or one specific customer. Every account has a type that decides its normal side.
- **Example**: Cash in hand, HDFC Current Account, Sales - Goods.
- **Also called**: ledger account, head
- **Not the same as**: party

## Account type

`account-type`

- **Plain (en-IN)**: What kind of pocket it is
- **Plain (hi-IN)**: Khaate ka prakaar
- **Means**: One of ASSET, LIABILITY, EQUITY, INCOME, EXPENSE. The type fixes the normal balance side and where the account appears in reports.
- **Example**: Sales is INCOME, so it normally has a credit balance and appears in profit and loss.
- **Also called**: account class
- **Not the same as**: voucher-type

## Ageing

`ageing`

- **Plain (en-IN)**: How long money has been due
- **Plain (hi-IN)**: Kitne dinon se baaki hai
- **Means**: A breakdown of outstanding balances into age buckets counted from the due date, for example 0-30, 31-60, 61-90 and over 90 days.
- **Example**: Rs 20,000 of ABC's dues is more than 90 days old.
- **Also called**: aging, outstanding analysis

## Allocation

`allocation`

- **Plain (en-IN)**: Linking a payment to the bills it settles
- **Plain (hi-IN)**: Payment ko bill se jodna
- **Means**: The recorded link between a payment and one or more invoices, with the exact amount applied to each. Unallocated money stays visible as on-account balance instead of being guessed.
- **Example**: A Rs 50,000 cheque is allocated Rs 30,000 to invoice 41 and Rs 20,000 to invoice 42.
- **Also called**: settlement, adjustment, knock-off

## Amendment

`amendment`

- **Plain (en-IN)**: Replacing an entry with a corrected version
- **Plain (hi-IN)**: Sudhaari hui entry se badalna
- **Means**: A controlled correction that reverses the original voucher and posts a corrected one, keeping both linked to the same source document and to each other.
- **Example**: The invoice had the wrong rate; the amendment reverses it and posts the corrected invoice with a new version number.
- **Also called**: revision
- **Not the same as**: reversal

## Approval

`approval`

- **Plain (en-IN)**: A person saying yes before something important happens
- **Plain (hi-IN)**: Zaroori kaam se pehle kisi ki haan
- **Means**: A required human decision, with permissions and a preview, before a sensitive action such as finalising an invoice, overriding stock or filing a return.
- **Example**: The manager approves a sale that exceeds the customer's credit limit.
- **Also called**: authorisation, sign-off
- **Not the same as**: exception-queue

## Audit trail

`audit-trail`

- **Plain (en-IN)**: The permanent record of who did what and when
- **Plain (hi-IN)**: Kisne kya kab kiya, ka permanent record
- **Means**: An append-only history of material actions with actor, timestamp, inputs, outputs, decision and any override reason. Secrets are never written into it.
- **Example**: Priya finalised invoice 42 at 11:04 on 12 May 2026 and overrode the credit limit with the reason 'owner approved on call'.
- **Also called**: activity log, history

## Available quantity

`available-quantity`

- **Plain (en-IN)**: How much you can still sell right now
- **Plain (hi-IN)**: Abhi kitna bech sakte hain
- **Means**: Physical quantity minus quantity reserved by drafts and pending approvals. Sales are checked against available quantity, not physical quantity.
- **Example**: 100 boxes physically present with 70 reserved by a pending invoice leaves 30 available.
- **Also called**: free stock
- **Not the same as**: physical-quantity

## Batch

`batch`

- **Plain (en-IN)**: A specific lot of the same item
- **Plain (hi-IN)**: Ek hi item ka alag lot
- **Means**: A tracked group of units of an item sharing a lot number, manufacture or expiry date. Batches keep cost and expiry separate within one item.
- **Example**: Apple boxes from 2 May expire earlier than those from 9 May.
- **Also called**: lot
- **Not the same as**: item

## Branch

`branch`

- **Plain (en-IN)**: A shop, godown or office of your business
- **Plain (hi-IN)**: Aapke business ki dukaan, godown ya office
- **Means**: A place of business inside one company. Branches share the company's books but can have their own invoice number series, stock location and users.
- **Example**: Karol Bagh shop and Narela godown are two branches of one company.
- **Also called**: place of business
- **Not the same as**: company, warehouse

## Cess

`cess`

- **Plain (en-IN)**: An extra tax on some specific goods
- **Plain (hi-IN)**: Kuch khaas saaman par extra tax
- **Means**: GST compensation cess charged in addition to GST on notified goods, either as a percentage, a fixed amount per unit, or the higher of the two.
- **Example**: Aerated drinks carry cess over and above the GST rate.
- **Also called**: compensation cess

## CGST

`cgst`

- **Plain (en-IN)**: The central government's half of GST on a sale inside your state
- **Plain (hi-IN)**: Apne rajya ki bikri par kendra ka hissa
- **Means**: Central Goods and Services Tax, charged together with SGST or UTGST when the supplier and the place of supply are in the same state or union territory.
- **Example**: On a Rs 1,000 intra-state sale at 18 percent, CGST is Rs 90.
- **Not the same as**: igst

## Chart of accounts

`chart-of-accounts`

- **Plain (en-IN)**: The list of all pockets in your books
- **Plain (hi-IN)**: Sabhi khaaton ki list
- **Means**: The complete, company-specific tree of accounts with their types and codes. The product seeds an India-ready default chart during onboarding, which the business may extend.
- **Example**: 1000 Assets > 1100 Cash and Bank > 1110 Cash in hand.
- **Also called**: COA, account master

## Company

`company`

- **Plain (en-IN)**: Your business
- **Plain (hi-IN)**: Aapka business
- **Means**: One legally distinct business whose books, stock and filings are kept completely separate from every other business in the product. Every record in the product belongs to exactly one company.
- **Example**: Sharma Fruit Traders and Sharma Logistics are two companies even if the same person owns both.
- **Also called**: tenant, firm
- **Not the same as**: branch

## Credit

`credit`

- **Plain (en-IN)**: Value going out or owed by you
- **Plain (hi-IN)**: Aapse jaane wala / aapka dena
- **Means**: The right side of an entry. Credits increase income, liabilities and equity and decrease assets and expenses.
- **Example**: Sales income of Rs 1,000 is credited when you raise the invoice.
- **Also called**: Cr
- **Not the same as**: debit, credit-limit, credit-note

## Credit limit

`credit-limit`

- **Plain (en-IN)**: The most a customer may owe you at one time
- **Plain (hi-IN)**: Customer se zyada se zyada kitna baaki rakh sakte hain
- **Means**: A per-customer ceiling on total outstanding plus pending transactions. Crossing it warns or blocks according to policy and can only be overridden with permission and a reason.
- **Example**: ABC's limit is Rs 1,00,000 and a new Rs 60,000 invoice on Rs 50,000 outstanding crosses it.
- **Also called**: credit ceiling
- **Not the same as**: credit, credit-note

## Credit note

`credit-note`

- **Plain (en-IN)**: You return money or value to a customer
- **Plain (hi-IN)**: Customer ko wapas dena
- **Means**: A document that reduces what a customer owes you, used for sales returns, rate reductions and post-sale discounts. It reverses income, tax and, when goods come back, stock.
- **Example**: ABC Traders returned 10 boxes, so a credit note reduces their dues by the value of 10 boxes plus tax.
- **Also called**: CN, sales return note
- **Not the same as**: debit-note, credit, credit-limit

## Customer

`customer`

- **Plain (en-IN)**: Someone who buys from you
- **Plain (hi-IN)**: Jo aapse kharidta hai
- **Means**: A party in the role of buyer. Amounts a customer has not yet paid you are receivables.
- **Example**: ABC Traders bought 70 boxes of apples and still owes Rs 50,000.
- **Also called**: buyer, debtor
- **Not the same as**: supplier

## Debit

`debit`

- **Plain (en-IN)**: Value coming in or owed to you
- **Plain (hi-IN)**: Aapko milne wala / aata hua
- **Means**: The left side of an entry. Debits increase assets and expenses and decrease income, liabilities and equity.
- **Example**: When ABC Traders owes you Rs 1,180, their account is debited by Rs 1,180.
- **Also called**: Dr
- **Not the same as**: credit

## Debit note

`debit-note`

- **Plain (en-IN)**: You reduce what you owe a supplier
- **Plain (hi-IN)**: Supplier ko kam dena
- **Means**: A document that reduces what you owe a supplier, used for purchase returns, rate corrections and rejected goods.
- **Example**: You returned 5 damaged boxes to Nashik Farms and raised a debit note.
- **Also called**: DN, purchase return note
- **Not the same as**: credit-note

## Double entry

`double-entry`

- **Plain (en-IN)**: Every entry has two sides that must match
- **Plain (hi-IN)**: Har entry ke do pehlu, dono barabar
- **Means**: The rule that the total of debits equals the total of credits in every voucher. The product refuses to post a voucher that does not balance to zero.
- **Example**: Money went to the customer's account (debit 1,180) and came from sales (1,000) plus tax owed to government (180).
- **Also called**: double-entry bookkeeping

## E-invoice

`e-invoice`

- **Plain (en-IN)**: An invoice registered with the government portal
- **Plain (hi-IN)**: Sarkari portal par registered invoice
- **Means**: An invoice whose details are reported to the Invoice Registration Portal, which returns an Invoice Reference Number and a signed QR code. A styled PDF is not an e-invoice by itself.
- **Example**: Invoice 42 received IRN 6f2c... and a QR code that must be printed.
- **Also called**: IRN invoice
- **Not the same as**: sales-invoice

## E-way bill

`e-way-bill`

- **Plain (en-IN)**: The government permit needed to move goods
- **Plain (hi-IN)**: Maal le jaane ka sarkari permit
- **Means**: An electronic document required for the movement of goods above notified value and distance conditions, carrying transporter and vehicle details and a validity period.
- **Example**: Moving Rs 80,000 of apples to another state generally needs an e-way bill before the truck leaves.
- **Also called**: EWB
- **Not the same as**: e-invoice

## Effective date

`effective-date`

- **Plain (en-IN)**: The date from which a rule or rate applies
- **Plain (hi-IN)**: Niyam ya rate kis taarikh se laagu hai
- **Means**: The date range for which a rate, threshold or rule is valid. Transactions are always evaluated with the rule effective on their own document date.
- **Example**: A rate change from 1 July does not change a bill dated 30 June.
- **Also called**: applicable from

## Exception queue

`exception-queue`

- **Plain (en-IN)**: The list of things the app could not decide safely
- **Plain (hi-IN)**: Jo app khud tay nahin kar saka, uski list
- **Means**: A worklist of transactions the product refused to complete because a fact was missing, confidence was low or facts contradicted each other. Items wait for a person; they are never auto-posted.
- **Example**: The place of supply is missing, so the invoice waits in the exception queue instead of guessing IGST or CGST.
- **Also called**: review queue, needs attention
- **Not the same as**: approval

## Fiscal period

`fiscal-period`

- **Plain (en-IN)**: A month or year of your books
- **Plain (hi-IN)**: Hisaab ka mahina ya saal
- **Means**: A dated window of the books that can be open, soft-locked or hard-locked. India's financial year runs 1 April to 31 March and is named like 2026-27.
- **Example**: April 2026 belongs to financial year 2026-27.
- **Also called**: accounting period, financial year, FY
- **Not the same as**: tax-period

## GSTIN

`gstin`

- **Plain (en-IN)**: The 15-character GST number of a business
- **Plain (hi-IN)**: Business ka 15 akshar ka GST number
- **Means**: The Goods and Services Tax Identification Number. The first two characters are the state code, the next ten are the PAN, and the last is a checksum character the product validates.
- **Example**: 07AABCU9603R1ZM is registered in Delhi (state code 07).
- **Also called**: GST number
- **Not the same as**: pan

## GSTR-1

`gstr-1`

- **Plain (en-IN)**: The monthly or quarterly list of your sales sent to the GST portal
- **Plain (hi-IN)**: Apni bikri ki list jo GST portal par jaati hai
- **Means**: The outward-supply return that reports your sales invoices, credit notes and debit notes for a tax period.
- **Example**: April's 42 sales invoices are reported in April's GSTR-1.
- **Not the same as**: gstr-3b

## GSTR-2B

`gstr-2b`

- **Plain (en-IN)**: The government's statement of purchases your suppliers reported
- **Plain (hi-IN)**: Supplier ne jo bill report kiye, unki sarkari list
- **Means**: A static, auto-drafted statement of input tax credit available for a tax period, generated from what your suppliers filed. It is compared with your own purchase records.
- **Example**: One supplier did not file, so their Rs 9,000 credit is not in GSTR-2B and is held back.
- **Also called**: IMS statement

## GSTR-3B

`gstr-3b`

- **Plain (en-IN)**: The summary return where you pay GST
- **Plain (hi-IN)**: Summary return jismein GST bharte hain
- **Means**: The summary return that declares total outward tax, input tax credit claimed and the net GST paid for a tax period.
- **Example**: April's GSTR-3B shows Rs 30,000 output tax less Rs 18,000 credit, so Rs 12,000 is paid.
- **Not the same as**: gstr-1

## HSN code

`hsn`

- **Plain (en-IN)**: The government's code for a type of goods
- **Plain (hi-IN)**: Saaman ka sarkari code
- **Means**: Harmonised System of Nomenclature code that classifies goods for GST. The number of digits you must print depends on your turnover.
- **Example**: Fresh apples are HSN 0808.
- **Also called**: HSN
- **Not the same as**: sac

## Idempotency key

`idempotency-key`

- **Plain (en-IN)**: A tag that stops the same action happening twice
- **Plain (hi-IN)**: Ek hi kaam do baar hone se rokne wala tag
- **Means**: A caller-supplied unique key for a command. If the same key is sent again, the product returns the original result instead of creating a second record.
- **Example**: The app retries after a network failure; the invoice is created once, not twice.
- **Also called**: request key, dedupe key

## IGST

`igst`

- **Plain (en-IN)**: One combined GST for a sale to another state
- **Plain (hi-IN)**: Dusre rajya ki bikri par ek hi GST
- **Means**: Integrated Goods and Services Tax, charged as a single amount when the supplier's state and the place of supply differ, and on imports and supplies treated as inter-state.
- **Example**: On a Rs 1,000 inter-state sale at 18 percent, IGST is Rs 180.
- **Not the same as**: cgst, sgst

## Input tax credit

`input-tax-credit`

- **Plain (en-IN)**: GST you already paid on purchases that reduces your GST bill
- **Plain (hi-IN)**: Kharid par diya GST jo aapka GST kam karta hai
- **Means**: Credit for GST paid on business purchases, which is set off against GST collected on sales, subject to eligibility conditions and the supplier having reported the invoice.
- **Example**: Rs 18,000 GST paid on purchases reduces Rs 30,000 GST collected to Rs 12,000 payable.
- **Also called**: ITC

## Invoice value

`invoice-value`

- **Plain (en-IN)**: The total the customer must pay
- **Plain (hi-IN)**: Customer ko kitna dena hai
- **Means**: Taxable value plus all GST and cess plus any non-taxable charges, after round-off.
- **Example**: Taxable value Rs 1,000 plus GST Rs 180 gives an invoice value of Rs 1,180.
- **Also called**: grand total, bill amount
- **Not the same as**: taxable-value

## IRN

`irn`

- **Plain (en-IN)**: The government's unique reference for a registered invoice
- **Plain (hi-IN)**: Registered invoice ka sarkari unique number
- **Means**: Invoice Reference Number returned by the Invoice Registration Portal. Generating it twice for the same invoice is a duplicate the product must prevent.
- **Example**: IRN is printed with the QR code on the invoice.

## Item

`item`

- **Plain (en-IN)**: A thing you buy or sell
- **Plain (hi-IN)**: Jo cheez aap bechte ya kharidte hain
- **Means**: A good or a service you trade in, with a stock-keeping unit, a base unit of measure and a tax classification (HSN for goods, SAC for services).
- **Example**: Apple Box 10kg, HSN 0808, base unit BOX.
- **Also called**: product, stock item, SKU
- **Not the same as**: batch

## Journal line

`journal-line`

- **Plain (en-IN)**: One line of a money entry
- **Plain (hi-IN)**: Entry ki ek line
- **Means**: One debit or credit against one account inside a voucher. A line never exists outside a voucher and is never edited after the voucher is final.
- **Example**: Output CGST 90.00 credit is one journal line of a sale voucher.
- **Also called**: ledger line, posting line
- **Not the same as**: voucher

## On account

`on-account`

- **Plain (en-IN)**: Money received but not yet matched to a bill
- **Plain (hi-IN)**: Paisa aaya, bill se jodna baaki
- **Means**: A payment held against a party without being applied to specific invoices. The product never guesses which invoice it settles.
- **Example**: ABC paid Rs 10,000 in advance before any invoice existed.
- **Also called**: advance, unapplied receipt

## Opening balance

`opening-balance`

- **Plain (en-IN)**: What you already had when you started using the app
- **Plain (hi-IN)**: App shuru karte waqt jo pehle se tha
- **Means**: The balances of accounts, parties and stock carried into the product on the go-live date, posted as a single balanced opening voucher.
- **Example**: On 1 April 2026 you already had Rs 2,00,000 cash and ABC owed you Rs 40,000.
- **Also called**: opening stock, carry forward

## Output tax

`output-tax`

- **Plain (en-IN)**: GST you collected from customers
- **Plain (hi-IN)**: Customer se liya GST
- **Means**: GST charged on your sales and held as a liability until it is paid to the government.
- **Example**: The Rs 180 GST on a Rs 1,180 invoice is output tax.
- **Also called**: output GST, GST payable
- **Not the same as**: input-tax-credit

## Override

`override`

- **Plain (en-IN)**: Going ahead despite a warning, with a recorded reason
- **Plain (hi-IN)**: Warning ke baawajood aage badhna, kaaran likhkar
- **Means**: An authorised decision to proceed past a warning or block. It always requires a permission, a typed reason and an audit entry. Some blocks cannot be overridden at all.
- **Example**: Selling below the negative-stock limit is overridden by the owner with the reason 'goods received, bill pending'.
- **Also called**: force, bypass

## PAN

`pan`

- **Plain (en-IN)**: The 10-character income-tax number
- **Plain (hi-IN)**: 10 akshar ka income tax number
- **Means**: Permanent Account Number issued by the income-tax department. It is embedded inside a GSTIN.
- **Example**: AABCU9603R.
- **Not the same as**: gstin

## Party

`party`

- **Plain (en-IN)**: A customer or a supplier
- **Plain (hi-IN)**: Customer ya supplier
- **Means**: Any external person or business you buy from or sell to. A party can be a customer, a supplier, or both.
- **Example**: ABC Traders buys apples from you and also sells you crates, so ABC Traders is one party with both roles.
- **Also called**: ledger party, account holder
- **Not the same as**: user

## Payable

`payable`

- **Plain (en-IN)**: Money you still owe suppliers
- **Plain (hi-IN)**: Supplier ko dena baaki
- **Means**: The unpaid balance of approved purchase invoices after subtracting payments made, debit notes and approved adjustments.
- **Example**: You still owe Nashik Farms Rs 30,000.
- **Also called**: sundry creditors, accounts payable
- **Not the same as**: receivable

## Period lock

`period-lock`

- **Plain (en-IN)**: Closing old months so they cannot change
- **Plain (hi-IN)**: Purane mahine band karna
- **Means**: A control that prevents new or changed postings dated inside a closed period. A soft lock can be overridden by an authorised user with a recorded reason; a hard lock cannot be overridden at all.
- **Example**: After GST for April is filed, April is hard-locked and a backdated sale is refused.
- **Also called**: book closure, period close

## Physical quantity

`physical-quantity`

- **Plain (en-IN)**: How much is actually lying in the godown
- **Plain (hi-IN)**: Godown mein asal mein kitna hai
- **Means**: The quantity actually held, derived from posted stock movements only.
- **Example**: 100 boxes are in the godown even though 70 are promised to a customer.
- **Also called**: stock on hand, closing stock
- **Not the same as**: available-quantity

## Place of supply

`place-of-supply`

- **Plain (en-IN)**: The state the sale counts as happening in
- **Plain (hi-IN)**: Bikri kis rajya ki maani jayegi
- **Means**: The state whose GST applies to a supply, decided by deterministic rules from the type of supply and the recipient's details. It decides whether CGST+SGST or IGST applies. It is never guessed.
- **Example**: Goods delivered to a Haryana address from Delhi have Haryana as the place of supply, so IGST applies.
- **Also called**: POS
- **Not the same as**: branch

## Proforma invoice

`proforma`

- **Plain (en-IN)**: A draft bill sent before payment
- **Plain (hi-IN)**: Payment se pehle bheja gaya draft bill
- **Means**: A document that looks like an invoice and is used to request advance payment, but is not a tax invoice. It creates no ledger entry, no tax liability and no invoice number in the legal series.
- **Example**: You send a proforma for Rs 1,00,000 so the customer can arrange the transfer before dispatch.
- **Also called**: proforma
- **Not the same as**: sales-invoice, quotation

## Purchase invoice

`purchase-invoice`

- **Plain (en-IN)**: The bill your supplier gives you
- **Plain (hi-IN)**: Supplier se aaya bill
- **Means**: A supplier's bill that you record. When approved it increases stock, records input tax credit and creates a payable to the supplier. It never creates a sale.
- **Example**: Nashik Farms bill NF/1187 for 100 boxes of apples increases stock by 100 boxes.
- **Also called**: supplier invoice, inward invoice
- **Not the same as**: sales-invoice

## Quotation

`quotation`

- **Plain (en-IN)**: A price offer, not a bill
- **Plain (hi-IN)**: Rate ka offer, bill nahin
- **Means**: A priced offer sent to a customer before a sale. It creates no entry in the books, no tax liability and no stock movement, and it may be converted into a sales invoice.
- **Example**: You quote ABC Traders Rs 800 per box; nothing is recorded in your books until they order.
- **Also called**: estimate, quote
- **Not the same as**: sales-invoice, proforma

## Receivable

`receivable`

- **Plain (en-IN)**: Money customers still owe you
- **Plain (hi-IN)**: Customer se lena baaki
- **Means**: The unpaid balance of finalised sales invoices after subtracting accepted payments, credit notes and approved write-offs.
- **Example**: Customer still owes Rs 50,000 on a Rs 1,00,000 invoice after paying Rs 50,000.
- **Also called**: sundry debtors, accounts receivable, outstanding
- **Not the same as**: payable

## Reservation

`reservation`

- **Plain (en-IN)**: Stock held aside for a draft bill
- **Plain (hi-IN)**: Draft bill ke liye rakha gaya maal
- **Means**: A temporary hold on quantity created when a sale is drafted or sent for approval, released on cancellation, expiry or conversion to a posted movement.
- **Example**: A draft invoice for 70 boxes reserves them so a second user cannot sell the same 70.
- **Also called**: hold, commitment

## Reversal

`reversal`

- **Plain (en-IN)**: Undoing an entry by making an opposite entry
- **Plain (hi-IN)**: Ulti entry se sudhaarna
- **Means**: The only way to undo a final voucher. A new voucher with mirrored debits and credits is posted and both vouchers stay visible forever. Nothing is deleted.
- **Example**: A wrongly posted Rs 5,000 payment is reversed on 12 May and the correct entry is posted separately.
- **Also called**: contra entry, cancellation entry
- **Not the same as**: amendment

## Reverse charge

`reverse-charge`

- **Plain (en-IN)**: You pay the GST instead of your supplier
- **Plain (hi-IN)**: GST supplier ke bajaay aap bharte hain
- **Means**: A treatment where the recipient, not the supplier, must pay GST to the government on notified supplies or purchases from unregistered persons.
- **Example**: Freight from an unregistered goods transport agency may make you liable to pay GST directly.
- **Also called**: RCM

## Round-off

`round-off`

- **Plain (en-IN)**: The few paise added or removed to reach a neat total
- **Plain (hi-IN)**: Total seedha karne ke liye chhota adjustment
- **Means**: The small difference posted to a dedicated account so the invoice total reaches the configured rounding, keeping the voucher balanced.
- **Example**: Rs 1,179.60 is shown as Rs 1,180 with Rs 0.40 posted to round-off.
- **Also called**: rounding adjustment

## Rule version

`rule-version`

- **Plain (en-IN)**: Which version of the rulebook decided this
- **Plain (hi-IN)**: Kis version ke niyam se faisla hua
- **Means**: The identifier of the deterministic rule set used for a decision, stored with the decision so the same result can be reproduced later.
- **Example**: The e-way decision on 12 May 2026 used rule set gst-ewb 2026.04.01.
- **Also called**: ruleset version

## SAC code

`sac`

- **Plain (en-IN)**: The government's code for a type of service
- **Plain (hi-IN)**: Service ka sarkari code
- **Means**: Services Accounting Code that classifies services for GST.
- **Example**: Goods transport by road is SAC 9965.
- **Also called**: SAC
- **Not the same as**: hsn

## Sales invoice

`sales-invoice`

- **Plain (en-IN)**: The bill you give a customer
- **Plain (hi-IN)**: Customer ko diya gaya bill
- **Means**: The legal document for a sale. When finalised it gets a permanent number, reduces stock, records tax payable and creates a receivable from the customer.
- **Example**: Invoice INV/2026-27/00042 to ABC Traders for 70 boxes of apples.
- **Also called**: tax invoice, bill, sale bill
- **Not the same as**: purchase-invoice, proforma, quotation

## SGST

`sgst`

- **Plain (en-IN)**: The state government's half of GST on a sale inside your state
- **Plain (hi-IN)**: Apne rajya ki bikri par rajya ka hissa
- **Means**: State Goods and Services Tax, charged with CGST on supplies inside one state.
- **Example**: On a Rs 1,000 intra-state sale at 18 percent, SGST is Rs 90.
- **Not the same as**: utgst, igst

## Stock movement

`stock-movement`

- **Plain (en-IN)**: One in or out of goods
- **Plain (hi-IN)**: Maal ka ek aana ya jaana
- **Means**: An append-only record of quantity entering or leaving a warehouse for an item, batch and unit, always linked to its source document. Stock on hand is the sum of movements, never a stored number that is edited.
- **Example**: Purchase of 100 boxes is one movement in; sale of 70 boxes is one movement out; 30 remain.
- **Also called**: stock ledger entry, inventory transaction

## Supplier

`supplier`

- **Plain (en-IN)**: Someone you buy from
- **Plain (hi-IN)**: Jisse aap kharidte hain
- **Means**: A party in the role of seller to you. Amounts you have not yet paid a supplier are payables.
- **Example**: Nashik Farms sold you 100 boxes of apples and you still owe Rs 80,000.
- **Also called**: vendor, creditor
- **Not the same as**: customer

## Tax period

`tax-period`

- **Plain (en-IN)**: The month or quarter a return covers
- **Plain (hi-IN)**: Return kis mahine ya quarter ka hai
- **Means**: The GST return period a transaction falls into, decided by its document date and the company's filing frequency.
- **Example**: An invoice dated 30 April 2026 belongs to the April 2026 tax period for a monthly filer.
- **Also called**: return period, filing period
- **Not the same as**: fiscal-period

## Tax-inclusive price

`tax-inclusive-price`

- **Plain (en-IN)**: The price already contains GST
- **Plain (hi-IN)**: Rate mein GST shaamil hai
- **Means**: A rate that already includes GST. The product works the tax backwards out of it using a fixed formula and shows both the taxable value and the tax.
- **Example**: Rs 118 inclusive at 18 percent means Rs 100 taxable value and Rs 18 GST.
- **Also called**: MRP-style pricing, inclusive rate

## Taxable value

`taxable-value`

- **Plain (en-IN)**: The amount tax is calculated on
- **Plain (hi-IN)**: Jis rakam par tax lagta hai
- **Means**: The value of the supply after discounts and before GST. Freight and other charges that form part of the supply are included in it.
- **Example**: 70 boxes at Rs 800 less 5 percent discount gives a taxable value of Rs 53,200.
- **Also called**: assessable value, net amount
- **Not the same as**: invoice-value

## Unit of measure

`unit-of-measure`

- **Plain (en-IN)**: How you count the item
- **Plain (hi-IN)**: Item kis mein ginte hain
- **Means**: The countable unit for an item, for example BOX, KG, PCS, LTR. Alternate units convert to the base unit using a fixed, recorded factor.
- **Example**: 1 BOX = 10 KG, so selling 7 BOX reduces 70 KG of stock.
- **Also called**: UOM, unit
- **Not the same as**: batch

## User

`user`

- **Plain (en-IN)**: A person who logs in to the app
- **Plain (hi-IN)**: App mein login karne wala vyakti
- **Means**: A person with a login who acts inside one or more companies. A user has roles and permissions per company and every action they take is recorded against them.
- **Example**: Priya is a billing user at the Karol Bagh shop and can create invoices but not reopen a closed month.
- **Also called**: operator, staff member
- **Not the same as**: party

## UTGST

`utgst`

- **Plain (en-IN)**: The union-territory version of SGST
- **Plain (hi-IN)**: Union territory ke liye SGST jaisa
- **Means**: Union Territory Goods and Services Tax, charged with CGST for supplies inside a union territory without its own legislature.
- **Example**: A supply within Chandigarh uses CGST and UTGST.
- **Not the same as**: sgst

## Voucher

`voucher`

- **Plain (en-IN)**: One money entry in your books
- **Plain (hi-IN)**: Hisaab ki ek entry
- **Means**: A single, balanced financial event recorded in the ledger. Every voucher has a type (sale, purchase, receipt, payment, journal, credit note, debit note), a date, a company, and two or more journal lines whose debits equal credits.
- **Example**: Finalising a Rs 1,180 sale creates one sale voucher with three lines: customer +1,180 debit, sales 1,000 credit, output GST 180 credit.
- **Also called**: accounting entry, posting
- **Not the same as**: sales-invoice, purchase-invoice, journal-line

## Voucher type

`voucher-type`

- **Plain (en-IN)**: What kind of entry it is
- **Plain (hi-IN)**: Entry ka prakaar
- **Means**: One of SALE, PURCHASE, RECEIPT, PAYMENT, JOURNAL, CREDIT_NOTE, DEBIT_NOTE, OPENING_BALANCE, REVERSAL. The type decides which posting template and permissions apply.
- **Example**: Money received from a customer is a RECEIPT, not a SALE.
- **Not the same as**: account-type

## Warehouse

`warehouse`

- **Plain (en-IN)**: A place where stock is kept
- **Plain (hi-IN)**: Jahan maal rakha hai
- **Means**: A stock location belonging to a company and usually to a branch. Stock balances are always per warehouse.
- **Example**: Narela godown and the shop counter are two warehouses.
- **Also called**: godown, store, location
- **Not the same as**: branch
