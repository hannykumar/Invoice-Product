const copy = {
  "en-IN": {
    // Issue #305 / #311 — the four-slide sale and the checks inside the bill.
    slideItems: "What is the customer buying?", slideCustomer: "Who is buying?", slidePayment: "How are they paying?", slideTransport: "How are the goods going?", slideExport: "Export details", slideShipTo: "Where do the goods go?", slideBack: "Back", slideNext: "Next", makeBill: "Make bill", stepOf: "Step {step} of {count}: {title}", newItemButton: "+ New item", chargesSection: "Freight or other charges", customerAll: "All customers", newCustomerQuick: "+ New customer", newCustomerQuickPlaceholder: "Type GST number or mobile", newCustomerQuickGo: "Add", newCustomerQuickHelp: "A GST number fills in their state. Add their name and address once.", deliverElsewhere: "Deliver somewhere else", customerOwes: "owes {amount}", payUdhaar: "Udhaar", payPart: "Part paid", payCheque: "Cheque", payChequeNote: "Cheque: make the bill as Udhaar, then enter the cheque in Money received when it comes.", payToday: "Today", fifteenDays: "Within 15 days", udhaarDays: "Pay within", paidNowAmount: "Paid now", billSummaryLabel: "The bill", transportEwayNote: "With the vehicle number, the e-way bill is raised by itself when you make the bill. Without it, the bill waits on Home until the vehicle is known.", oneLess: "One less", oneMore: "One more", lineFacts: "GST {rate}% · {stock} left", lineFactsGst: "GST {rate}%", checkEwayNeeded: "e-way bill needed — raised after you make the bill", checkEwayNotNeeded: "No e-way bill needed", checkEinvoiceAuto: "e-invoice will be sent by itself", checkEinvoiceNotNeeded: "No e-invoice needed", vehicleFound: "{vehicle} is on the transport department's record.", vehicleNotFound: "The transport department has no vehicle numbered {vehicle}. Check the number before the goods leave.", vehicleNotChecked: "{vehicle} could not be checked just now. The bill can still be made.", doneEwayRaised: "E-way bill {number} raised by itself · valid until {valid}", doneEwayWaiting: "These goods need an e-way bill. It is on Home until the vehicle is known.", doneEwayFailed: "The e-way bill was not raised: {reason} It is on Home to try again.", supplierCheckFine: "GST number active, filing on time", supplierCheckFailed: "The supplier check could not run just now. The bill can still be entered.", purchaseCheckLine: "Purchase check (GSTR-2B): {line}",
    // Issues #312 and #303 — the sale review's two lines, and the #design page.
    reviewTurnoverUnknown: "We don't know yet whether you need e-invoices: Business details does not say whether your turnover has been over ₹5 crore. Answer once in Business details. This bill can still be issued now.", reviewEinvoiceLate: "This bill needs a government e-invoice number, but it is too old for the portal to take it.", designEyebrow: "Owner only", designTitle: "How Karobar looks", designHelp: "Colours, words, buttons, chips, the money card, a bill slide and the bottom bar, in English and Hindi side by side.", designOwnerOnly: "Only the owner of the shop can open this page.", designTheme: "Colours:", designThemeDevice: "Like this device", designThemeLight: "Light", designThemeDark: "Dark", dsLanguage: "English", dsButtons: "Buttons: one marigold main action per screen", dsMakeBill: "Make bill", dsSave: "Save", dsBack: "Back", dsLater: "Do it later", dsChips: "Status chips: colour means status only", dsPaid: "Paid", dsDue: "Due in 7 days", dsLate: "12 days late", dsWalkIn: "Walk-in customer", dsMoneyCard: "The money card (your shop today)", dsToCollect: "To collect from customers", dsSalesToday: "Sales today", dsToPay: "To pay suppliers", dsSlide: "A bill slide: one decision, the total always visible", dsStepItems: "What is being sold?", dsStepCustomer: "Who is buying?", dsStepPayment: "How are they paying?", dsStepDone: "Bill made", dsFineLine: "Karnataka sale · CGST + SGST · no e-way bill needed", dsCustomerPays: "Customer pays", dsNext: "Next", dsAgain: "Start again", dsBottomBar: "The bottom bar on a phone", dsHome: "Home", dsKhata: "Khata", dsBill: "Bill", dsItems: "Items", dsMore: "More",
    skip: "Skip to main content", brandSubtitle: "Bills, stock and GST", navHome: "Home", navSale: "Sale", navPurchase: "Purchase", navPayment: "Money received", navMoney: "Money", navMore: "More", navStock: "What is in the godown", navGroupBuying: "Buying", navGroupStock: "Stock", navGroupSelling: "Selling", navGroupGst: "GST", navGroupBooks: "Books", navGroupSettings: "Settings", navReturns: "Returns", navActivity: "Activity", navReports: "Reports", navSetup: "Set up a business", primaryNavigation: "Primary navigation", companyHome: "Karobar home", workspaceNavigation: "Main menu", menuOpen: "Open navigation", notifications: "Notifications", signedIn: "Signed in as Hanny Kumar", businessSummary: "Business summary", mobileNavigation: "Mobile navigation",
    deviceReady: "Draft protection is on", draftProtection: "Your unfinished work stays on this device.", companyLocation: "Delhi · Main shop", language: "Language",
    today: "Today", welcome: "Good to see you, Hanny", welcomeBody: "How your shop is doing today.", newSale: "New sale",
    salesToday: "Sales today", salesChange: "12% more than yesterday", customersOwe: "Money customers owe you", fromCustomers: "Across 8 customers", purchasesMonth: "Purchases this month", purchaseCount: "14 supplier bills", needsAttention: "Needs your attention", attentionBody: "1 urgent · 2 to review",
    recentActivity: "Recent activity", recentBody: "Your latest bills and payments", viewAll: "View all", saleIssued: "Sale issued · 11:42 AM", purchaseFrom: "Purchase from Fresh Farms", purchaseSaved: "Waiting for your review · 10:58 AM", paymentFrom: "Payment from Gupta Mart", done: "Done", waiting: "Waiting", recorded: "Recorded",
    yourAttention: "Your attention", attentionHelp: "Clear these before they hold up work", lowStock: "Apple boxes are running low", lowStockBody: "12 boxes remain at the main shop", approvalWaiting: "One sale is waiting", approvalBody: "₹42,800 needs the owner's approval", gstReminder: "GST return is due in 6 days", gstBody: "Review unresolved supplier bills first",
    stepOne: "Step 1 of 3", saleTitle: "Create a sale", saleHelp: "Items, customer, payment. What the customer pays stays at the bottom.", savedDevice: "Saved on this device", customer: "Customer", date: "Sale date", item: "Item", quantity: "Quantity", rate: "Price of one", freight: "Freight", otherCharges: "Other charges", chargeReview: "{charge} · Taxable {amount} · GST {gst}", paymentTerms: "When will they pay?", payNow: "Paid now", sevenDays: "Within 7 days", thirtyDays: "Within 30 days", moreDetails: "Add optional details", reference: "Customer reference", notes: "Notes", saleSummary: "Sale summary", itemTotal: "Items before GST", gstEstimate: "GST", amountCustomerPays: "Customer pays", taxSafety: "GST and the total are worked out as you type, by the same rules the bill uses. Nothing is saved until you record the bill.", roundOff: "Round off", estimateChooseCustomer: "Choose the customer to see the GST: their state decides which GST applies.", estimateChooseItem: "Choose an item to see the total.", editItemButton: "Edit item", reviewSale: "Review sale", discardDraft: "Discard draft",
    purchaseTitle: "Record a purchase", purchaseHelp: "Add the supplier bill. It stays unfinished until you check the extracted details.", supplier: "Supplier", supplierBill: "Supplier bill number", billDate: "Bill date", billAmount: "Bill amount", uploadBill: "Photo or PDF of the bill", uploadHelp: "The file is only looked at here. It is not uploaded.", beforeSaving: "Before it is saved", checkSupplier: "We will confirm the supplier", checkDuplicate: "We will look for the same bill", checkTax: "You will review every tax amount", purchaseSafety: "Reviewing this draft will not change stock, money owed, or GST.", billAmountHelp: "The total printed on the bill. If it does not match what the lines add up to, we will tell you instead of recording it.", whatYouBought: "What you bought", itemSteel: "TMT Steel Bar 12mm (sold by weight)", itemSoap: "Herbal Bath Soap 100g (sold in boxes)", itemFreight: "Inward freight (a service, no stock)", howMany: "How many", ratePerUnit: "Price of one, before GST", gstRate: "GST rate on the bill", purchaseLinesLabel: "Items on this supplier bill", purchaseTaxFromGstin: "Whether this bill carries IGST, or CGST and SGST, is worked out from the supplier's GST number and yours — or, for a supplier with no GST number, from the state saved on their address.", postingTitle: "What recording it will do", postingStock: "The goods go into your godown", postingBooks: "The purchase, and the GST you can claim back, go into your books", postingOwed: "The amount you owe the supplier is created, with the date it is due", postingTogether: "All three happen together. If any one of them cannot be done, nothing at all is saved.", postingRetrySafe: "If you are not sure it went through, press it again. The same bill is never recorded twice.", reviewPurchase: "Review purchase",
    paymentTitle: "Record money received", paymentHelp: "Record who paid and how much. Choose a bill now or leave it for later.", receivedFrom: "Received from", amountReceived: "Amount received", paymentDate: "Payment date", paymentMethod: "How did they pay?", cash: "Cash", bankTransfer: "Bank transfer", cheque: "Cheque", chooseBill: "Choose the sale this pays", chooseLater: "Choose later", chooseBillHelp: "Tick the bills this money pays. If you tick none, or it is more than the bills, the rest stays on account for this customer.", paymentSummary: "Payment summary", paymentSafety: "This is a draft. It does not reduce what the customer owes until it is reviewed and saved.", reviewPayment: "Review payment",
    // Issue #295 — the per-bill adjustments on money received.
    settleAnotherWay: "Settled another way too? (TDS, discount, write-off)", tdsDeducted: "Customer deducted TDS — amount", tdsSection: "TDS section", tdsSectionChoose: "Choose…", tdsQuarter: "Quarter", tdsCertificate: "Certificate no. (optional)", discountAllowed: "Discount allowed — amount", discountAsCreditNote: "Issue a GST credit note for this discount", cnAgreed: "The discount was agreed at or before the sale", cnItc: "The customer has given back their GST credit on it", writeOffSmall: "Write off small balance — amount", writeOffLimitHelp: "A write-off can be up to {limit} on one bill. The owner can change this in Business details.", writeOffLimit: "Write-off limit on one bill (₹)", writeOffLimitHelpForm: "The most that may be written off as un-collectible on one bill on Money received.",
    navPaid: "Money paid", paidTitle: "Record money paid to a supplier", paidHelp: "Pick the supplier, tick the bills you are paying, and say how you paid.", paidTo: "Paid to", amountPaid: "Amount paid", paidDate: "Date paid", paidMethod: "How did you pay?", chooseSupplierBill: "Bills this pays", chooseSupplierBillHelp: "Tick the supplier's bills this money pays, oldest first. Paying before their bill? Choose the advance below.", advanceChoice: "Record this as an advance to {supplier}", advanceHelpNoBill: "You have no bill from {supplier} yet. This money will be kept as an advance and taken off their next bill.", advanceHelpMore: "Whatever is not put against a bill ticked above will be kept as an advance and taken off {supplier}'s next bill.", advanceAlready: "Advance already with {supplier}: {amount}.", advancePoNumber: "Against purchase order no. (optional)", advancePoDate: "Purchase order date", advancePoHelp: "No purchase order? Leave both blank, and the voucher says the advance is against goods to be supplied.", advanceReceiptNumber: "Supplier's receipt voucher no. (optional)", advanceReceiptDate: "Receipt voucher date", advanceReceiptHelp: "The supplier gives a receipt voucher when they receive an advance. If you have it, enter it and it prints on the payment voucher.", printAdvanceVoucher: "Print the advance voucher", supplierAdvances: "Advances paid to suppliers: {amount}", useAdvanceOnBill: "Take the {amount} advance already paid to {supplier} off this bill", paidSummary: "Payment summary", paidSafety: "This is a draft. It does not reduce what you owe the supplier until it is reviewed and saved.", reviewPaid: "Review payment",
    choosePaymentCustomer: "Choose the customer who paid", choosePaymentSupplier: "Choose the supplier you paid", chequeNumber: "Cheque number", chequeDate: "Date on the cheque", paymentReferenceLabel: "Reference (UTR or UPI number, optional)", noOpenBills: "No bills are waiting to be paid.", chooseAPartyFirst: "Choose who it is, and their open bills appear here.", openBillLine: "{number} · {date} · bill {total} · still due {due}", printVoucher: "Print", receiptTitle: "Receipt {number}", paymentVoucherTitle: "Payment voucher {number}", chooseSaleCustomer: "Choose the customer", cancelBill: "Cancel this bill", cancelBillReason: "Why is this bill being cancelled?", cancelBillReasonHelp: "Kept with the bill and in the audit trail. The bill number stays used and is never given out again.", cancelBillConfirm: "Cancel the bill", cancelGovernmentFirst: "Cancel with the government first, then this bill", cancelBillChecking: "Checking what cancelling this bill will do…", billCancelledNote: "This bill is cancelled. It stays on record with its number, marked CANCELLED.", makeWholeBillNote: "Make a credit note for the whole bill", wholeBillChoice: "Whole bill · every item and charge · {amount} left to credit", documentsIssued: "Bill and note numbers used (GSTR-1 table 13)", documentsIssuedLine: "{from} to {to}: {total} numbers used, {cancelled} cancelled, {issued} counted", documentKindINVOICE: "Invoices", documentKindCREDIT_NOTE: "Credit notes", documentKindDEBIT_NOTE: "Debit notes", documentKindADVANCE_RECEIPT: "Receipt vouchers (advances)", documentKindREFUND_VOUCHER: "Refund vouchers", documentKindDELIVERY_CHALLAN_JOB_WORK: "Delivery challans for job work", documentKindDELIVERY_CHALLAN_APPROVAL: "Delivery challans for supply on approval", documentKindDELIVERY_CHALLAN_LIQUID_GAS: "Delivery challans for liquid gas", documentKindDELIVERY_CHALLAN_OTHER: "Other delivery challans",
    noteHelp: "Give the customer this page. It carries the bill it is against, so they can reverse the GST credit they claimed.", notePrint: "Print the note", noteFrame: "The printed note", notesTitle: "Credit and debit notes issued", noteAgainst: "against {number}", notePrintAction: "Print", noteNotPrintable: "Recorded before notes could be printed", returnsTitle: "Record a return", returnsHelp: "Choose the original bill and what came back. The original stays unchanged; a linked credit or debit note records the correction.", originalBill: "Original customer or supplier bill", returnItem: "Item being returned", returnQuantity: "Quantity returned", disposition: "What happens to the goods", dispAccepted: "Accepted back into usable stock", dispDamaged: "Move to damaged stock", dispScrapped: "Scrap after receiving", dispReplacement: "Replacement is being arranged", returnDate: "Return date", returnReference: "Return reference", returnReason: "Why is it being returned?", returnReasonHelp: "This explanation stays in the audit trail.", returnRemaining: "Choose a bill to see the quantity still eligible.", returnEligible: "{quantity} {unit} still eligible on the original bill.", returnLineChoice: "{item} · {quantity} {unit} left", customerSale: "Customer sale", supplierPurchase: "Supplier purchase", returnCheckQuantity: "Returned quantity cannot exceed the original eligible quantity", returnCheckBooks: "Stock, GST and the customer or supplier balance change together", returnCheckCompliance: "A bill with a government e-invoice number has its note reported too", returnSafety: "Checking changes nothing. Recording creates a linked note; it never edits or hides the original bill.", checkReturn: "Review return", noReturnDocuments: "No issued bills are available for return yet.", returnActivity: "Return recorded; the original bill stays as it was", customerReturnChecked: "Customer return checked", supplierReturnChecked: "Supplier return checked", returnCheckedBody: "The checked return comes to {amount}.", returnCustomerEffect: "A credit note will reduce what the customer owes.", returnSupplierEffect: "A debit note will reduce what you owe the supplier.", returnSalesStockEffect: "Accepted goods will go back into stock.", lineDiscount: "Discount (₹)", lineDiscountPercent: "Or discount (%)", billDiscount: "Discount on the whole bill", returnCause: "Why the price changes", causeInvoiceError: "The bill had the wrong price", causeDiscountAfterSale: "A discount given after the sale", causeChoose: "Choose why", returnMode: "What changed", returnModeGoods: "Goods or services came back", returnModePrice: "Price correction (nothing came back)", returnNewRate: "New price of one, before GST", returnAmountOff: "Or the amount off, before GST", returnPriceHelp: "Type the new price or the amount off. A lower price makes a credit note, a higher one a debit note. Stock does not change.", returnNoStockEffect: "Nothing goes into or out of stock.", priceLowerChecked: "Lower price checked", priceHigherChecked: "Higher price checked", priceDebitEffect: "A debit note will add to what the customer owes.", priceCorrectionRecorded: "Price correction recorded", returnPurchaseStockEffect: "Returned goods will leave stock.", returnComplianceEffect: "This bill has a government e-invoice number, so this note must be reported to the government too.", returnNoComplianceEffect: "Nothing about this note has to be reported to the government separately.", returnRecorded: "Return recorded", returnAlreadyRecorded: "Return already recorded once", returnRecordedBody: "Linked note {number} was recorded without changing the original bill.",
    workspace: "Your shop", activityTitle: "All activity", activityHelp: "Every completed action will appear here with its status and time.", createFirstSale: "Create a sale",
    setupTitle: "Set up a business",
    setupHelp: "Answer a few questions and we open a real set of books for it. Your GST number and opening figures are checked, not assumed.",
    setupAbout: "About the business",
    setupName: "What is it called?",
    setupKind: "What kind of work?",
    setupChoose: "Choose one",
    setupRetail: "Retail shop",
    setupWholesale: "Wholesale",
    setupBakery: "Bakery",
    setupServices: "Services",
    setupTransport: "Transport",
    setupManufacturing: "Manufacturing",
    setupState: "Which state?",
    setupPhone: "Phone (optional)",
    setupGstBooks: "GST and books",
    setupRegistered: "Registered for GST?",
    setupRegular: "Yes, regular",
    setupComposition: "Yes, composition",
    setupUnregistered: "Not registered",
    setupGstin: "GST number",
    setupFiling: "How often do you file GST?",
    setupMonthly: "Every month",
    setupQuarterly: "Every three months",
    setupBooksFrom: "Keep books from",
    setupOneThing: "One thing you sell",
    setupItemName: "Its name",
    setupGoodsOrService: "Goods or a service?",
    setupGoods: "Goods",
    setupService: "Service",
    setupCounted: "How is it counted?",
    setupHsn: "HSN or SAC code (optional)",
    setupRateLegend: "Optional — the GST you charge",
    setupRateHint: "If you tell us a rate, we record it as yours and say so on the bill. We never pick one for you.",
    setupRateCode: "For which goods or service code?",
    setupRatePercent: "What rate, in per cent?",
    setupRateBasis: "Where does the rate come from?",
    setupMoneyLegend: "Optional — money on day one",
    setupMoneyHint: "The cash you started with. We record it against your own money in the business, so the books balance.",
    setupOpeningCash: "Cash in hand on day one",
    setupCheck: "Check setup",
    setupCreate: "Create the business",
    reportsTitle: "Reports",
    reportsHelp: "Every figure below comes from this shop's own books: the ledger, sales, stock and money owed. Nothing is typed in.",
    reportsLoading: "Getting your reports…",
    signOut: "Sign out", loginTitle: "Sign in to Karobar", loginHelp: "Type your mobile number or email. We will send you a code.", signInAddress: "Mobile number or email", signInCode: "Code", sendCode: "Send me a code", signIn: "Sign in", signInAsTester: "Sign in as tester", codeSent: "We sent a code. Type it here.", changeAddress: "Use another number or email", switchCompany: "Business",
    salesFromModule: "From today's bills", openSalesInvoices: "From bills not yet paid", postedSupplierBills: "From supplier bills", calculatedLive: "Things waiting for you", loadingActivity: "Loading recorded activity…", loadingStock: "Loading stock…", readingInventory: "Checking your stock…", loadingSupplier: "Loading supplier balance…", readingReceivables: "Checking what you owe suppliers…",
    // Issue #132 — the bill itself: shown after a sale is recorded, and printed from the browser.
    // Issue #182 — where the goods go, who carries them, and what the bill refers back to.
    exportSection: "Export or SEZ supply", exportKindOverseas: "This customer is outside India, so this bill is an export.", exportKindSez: "This customer is in an SEZ. The bill will say so and carry the SEZ endorsement.", exportKindDeemed: "This customer buys as a deemed export. GST is charged as usual and the bill says so.",
    underLutLabel: "How is this export made?", underLutYes: "Under LUT or bond — no GST charged", underLutNo: "On payment of IGST", exportCountryLabel: "Country the goods go to", exportCountryHelp: "Two letters: AE for the UAE, US for the United States.", exportCurrencyLabel: "Currency of the sale", exportCurrencyHelp: "Leave empty if the customer pays in rupees.", exchangeRateLabel: "Rupees for one unit of that currency",
    shippingBillNumberLabel: "Shipping bill number", shippingBillHelp: "Usually filed after the bill. Leave it empty until you have it.", shippingBillDateLabel: "Shipping bill date", portCodeLabel: "Port code", portCodeHelp: "The six characters customs uses, such as INNSA1 for Nhava Sheva.",
    customerOverseas: "Outside India (export)", customerSezWithoutPayment: "SEZ unit — supplied under LUT", customerSezWithPayment: "SEZ unit — supplied with IGST", customerDeemedExport: "Deemed export buyer",
    deliveryAndReferences: "Delivery, transport and references", shipToWhere: "Where are the goods going?",
    shipToSame: "To the customer's billing address", shipToAddress: "To another address of this customer", shipToParty: "To somebody else, on this customer's instructions",
    shipToWhichAddress: "Which address?", shipToWhichParty: "Who receives the goods?", addDeliveryAddress: "＋ Add a delivery address",
    placeOfSupplyPending: "Choose the customer to see which state this sale counts in.", placeOfSupplyIs: "This sale counts in",
    placeOfSupplyBilling: "the goods go to the customer's billing address.", placeOfSupplyMovementEnds: "the goods finish their journey there.",
    placeOfSupplyThirdParty: "the goods go to somebody else on this customer's instructions, so the sale counts where the customer is.",
    transporterLabel: "Transporter", noTransporter: "No transporter", addTransporter: "＋ Add a transporter",
    vehicleNumberLabel: "Vehicle number", vehicleNumberHelp: "The lorry the goods leave on. It prints on the bill the driver carries.",
    lrNumberLabel: "LR / RR number", lrNumberHelp: "The transporter's own receipt number, which a lost consignment is traced by.", lrDateLabel: "LR / RR date",
    destinationLabel: "Destination", destinationHelp: "Where the goods are going. Taken from the delivery address; change it if it is wrong.",
    ewayBillNumberLabel: "e-Way bill number", ewayBillNumberHelp: "12 digits. Leave it empty if you will raise the e-way bill here — the number then prints on every later copy.",
    buyerOrderLabel: "Customer's order number", modeOfPaymentLabel: "Mode / terms of payment", modeOfPaymentHelp: "Taken from when they will pay. Change it if the bill should say something else.",
    termsOfDeliveryLabel: "Terms of delivery", otherReferencesLabel: "Other references",
    addTransporterTitle: "Add a transporter", addTransporterHelp: "The bill prints their name as \u201cDispatched through\u201d.",
    transporterName: "Transporter's name", transporterId: "GST number, or transporter ID", transporterIdHelp: "15 characters. A transporter who is not registered for GST is given a transporter ID instead; both go here.",
    transporterPhone: "Phone (optional)", saveTransporter: "Save transporter",
    addAddressTitle: "Add a delivery address", addAddressHelp: "Another place this customer takes goods at. It is saved on the customer, so it is not retyped next time.", correctAddress: "Correct address", correctAddressTitle: "Correct this customer's address or credit limit", correctAddressHelp: "Fix a wrong street, town or PIN code, or set their credit limit. Bills already issued keep the address they were issued with. The state stays as it is, because it decides the tax.", addressCorrected: "Address corrected", addressStateFixed: "State:",
    addressLabelName: "What to call it", deliveryStateHelp: "Goods sent to another state make this sale count in that state.",
    deliveryGstinHelp: "Only if this address has its own GST number. Leave it empty if it does not.", saveAddress: "Save address", saveCorrection: "Save changes",
    // Issue #181 — the customers and items the business keeps, and the many lines of one bill.
    saleLinesLabel: "Items on this bill", addLine: "Add another item", removeLine: "Remove", addCustomer: "＋ Add a new customer", addItem: "＋ Add a new item", itemSearchPlaceholder: "Name, code, HSN or scan", scanButton: "Scan", scanTitle: "Scan a barcode with the camera", scanHint: "Hold the barcode in front of the camera. It is read by itself.", cameraRefused: "The camera could not be opened. Allow the camera for this site, or type the barcode in the box.", mostSoldThisWeek: "Sold most this week", newItemFromSearch: "＋ New item", newItemWithCode: "＋ New item with barcode {code}", noItemMatch: "No item matches. Check the spelling, or add it as a new item.", priceLastCharged: "Last charged to them: {amount}, {date}", priceLastCounter: "Last price at the counter: {amount}, {date}", priceUsual: "Usual price", itemBarcode: "Barcode (optional)", itemBarcodeHelp: "Scan it here, or type the digits under the lines. Scanning it on the Sale screen then adds this item.", itemPrice: "Usual selling price (optional)", itemPriceHelp: "A new bill starts at this price, unless this customer was charged a different one last time.", itemOtherName: "Other name (optional)", itemOtherNameHelp: "Another name to find it by, in Hindi or any language — for example Sabun.",
    // Issues #288 and #307 — the walk-in customer, money taken at the counter, and the done screen.
    walkInCustomer: "Walk-in / cash customer", walkInShort: "Walk-in", walkInChoose: "Walk-in customer", walkInDetail: "Sold at your counter in {state}. No name or address is needed below ₹50,000.", placeOfSupplyCounter: "the goods are handed over at your counter.",
    paidBy: "Paid by", paidCash: "Cash", paidUpi: "UPI", paidCard: "Card", saleEffectPaid: "Paid now by {mode}: {amount}. Nothing is left to pay on this bill.", saleEffectPartPaid: "Paid now by {mode}: {amount}. {due} is added to the customer's khata.",
    walkInNameRequired: "From ₹50,000 of taxable value the bill must carry the buyer's name, address and state (CGST Rule 46(e)). Add the customer, then choose them.", walkInDelivery: "A walk-in customer takes the goods at the counter. To send them somewhere else, add the customer with their name and address.", addNamedCustomer: "Add the customer's name and address", dateItToday: "Date it today instead", billPaperThermal58: "Till roll, 58mm",
    doneTitle: "Bill made", doneWhatsapp: "Send on WhatsApp", donePhoneLabel: "Customer's WhatsApp number", donePhoneHelp: "Type their 10-digit mobile number to open their chat.", donePhoneInvalid: "That is not a 10-digit mobile number. Check it and type it again.", doneUpiIncluded: "The message carries a UPI link for {due}.", doneUpiMissing: "Save your UPI id in Branding to send a pay link with the bill.",
    donePrinter: "Printer", doneA4: "A4 sheet", done80: "3-inch till roll", done58: "2-inch till roll", donePrint: "Print receipt", doneNewBill: "New bill",
    doneLinePaid: "{mode} received from {name}. Stock updated.", doneLinePart: "{mode} of {paid} received; {due} added to {names} khata. Stock updated.", doneLineKhata: "Added to {names} khata. Stock updated.", doneModeCASH: "Cash", doneModeUPI: "UPI payment", doneModeCARD: "Card payment",
    doneMessageBill: "Hello{name}, thank you for shopping at {shop}. Bill {number}: {amount}.", doneMessagePaid: "Paid in full.", doneMessageDue: "Still to pay: {due}.", doneMessageUpi: "Pay by UPI: {link}",
    noCustomersYet: "No customers saved yet", noItemsYet: "No items saved yet", cancel: "Cancel",
    addSupplier: "＋ Add a new supplier", noSuppliersYet: "No suppliers yet", addSupplierTitle: "Add a supplier", addSupplierHelp: "Type their details as they are printed on their bill. Their state is read from their GST number.", supplierLegalName: "Name on their bill", supplierRegistration: "GST registration", supplierRegular: "Registered (has a GST number)", supplierComposition: "Composition dealer (has a GST number, charges no GST)", supplierUnregistered: "Not registered (no GST number)", supplierRegularHelp: "Their bill carries GST, and you can claim it back.", supplierCompositionHelp: "A composition dealer may not charge GST (CGST s.10(4)). Their bill carries none, and no credit comes from it.", supplierUnregisteredHelp: "A seller with no GST number may not charge GST (CGST s.32(1)), and no credit comes from their bill (s.16(2)(a)).", supplierBasis: "Why are they not registered?", supplierBasisChoose: "Choose the reason", supplierBasisThreshold: "Turnover below the limit (CGST s.22)", supplierBasisFarmer: "Farmer selling own produce (s.23(1)(b))", supplierBasisExempt: "Sells only exempt goods or services (s.23(1)(a))", supplierGstinHelp: "The first two digits are their state. It decides whether their bill carries IGST, or CGST and SGST.", saveSupplier: "Save supplier", addCustomerTitle: "Add a customer", addCustomerHelp: "The bill will carry this name, address and GST number, so they have to be right.",
    customerLegalName: "Name the customer is billed under", customerRegistration: "Registered for GST?", customerRegular: "Yes, regular", customerComposition: "Yes, composition", customerUnregistered: "Not registered",
    customerGstin: "GST number", customerGstinHelp: "We check the last character against the rest, so a mistyped digit is caught here and not by their accountant.",
    customerAddress1: "Address line 1", customerAddress2: "Address line 2 (optional)", customerCity: "Town or city", customerPincode: "PIN code", customerState: "Which state?",
    customerStateHelp: "For a registered customer the state comes from the first two digits of their GST number, and cannot be changed.",
    customerPhone: "Phone (optional)", saveCustomer: "Save customer",
    customerCreditLimit: "Credit limit in ₹ (optional)", customerCreditLimitHelp: "The most this customer may owe you. Leave it empty for no limit: then no bill to them is checked against one.", customerCreditLimitShown: "credit limit {amount}",
    itemCodeTitle: "Edit item", itemCodeCurrent: "{item} carries the code {code} ({digits} digits).", itemCodeNew: "New HSN or SAC code", itemCodeHelp: "Type every digit you have. More digits are always accepted; a shorter code is never padded with zeros.", itemCodeSave: "Save item", itemCodePick: "Choose an item first.", turnoverLegend: "Turnover last year", turnoverQuestion: "What was your business's total turnover last financial year? Count all sales under your PAN across every GST registration in India, including exempt sales and exports, before GST.", turnoverUpTo5: "₹5 crore or less, and never more than ₹5 crore in any year since 2017-18", turnoverUpTo5Earlier: "₹5 crore or less last year, but more than ₹5 crore in some earlier year since 2017-18", turnover5To10: "More than ₹5 crore, but less than ₹10 crore", turnover10Plus: "₹10 crore or more", turnoverUnsure: "Not sure", turnoverWhy: "Answer once. Until you do, we ask for 6 HSN digits, no bill is sent for a government e-invoice number, and each sale review reminds you in one line.", turnoverFor: "This answer is for bills in {year}. It decides how many HSN digits each bill needs, whether a bill needs a government e-invoice number, and whether it must be sent within 30 days.", turnoverAskAgainYES: "Earlier you only told us it was more than ₹5 crore. Please pick one answer above: only a business with ₹10 crore or more has to send each bill for its e-invoice number within 30 days.", turnoverAskAgainNO: "Earlier you only told us it was ₹5 crore or less. Please pick one answer above: a business that went over ₹5 crore in any year since 2017-18 still needs e-invoice numbers.", addItemTitle: "Add an item", addItemHelp: "The bill will carry this description, its code and its unit.",
    itemName: "What it is called on the bill", itemKind: "Goods or a service?", itemGoods: "Goods", itemService: "A service",
    itemHsn: "HSN or SAC code", itemHsnHelp: "Goods carry an HSN code of 2, 4, 6 or 8 digits; bills to GST-registered customers need at least 4, and at least 6 above ₹5 crore turnover. A service carries a 6-digit SAC starting 99.",
    itemUnit: "How is it counted?", itemTax: "The GST you charge on it", itemTaxHelp: "This is the rate your business charges. We record it as yours and the bill says so; we never pick one for you.",
    itemExempt: "Exempt or nil-rated", itemOtherRateChoice: "Another rate", itemOtherRate: "What rate, in per cent?",
    itemBasis: "Where does the rate come from?", itemBasisHelp: "For example: our accountant, or the rate printed on our supplier's bills.", itemRateFrom: "Rate applies from", itemRateFromHelp: "Leave empty for today. Pick an earlier day if you have already sold this item at this rate.", saveItem: "Save item",
    challanConsignee: "Who the goods are going to", challanConsigneeHelp: "The challan prints their saved name, address and GST number.",
    billTitle: "The bill", billReady: "This is the bill your customer gets. Print it, or save it as PDF from the print box.",
    billNoAddress: "No customer address was typed, so the bill prints without one. A GST-registered customer's bill should carry their address.",
    billPaper: "Paper", billPaperA4: "A4 sheet", billPaperThermal: "Till roll, 80mm", billPaperMobile: "Phone screen", printBill: "Print the bill", printBillCopies: "Print the bill ({copies} copies)",
    billFrame: "The printed bill", openBill: "Open the bill", billLoadFailed: "Could not bring up the bill.",
    saleCustomerPlaceholder: "Mehta Stores", saleItemPlaceholder: "Apple box, 10 kg", supplierPlaceholder: "Fresh Farms Pvt Ltd", supplierBillPlaceholder: "FF-2048", paymentCustomerPlaceholder: "ABC Traders",
    liveCompany: "How {company} is doing today.", salesLessReturns: "{billed} billed − {returned} returned by customers", purchasesLessReturns: "{billed} billed − {returned} sent back to suppliers", customerDocumentsOne: "1 bill still to collect", customerDocumentsMany: "{count} bills still to collect", supplierBillsOne: "1 supplier bill", supplierBillsMany: "{count} supplier bills", physicalBalance: "Physical balance in {location}", stockLeastFirst: "In {location}, least left first. {count} need attention.", supplierPaymentActivity: "Money paid to the supplier", supplierDue: "{supplier}: {amount} due", supplierDocumentsOne: "1 supplier bill still to pay", supplierDocumentsMany: "{count} supplier bills still to pay", noActivity: "No recorded activity yet.", purchaseActivity: "Supplier bill entered, stock updated", paymentActivity: "Money received from the customer", saleActivity: "Bill made",
    checking: "Checking this entry…", checkingBody: "Checking the figures…", nothingSaved: "Nothing was saved", signInRequired: "Sign in required.", requestFailed: "That did not work, and nothing was changed. Please try again.", signInAgain: "Sign in again to continue.", close: "Close", recordOnce: "Record once", sendForApproval: "Send for approval", approveBill: "Approve and issue", saleWaitingTitle: "Bills waiting for approval", approvalReasonLabel: "Why are you allowing it?", approvalYours: "This bill needs approval, and you may give it. Say why you are allowing it: your name and reason are kept with the bill.", approvalSomeoneElse: "This bill needs approval from {who}. The button sends it to them. It is not issued until they approve it.", approvalReasonNeeded: "Say why you are allowing it first.", approvalMadeByYou: "You made this bill, so someone else has to approve it.", recording: "Recording…", downloadPdf: "Download PDF", draftRestored: "Draft restored from this device", draftSaleDateMoved: "This sale was started on {started}. Its date is now today, {today}. Change it only if the goods really left on another day.", draftPurchaseDateKept: "This supplier bill was started on {started}. Its bill date is kept as {date}, because it is the supplier's date. Check it against their bill.", draftMoneyDateKept: "This entry was started on {started}. Its date is kept as {date}. Change it if the money moved on another day.", draftCleared: "Draft discarded", working: "Working…", enterPurchaseBill: "Enter the purchase bill", backToSale: "Back to the sale", purchaseForSale: "For the sale you were making: it asks for {required} {unit} of {item}, and {warehouse} has {available} {unit}. Type the quantity printed on the supplier's bill. The goods go into {warehouse}.", purchaseForSaleDone: "The goods are in stock now. Go back to the sale: everything you typed is still there. Review it again to issue the bill.",
    navAsk: "Ask",
    agentLegend: "Ask me to do it", agentHint: "Tell me what to do in your own words. I show you exactly what I would do — which customer, which bill, how much — and nothing happens until you say yes.",
    agentRequest: "What should I do?", agentRequestPlaceholder: "Find ABC Traders' unpaid invoices and send reminders",
    agentShowMe: "Show me what you would do", agentWouldDo: "What I would do", agentDoIt: "Yes, do it",
    agentSafety: "I only do things you can already do yourself. Before each one runs, I check your books again — if a bill was paid in the meantime, that message does not go.",
    agentCanDo: "What I am allowed to do for you",
    askTitle: "Ask about your business",
    askHelp: "Ask in English or Hinglish. Every figure in the answer comes from one of your own reports, and every rule answer names the notification it came from.",
    askLegend: "Your question",
    askHint: "Try one of these, or type your own.",
    askQuestion: "What would you like to know?",
    askQuestionPlaceholder: "How much did I sell this month?",
    askSend: "Ask",
    navMigration: "Bring your data",
    migrationTitle: "Bring your data across",
    migrationHelp: "Send the file your old software exports — customers, items, stock or last year's balances. We read it, show you exactly what would happen, and write nothing until you say so.",
    migrationFileHeading: "The file from your old software",
    migrationFileHelp: "Paste it, or choose a file from this device. Nothing leaves your session, and nothing is written to your books yet.",
    migrationFileName: "What is the file called?",
    migrationPaste: "Paste the file here",
    migrationUpload: "…or choose a file",
    migrationRead: "Read this file",
    saleChecked: "Sale checked", saleCheckedBody: "The checked sale comes to {amount}.", saleEffectInvoice: "A numbered invoice will be issued.", saleEffectBalance: "The customer balance will increase.", purchaseChecked: "Purchase checked", purchaseCheckedBody: "The checked supplier bill comes to {amount}.", purchaseEffectStock: "Stock will update from this purchase.", purchaseEffectBooks: "GST and what you owe the supplier are recorded together.", paymentChecked: "Payment checked", paymentCheckedBody: "A receipt of {amount} is ready to record.", paymentEffectBalance: "The customer balance will reduce when this is recorded.", saleRecorded: "Sale recorded", saleRecordedBody: "Invoice {number} was issued.", purchaseRecorded: "Purchase recorded", purchaseRecordedBody: "Stock, GST and the supplier balance were recorded together.", paymentRecorded: "Payment recorded", paymentRecordedBody: "The customer receipt was recorded once.", amountInvalid: "Enter a valid amount greater than zero.", referenceRequired: "Enter the supplier bill number.", rateRequired: "Enter a price and quantity.", permissionDenied: "You do not have permission to do this work.",
    navEInvoice: "E-invoice",
    einvoiceTitle: "E-invoice numbers for your bills", einvoiceHelp: "The app works out for every bill whether it needs a government e-invoice number, from who the bill is for and your answers in Business details. You are not asked anything here.",
    whichBill: "Which bill", einvoiceTurnoverFrom: "Worked out from your turnover and business type in Business details. To change them, open Business details.",
    einvoiceListTitle: "Your bills", einvoiceAskTurnover: "We don't know yet whether you need e-invoices, because Business details does not say whether your turnover has been over ₹5 crore.", answerInBusinessDetails: "Answer once in Business details", backToSale: "Back to the sale", einvoiceNoBills: "No bills issued yet.", einvoiceOpen: "Open", einvoiceRetry: "Try sending again", einvoiceCancelOpen: "Cancel…",
    einvoiceNeedsYes: "Needs an e-invoice number", einvoiceNeedsNo: "No e-invoice needed", einvoiceNeedsUnknown: "Not known yet",
    exemptLegend: "E-invoice exemption", exemptCategory: "Is your business one of these kinds?", notExempt: "No, none of these", exemptBank: "A bank or finance company (NBFC)", exemptInsurance: "An insurance company", exemptGta: "A goods transport agency", exemptPassenger: "A passenger transport business", exemptCinema: "A cinema", exemptSez: "A unit in an SEZ", exemptGovernment: "A government department or local authority", exemptHint: "The government leaves these kinds of business out of e-invoicing whatever their turnover. Most businesses are none of them.",
    checkNeeded: "Check this bill", einvoiceSafety: "A bill that needs an e-invoice number is sent by itself when you issue it. Nothing else is sent from here unless you press a button.",
    sendToGovernment: "Send to the government", downloadOffline: "Download the file instead", askGovernment: "Ask the government what it has",
    cancelReasonKind: "Why are you cancelling?", reasonMistake: "Something was typed wrong", reasonDuplicate: "The same bill was sent twice", reasonOrderOff: "The order was cancelled", reasonOther: "Another reason",
    cancelReasonWhy: "Say it in your own words", cancelEInvoice: "Cancel with the government",
    navItc: "Purchase check",
    itcTitle: "Your purchases against the government's record",
    itcHelp: "Every bill still waiting to be claimed, next to what your suppliers actually told the government. Where the two agree, the GST you paid can be claimed back. Where they do not, the money is held back and the line says who has to do what.",
    itcWhichMonth: "Which month", itcWhichMonthHelp: "Pick the month you are about to file for.",
    itcCheck: "Check this month",
    itcSafety: "This only compares. Nothing is claimed, sent or filed from this screen.",
    itcImportTitle: "Bring in the government's list",
    itcImportHelp: "Download the GSTR-2B file for this month from the GST portal and choose it here, or paste it in. A spreadsheet from your accountant works too.",
    itcImportFile: "The file you downloaded", itcImportFileHelp: "Nothing leaves this device except the contents of the file you choose.",
    itcImportPaste: "Or paste it here",
    itcImportButton: "Import this month's record",
    itcTypedTitle: "Or type a bill in from the portal screen",
    itcTypedHelp: "If the file will not download — the shop's internet, a phone, a portal that will not respond — read the bill off the portal and type it here. It is checked exactly as strictly as the file.",
    itcTypedGstin: "Supplier's GST number", itcTypedSupplier: "Supplier's name", itcTypedNumber: "Bill number on the portal",
    itcTypedDate: "Bill date", itcTypedTaxable: "Value before GST", itcTypedCgst: "CGST", itcTypedSgst: "SGST",
    itcTypedIgst: "IGST", itcTypedTotal: "Total on the bill",
    itcTypedButton: "Add this row",
    itcTypedSafety: "The line will say the figure was typed in by a person, not downloaded. Everything else works the same.",
    itcTotalsTitle: "What this means for your GST return",
    itcLinesTitle: "Bill by bill",
    itcLinesHelp: "Every line shows what your books say, what the portal says, and what is holding the credit. Accepting a bill the portal does not carry needs a reason, and your name stays on it.",
    itcClaimable: "Safe to claim this month", itcHeldBack: "Held back", itcAtRisk: "Claimed on your say-so",
    itcTimeBarred: "Too late to claim — this does not come back",
    itcAccept: "Accept", itcReject: "Reject", itcPending: "Keep pending",
    itcReasonPlaceholder: "Why? (goes on the record)",
    itcOurs: "yours", itcTheirs: "portal",
    itcTypedFlag: "typed in by a person",
    navGstReturns: "GST returns",
    gstReturnsTitle: "Your GST returns for the month",
    gstReturnsHelp: "Every bill you issued in the month, sorted into the parts the government asks for, with the bills behind each figure still there to open. Nothing is guessed: a bill we cannot place is put on a list with the question that would place it.",
    gstWhichMonth: "Which month", gstWhichMonthHelp: "Returns are filed month by month. Pick the month you are filing for.",
    gstPrepare: "Prepare this month",
    gstSafety: "This only reads your books and works out what the return would say. Nothing is sent to the government here.",
    gstDriftTitle: "Your books have changed since this was approved",
    gstExceptionsTitle: "Bills that cannot go on the return yet",
    gstExceptionsHelp: "Each one is waiting on an answer from a person. They are in your books; they are simply not on the return until somebody decides.",
    gstSectionsTitle: "What the return says",
    gstSectionsHelp: "The government wants your sales split up like this. Every line shows the bills it was made from.",
    gstBooksTitle: "Does it agree with your books?",
    gst3bTitle: "The short return: what you owe and what you have already paid",
    gstApproveTitle: "Approving and filing",
    gstApproveHelp: "Approving fixes these figures against your name and the moment. After that, if your books move, the app tells you rather than quietly changing the return.",
    gstApproveNote: "A note for the record",
    gstApprove: "Approve this return",
    gstExport: "Download the file to upload yourself",
    gstOwe: "you owe", gstCredit: "already paid", gstLeftOver: "left over", gstCashRcm: "Pay {cash} in cash — {rcm} of it is reverse-charge tax, which credit cannot pay (CGST s.49(4))", gstCreditLeft: "{amount} credit left over", rcmQuestionsTitle: "Who pays the GST on this bill?", rcmQuestionsHelp: "Some purchases are under reverse charge: you, the buyer, pay their GST to the government, not the seller. Whether this one is turns on something only you know. Answer, then review the purchase again.", rcmYes: "Yes", rcmNo: "No", rcmAnswerAbove: "Answer the question on the form about who pays the GST, then review the purchase again.", receivedOn: "Date the goods or service reached you", receivedOnHelp: "Only matters when you pay the GST yourself (reverse charge). Leave blank if it is the bill date.", selfInvoicesTitle: "Self-invoices to make", selfInvoicesHelp: "When you buy goods or services under reverse charge from a seller with no GST number, you make the bill yourself — a self-invoice — within 30 days of receiving them (CGST s.31(3)(f), Rule 47A).", selfInvoiceLine: "{supplier} · bill {bill} · received {date} · GST {tax}", issueSelfInvoice: "Make self-invoice", printSelfInvoice: "Show", selfInvoiceTitle: "Self-invoice {number}", selfInvoiceStateOVERDUE: "Late", selfInvoiceStateLAST_DAY: "Last day today", selfInvoiceStateDUE_SOON: "Due soon", selfInvoiceStateNOT_YET_DUE: "To make", selfInvoiceStateISSUED: "Made", creditAllowed: "Can you claim this GST back?", creditAllowedYes: "Yes — GST can be claimed", creditAllowedHelp: "Choose No only if the law blocks the credit (CGST s.17(5)); its GST then goes into the cost.", blocked_motor_vehicle: "No — car or vehicle for up to 13 people (s.17(5)(a))", blocked_vessel_aircraft: "No — boat, ship or aircraft (s.17(5)(aa))", blocked_vehicle_insurance_repair: "No — insurance or repair of such a car (s.17(5)(ab))", blocked_food_health_etc: "No — food, drinks, catering, beauty, health, car hire, life or health insurance (s.17(5)(b))", blocked_club_fitness: "No — club, gym or fitness membership (s.17(5)(b))", blocked_employee_travel: "No — holiday travel for employees (s.17(5)(b))", blocked_works_contract_building: "No — contractor building work on a building (s.17(5)(c))", blocked_own_building: "No — goods or services to build your own building (s.17(5)(d))", blocked_csr: "No — used for CSR work (s.17(5)(fa))", blocked_personal_use: "No — personal use, not business (s.17(5)(g))", blocked_gift_sample: "No — given away as gifts or free samples (s.17(5)(h))",
    gstOnReturn: "on the return", gstInBooks: "in your books",
    // Issue #249 — goods sent back to a supplier, and the credit side of the books check.
    supplierNoteNumber: "Supplier's credit note number", supplierNoteDate: "Supplier's credit note date",
    supplierNoteHelp: "If the supplier has already given you their credit note, type it here. If not, leave these empty and add it when it comes — the credit comes down from this month either way.",
    supplierNoteAdd: "Add supplier's credit note", supplierNoteSave: "Save", supplierNoteShown: "supplier's note {number} of {date}",
    supplierNoteAwaited: "supplier's credit note not yet received",
    gstPurchaseBooksTitle: "Credit on purchases: return against your books", gstPurchaseExplained: "explained by the purchase check",
    itcTypedKind: "Bill or credit note?", itcKindInvoice: "Bill", itcKindCreditNote: "Credit note",
    navVehicle: "Vehicle check",
    vehicleCheckTitle: "Can this lorry carry this load?",
    vehicleCheckHelp: "Before the goods leave the yard we compare what is being loaded against what the vehicle is registered to carry. Every answer says where the fact came from, and a service we could not reach is never shown as 'nothing wrong'.",
    recordLookupTitle: "What does the registering authority hold?",
    recordLookupHelp: "Type a number plate and we ask the government's vehicle record for it. You get what kind of vehicle it is, how much it may carry and until when its papers are valid — with the date we asked. The owner's name is shortened to initials before it is stored, and nothing else about the owner is asked for at all.",
    recordPlate: "Number plate", recordPlateHelp: "Type it as it is written on the lorry. Spaces and dashes do not matter.",
    recordLookupButton: "Ask the registering authority",
    recordSafety: "This only reads. Nothing is sent to the tax portal and no e-way bill is raised.",
    recordAsked: "When we asked", recordProvider: "Who answered", recordReference: "Their reference for this answer",
    recordReused: "Read again from what we already had, so the provider was not asked twice.",
    recordAgreed: "What this business agreed may be read",
    whichVehicle: "Which vehicle", whichVehicleHelp: "Pick one to see what the registering authority holds against it.",
    loadWeight: "Weight being loaded (kg)", loadWeightHelp: "Leave blank if nobody has weighed it — we will ask rather than guess.",
    crossesBorder: "Does it cross a state border?", crossesBorderHelp: "A state permit does not travel outside the state that issued it.",
    coldChain: "Must the goods stay cold?", hazardous: "Are they hazardous goods?",
    platePhoto: "Photo of the number plate", platePhotoHelp: "The yard's camera. A photo that cannot be read is a question, not a mismatch.",
    plateTyped: "Or type what the plate says", plateTypedHelp: "If there is no photograph, read the plate off the lorry and type it here. It is checked the same way, and recorded as a person's reading.",
    typedClass: "If nothing is on record: what kind of vehicle is it?", typedClassHelp: "Only used when neither the registering authority nor your vehicle list holds this vehicle. It never overrules them.",
    typedCapacity: "If nothing is on record: how much may it carry? (kg)", typedCapacityHelp: "What the registration certificate says it may carry, typed in for this movement.",
    classNotSaid: "Not said",
    checkVehicle: "Check this vehicle",
    vehicleSafety: "This only checks. Nothing is sent anywhere and no e-way bill is raised.",
    evidenceUsed: "What we read, and from where", evidenceUsedHelp: "The registering authority's record and your own vehicle list, kept apart. An override never changes anything here.",
    overrideWhich: "Which findings are you answering for?", overrideWhichHelp: "Only findings that can be overridden are listed. A vehicle that physically cannot carry the load is not one of them.",
    overrideWhy: "Why is it alright to send it?", overrideButton: "Send it anyway, on my authority",
    overrideSafety: "This adds your name, the time and your reason beside the findings. It changes no weight, no capacity and no government record.",
    heldBack: "Held back at the dispatch desk", heldBackHelp: "Movements a vehicle problem is stopping, and what is still to be answered.",
    // Issue #142 — quotations and proforma invoices.
    navPresale: "Quotation / Proforma",
    presaleTitle: "Quotation and proforma invoice", presaleHelp: "A quotation is a price offer you send before the sale. A proforma invoice is an advance bill, usually sent so the customer pays before the goods go. Neither is a tax invoice: nothing goes into your books, your stock or GST until you issue the real bill.",
    presaleWhich: "Which paper?", presaleQuotation: "Quotation — a price offer", presaleProforma: "Proforma invoice — an advance bill",
    presaleQuotationRule: "A price offer. Nothing is recorded in your books. If the customer accepts, you turn it into a bill without typing it again.",
    presaleProformaRule: "An advance bill, to collect payment before the goods go. It says \u201cNot a tax invoice\u201d and carries your bank details. The tax invoice you raise later is linked back to it.",
    presaleDate: "Date", presaleValidUntil: "Valid until (optional)", presaleValidHelp: "How long your price holds. Leave it empty if you do not want to promise a date.",
    presaleRate: "Rate per unit", presaleRateHelp: "Before GST. The GST is worked out the same way as on your bill.",
    presalePurpose: "What is this proforma for?", presalePurposeHelp: "Kept with the proforma, not printed. It is how the bill raised later is matched to it.",
    presaleBuyerOrder: "Customer's order number (optional)", presalePaymentTerms: "How should they pay? (optional)",
    presaleBank: "Your bank details (optional)", presaleBankHelp: "Printed on the proforma so the customer knows where to pay. One line per row.",
    presaleTerms: "Your terms (optional)", presaleTermsHelp: "Printed exactly as typed. Nothing is added for you.",
    presaleCheck: "Check", presaleSafety: "Checking saves nothing and uses no number. The number is given only when you issue it.",
    presaleIssue: "Issue it", presaleIssued: "Quotations and proformas", presaleIssuedHelp: "Newest first. Open one to print it, turn a quotation into a sale, link a proforma to its bill, or cancel it.",
    presaleNone: "Nothing issued yet.", presaleOpen: "Open", presalePrint: "Print",
    presaleConvertTitle: "Did the customer accept?", presaleConvertHelp: "Turn this quotation into a bill without typing it again. You see the bill and its checks before anything is issued.", presaleConvert: "Turn into a sale", presaleOpenBill: "Open the bill made from it",
    presaleIssueBill: "Issue the bill",
    presaleLinkTitle: "The tax invoice raised later", presaleLinkHelp: "Pick the bill that followed this proforma. We check it is for the same customer and not dated before it, and note anything that differs.",
    advanceTitle: "Money received against this proforma", advanceHelp: "Each payment gets a receipt voucher in its own series. For a service, the GST inside it is due now and is set off when you link the tax invoice, so it is never charged twice. For goods, no GST is due until the invoice.",
    advanceAmount: "Amount received", advanceMode: "How was it paid?", advanceCash: "Cash", advanceUpi: "UPI (into your current account)", advanceBank: "Bank transfer (into your current account)", advanceUtr: "Reference (optional)", advanceRecord: "Record it and issue the receipt voucher",
    refundHelp: "Pays back what no bill used, with a refund voucher. Any GST paid on it is taken back.", refundReason: "Why is it being paid back?", refundRecord: "Pay it back and issue the refund voucher",
    presaleCancelTitle: "Cancel this", presaleCancelHelp: "If the customer did not take it up. The number stays used, so the series has no gap.", presaleCancelReason: "Why is it being cancelled?", presaleCancel: "Cancel it",
    // Issue #141 — delivery challans.
    navChallan: "Delivery challan",
    challanTitle: "Send goods on a delivery challan", challanHelp: "A delivery challan is the paper that travels with goods when no tax invoice goes with them — job work, goods sent on approval, or a sale that is billed after delivery. GST allows it only for the reasons listed here, and says what it must show.",
    challanWhy: "Why are the goods moving?", challanDocDate: "Challan date", challanItem: "Goods", challanValuePerUnit: "Value of one unit",
    challanReasonNote: "Say why, in a few words", challanStateHelp: "Leave it on the consignee's own state unless the goods are delivered somewhere else.",
    checkChallan: "Check this challan", challanSafety: "Checking saves nothing and uses no number. The number is given only when you issue it.",
    issueChallan: "Issue the challan", challansIssued: "Challans issued", challansIssuedHelp: "Newest first. Open one to print it, add its e-way bill, link the invoice that followed, or cancel it.",
    noChallans: "No challan has been issued yet.", openChallan: "Open", printChallan: "Print all three copies",
    billChallanTitle: "Make the bill for these goods", billChallanHelp: "Bills exactly the goods on this challan, takes them out of stock once and links the bill to the challan.", billChallanBy: "Goods on approval: bill them by {date} (six months from when they left).", billChallan: "Make the bill", linkInvoiceTitle: "The tax invoice raised after delivery", linkInvoiceHelp: "Only for goods that were sold. Pick the invoice; we check it is for the same customer, dated after the challan, and bills the same goods.", linkInvoice: "Link this invoice",
    challanEwayTitle: "E-way bill number", challanEwayHelp: "Type it in if it was raised somewhere else. One raised on the e-way bill screen lands here by itself.", ewayBillNumberLabel: "E-way bill number (12 digits)", transporterName: "Transporter", recordEwayNumber: "Put it on the challan",
    printEway: "Print for the driver", printEwaySend: "Send to printer", printEwayPdf: "Download PDF",
    cancelChallanTitle: "Cancel this challan", cancelChallanHelp: "Only if the goods never moved on it. The number stays used, so the series has no gap.", cancelChallanReason: "Why is it being cancelled?", ewayCancelledOnPortal: "Its e-way bill has been cancelled on the portal", cancelChallan: "Cancel the challan",
    ewayChallanReasonHelp: "For a delivery challan, the reason written on the challan is used, not this one.",
    navEway: "E-way bill",
    ewayTitle: "Do these goods need an e-way bill?", ewayHelp: "An e-way bill is a permit for moving goods, not a tax paper. Most small consignments need none. We work it out from what is on the lorry, where it is going and which state's rule applies, and show you the rule that decided it.",
    whyMoving: "Why are the goods moving?", moveSupply: "A sale", moveJobWork: "Going out for job work", moveBranch: "Moving between your own places", moveReturn: "Coming back from a customer",
    deliveryState: "Which state are the goods going to?", deliveryStateHelp: "Every state's own limit is built in. Leave it on \"Wherever the buyer is\" unless the goods are being delivered somewhere else. If the bill already has a delivery address, that one is used.", buyerOwnState: "Wherever the buyer is",
    deliveryPlace: "Delivery town or city", deliveryAddress: "Delivery address (building, street, area)",
    deliveryPincode: "Delivery PIN code", deliveryPincodeHelp: "The PIN code of the delivery address, not the buyer's. The portal works out the route from it.",
    distanceKm: "Road distance (km)", distanceHelp: "Leave it empty: the portal works the distance out from the two PIN codes. Type it only if the road really is longer; the portal accepts at most 10% more than its own distance. The distance decides how many days the bill lasts: one day for every 200 km, or part of it.", ewayFromBill: "Raise e-way bill", ewayOpen: "Open the e-way bill", ewayFilledFrom: "Filled in from bill {number}. Check it, then press the raise button.",
    vehicleNumber: "Vehicle number", vehicleHelp: "Leave blank to raise Part A now and add the lorry later. Goods may not move until it is added.",
    oversized: "Is it an oversized load?", answerYes: "Yes", answerNo: "No", answerNotSaid: "Not said",
    sameCity: "Does it stay inside one city?", sameCityHelp: "Some states, such as Gujarat, ask for no e-way bill at all inside one city. Leave it as 'not said' if you are unsure — we will ask rather than guess.",
    checkMovement: "Check this movement", ewaySafety: "Checking sends nothing. Nothing reaches the portal until you press the raise button.",
    raiseEway: "Raise the e-way bill", askPortal: "Ask the portal what it has",
    vehicleChangeReason: "Why this vehicle?", changeFirst: "It is the first one", changeBreakdown: "The last one broke down", changeTransshipment: "Goods moved to another lorry", changeNote: "Say what happened", fromPlace: "Picking up from",
    addVehicle: "Put this vehicle on the bill",
    currentPlace: "Where is the vehicle now?", currentState: "Which state code?", remainingKm: "Kilometres still to go", extendWhy: "Why is it taking longer?", extendValidity: "Extend the e-way bill",
    cancelEway: "Cancel with the portal",
    onTheRoad: "On the road right now", onTheRoadHelp: "Every consignment with a running e-way bill, and how long each one has left.",
    navSupplier: "Supplier check",
    navPlan: "Your plan",
    navTeam: "People who can use this business", teamTitle: "People who can use this business", teamHelp: "Who can sign in to this business, and what each person may do. Removing someone signs them out at once.",
    teamInviteTitle: "Add a person", teamRole: "What they may do", teamInvite: "Make an invitation link", teamLeave: "Leave this business",
    teamLinkMade: "Send this link to {address}. It works for 7 days, only for that number or email: {link}", teamYou: "you",
    teamRemove: "Remove", teamHandOver: "Hand the business over", teamConfirmRemove: "Remove {name}? They are signed out at once.", teamConfirmHandOver: "Hand the business over to {name}? They become the owner and you stay on as an admin.", teamConfirmLeave: "Leave this business? You will be signed out of it.",
    roleOwner: "Owner", roleAdmin: "Admin", roleAccountant: "Accountant (or CA)", roleStaff: "Staff", roleViewer: "Viewer", roleCustom: "Custom", joinInvited: "You have been invited to a business. Sign in with the number or email the invitation was sent to.",
    planTitle: "What your plan covers", planHelp: "Plans differ in how much you do. They never differ in how carefully it is done — every warning, every check and your own data are in all of them, including the free one.",
    planUsage: "What you have used this month", planNeverWithheld: "What no plan can take away",
    planChoose: "Change your plan", planPay: "Pay for this month", planInvoices: "Our invoices to you",
    navReminders: "Reminders",
    remindersTitle: "Who to remind about money", remindersHelp: "Every line below is worked out from your books this moment. A bill that was paid, disputed or promised is left alone, and it says so — because \"why did nobody remind them?\" is the question that comes next.",
    remindersToday: "What would go out today", remindersSendAll: "Send everything agreed",
    remindersSafety: "Nothing is sent until you ask. Before each message goes, the bill is checked again — if the money arrived a minute ago, the message does not go.",
    remindersSend: "Send this one", remindersRetry: "Try again",
    remindersTellUs: "Tell us what the customer said", remindersBill: "Which bill", remindersWhatHappened: "What happened",
    remindersPromise: "They promised to pay", remindersDispute: "They say something is wrong with the bill",
    remindersPromisedOn: "Promised by", remindersAmount: "Amount they promised", remindersNote: "In their words",
    remindersRecord: "Record this", remindersStopTitle: "Stop reminding this customer",
    remindersCustomer: "Customer", remindersStopReason: "Why", remindersStop: "Stop reminders", remindersResume: "Start reminders again",
    remindersHistory: "What was sent", remindersOutbox: "What the customer received",
    remindersNothing: "Nothing yet.",
    supplierTitle: "Check a supplier before you pay", supplierHelp: "We show you what the GST department says and what your own books say, with the date and source of every single thing. We never tell you what kind of business someone is — only what the records show.",
    theirGstin: "Their GST number", theirGstinHelp: "We check this with the GST department.",
    trySomeone: "Or try one of these", checkSupplier: "Check this supplier",
    supplierSafety: "This only looks things up. Nothing is recorded against the supplier and no money moves.",
    whatWeFound: "What we found", whereFrom: "Where each answer came from",
    ackReason: "Why is it alright to go ahead?", ackButton: "Accept and go ahead",
    navDeliveries: "Orders and deliveries", orderDate: "Order date", deliveryDate: "Delivery date",
    deliveriesTitle: "Orders, deliveries and the supplier's bill", deliveriesHelp: "Check what you ordered against what actually arrived and what you are being charged for. None of it is forced — if you never raise orders, skip the first box.",
    stepOrder: "1 · What you ordered", stepOrderHelp: "Only if you work with orders. This buys nothing and changes no stock.",
    orderNumber: "Order number", orderedQty: "How many you ordered", agreedRate: "Agreed price of one, before GST",
    placeOrder: "Place this order", orderSafety: "An order is a promise, not a purchase. Nothing goes into your books or your godown until goods actually arrive.",
    stepReceipt: "2 · What actually arrived", stepReceiptHelp: "Count it at the gate. Only what you keep goes into your stock.",
    receiptNumber: "Delivery number", againstOrder: "Against which order", againstOrderHelp: "Leave this blank if there was no order.",
    arrivedQty: "How many arrived", keptQty: "How many you kept", keptQtyHelp: "Anything less than what arrived needs a reason.",
    rateIfNoOrder: "Price of one (used when there is no order)", whyRejected: "Why the rest was not kept",
    confirmGoods: "Confirm the goods", receiptSafety: "Confirming puts the kept quantity into your godown straight away. The rest never enters stock, so you are not holding goods you turned away.",
    stepMatch: "3 · The supplier's bill", stepMatchHelp: "We hold the three side by side and tell you exactly what disagrees.",
    billedQty: "How many the bill charges for", billedRate: "Price of one on the bill", checkBill: "Check this bill",
    matchSafety: "This only compares. Nothing is recorded in your books and no stock moves.",
    colItem: "Item", colOrdered: "Ordered", colArrived: "Arrived", colKept: "Kept", colTurnedAway: "Turned away", colBilled: "Billed", colAgreedPrice: "Agreed price", colBilledPrice: "Billed price",
    differencesTitle: "What disagrees", approveReason: "Why is this difference acceptable?", approveDifferences: "Accept these differences",
    navCollections: "Collections", collectionsTitle: "Payment reminders", collectionsHelp: "Review exactly what will be sent, pause follow-up for promises or disputes, and keep the balance seen with every message.", reminderPlan: "Plan a reminder", reminderDate: "Balance as of", reminderChannel: "Send through", channelInApp: "In-app", channelEmail: "Email", channelWhatsapp: "WhatsApp", scheduleReminder: "Add to review", sendDueReminders: "Send reviewed reminders", scheduledMessages: "Scheduled messages", communicationHistory: "Communication history", collectionSafety: "The balance is checked again immediately before sending. Settled or disputed invoices are never chased.", optOutCustomer: "Customer has opted out of reminders", savePreference: "Save preference", promiseTitle: "Promise to pay", promisedAmount: "Amount promised", promisedDate: "Promised date", savePromise: "Record promise", disputeTitle: "Customer dispute", disputedInvoice: "Disputed invoice", disputeReason: "What does the customer dispute?", saveDispute: "Stop reminders for this invoice", noScheduled: "No reminders are waiting for review.", noCommunications: "No collection messages have been attempted yet.", navBankFeeds: "Bank feeds", bankFeedsTitle: "Import bank transactions automatically", bankFeedsHelp: "Give a provider permission to fetch transactions. Imported lines go to review and never move money.", connectBank: "Connect a bank", bankConsentHelp: "You approve access on the provider's page and can disconnect it at any time.", giveBankPermission: "Start bank permission", approveSandboxPermission: "Approve sandbox permission", bankFeedSafety: "We never ask for or store your bank password, PIN or OTP. Disconnecting keeps transactions already imported for your accounts.", connectedAccounts: "Connected accounts", importedBankTransactions: "Imported transactions", noBankConnections: "No bank is connected yet.", noBankTransactions: "No live bank transactions have been imported yet.", syncNow: "Import latest transactions", disconnectBank: "Disconnect bank", bankConnected: "Bank connected", bankSynced: "Bank transactions imported", bankDisconnected: "Bank disconnected", bankReturnRefused: "This reply from the bank does not match the request started in this window, so nothing was connected. Start again from Bank feeds.",
    navOperations: "Operations", operationsEyebrow: "Service health", operationsTitle: "Is the service working?", operationsHelp: "See service checks, failed external calls, safe retries and customer incident updates without opening invoices or bank records.", operationsSafetyTitle: "Customer data stays private. ", operationsSafety: "This page shows error codes and correlation IDs only. A retry is offered only for work declared safe and duplicate-proof.", operationsHealth: "Health checks", operationsFailures: "External failures", operationsQueue: "Safe retry queue", operationsRecurring: "Recurring work", operationsIncidents: "Customer status timeline", operationsHealthy: "All checks are working", operationsDegraded: "One or more checks need attention", operationsNoFailures: "No external failures for this company.", operationsNoJobs: "No jobs are waiting.", operationsNoRecurring: "No recurring work is registered.", operationsNextRun: "Next", operationsLastRun: "Last", operationsNeverRun: "Not run yet", operationsRunning: "Running", operationsSucceeded: "Succeeded", operationsFailed: "Failed", operationsDeadLettered: "Stopped after repeated failures", operationsReplay: "Retry safely", operationsNoIncidents: "No current or recent incidents.",
    navBusiness: "Business details", businessEyebrow: "Your business", businessTitle: "Your business, as it prints on every bill", businessHelp: "The law asks every bill to carry your name, your address and your GST number. Type them once here and every bill, challan and quotation carries them.",
    businessNameLegend: "Name", businessLegalName: "Registered name", businessTradeName: "Trading name (optional)", businessTradeNameHint: "If you fill this in, the bill prints it instead of the registered name.",
    businessAddressLegend: "Address", businessAddressHint: "A town on its own is not an address. The street and the PIN code are both required on a bill.", businessAddress1: "Address line 1", businessAddress2: "Address line 2 (optional)", businessCity: "Town or city", businessPincode: "PIN code", businessState: "State",
    businessContactLegend: "Phone, e-mail and PAN", businessPhone: "Phone (optional)", businessEmail: "E-mail (optional)", businessPan: "PAN (optional)",
    businessBankLegend: "Bank account (optional)", businessBankHint: "This is where your customer pays you. Fill in all four, or leave all of them empty.", businessBankName: "Bank name", businessAccountNumber: "Account number", businessBranch: "Branch", businessIfsc: "IFSC", businessBankRemove: "Take the bank details off",
    businessWordsLegend: "Your own words (optional)", businessWordsHint: "Anything you type here prints at the foot of the bill, exactly as you typed it. We never write it for you.", businessDeclaration: "Declaration", businessTerms: "Terms",
    businessSignatureLegend: "Signature (optional)", businessSignatureHint: "A PNG or JPG under 200 KB. It prints above \u201cAuthorised Signatory\u201d.", businessNoSignature: "No signature yet", businessChooseSignature: "Choose a picture", businessRemoveSignature: "Take the signature off",
    businessSave: "Save business details", businessSaved: "Saved. Every new bill carries this.", businessSaving: "Saving\u2026", businessGstinNote: "Your GST number is {gstin}, registered in {state}. The address on the bill must be in that state.", businessPanNote: "Your GST number already carries the PAN {pan}. A business has one PAN, so this must be the same.",
    setupAddress1: "Address line 1", setupAddress2: "Address line 2 (optional)", setupCity: "Town or city", setupPincode: "PIN code",
    navBranding: "Bill design", brandingEyebrow: "Your bill", brandingTitle: "Make the bill look like yours", brandingHelp: "Put your logo, your colour and a picture of your trade on the bill. All three are extra. A bill with none of them is still a complete, lawful bill.",
    brandingLogoTitle: "Your logo", brandingLogoHelp: "A PNG, JPG, WEBP or SVG picture. It is shrunk here before it is saved, and it prints about two centimetres tall at the top of the bill.", brandingNoLogo: "No logo yet", brandingChooseLogo: "Choose a picture", brandingRemoveLogo: "Take the logo off", brandingAccentTaken: "Headings and rules use this colour, taken from your logo.", brandingAccentReset: "Use the design's own colour",
    brandingMarkTitle: "The mark of your trade", brandingMarkHelp: "Type what you sell and pick a picture. It prints very faintly behind the items, and never on till-roll paper.", brandingSearchLabel: "What do you sell?", brandingSearchPlaceholder: "mithai, kapda, tyre, dawa", brandingSearchButton: "Find pictures", brandingMarkChosen: "On your bill:", brandingRemoveMark: "Take the picture off", brandingNoMarkResults: "Nothing matched that. Try another word for what you sell.",
    brandingDesignTitle: "Design and paper", brandingDesignLabel: "Bill design", brandingPaperLabel: "Paper", brandingPaperA4: "A4 sheet", brandingPaperThermal: "Till roll, 80mm", brandingThermalNote: "A till-roll printer has one ink and no grey, so the faint picture is never printed there.",
    brandingPreviewTitle: "A sample bill", brandingPreviewHelp: "Every figure below is made up. This is the real bill printer, so what you see here is what your customer gets.", brandingPreviewFrame: "Sample bill preview", brandingSaved: "Saved. New bills will carry this.", brandingSaving: "Saving…", brandingLoadFailed: "Could not load the preview.",
    brandingUpiTitle: "Take payment by UPI", brandingUpiHelp: "Save your UPI id once. Every bill then prints a square your customer scans with PhonePe, Google Pay or Paytm, with your name, the bill number and the amount still due already filled in. There is no square on a bill that is fully paid, or on small 58mm till-roll paper.", brandingUpiLabel: "Your UPI id", brandingUpiPlaceholder: "yourshop@okicici", brandingUpiSave: "Save UPI id", brandingUpiSaved: "Bills are paid to:", brandingUpiRemove: "Take the UPI id off",
    draftReady: "Your draft is ready to review", keepEditing: "Keep editing", understand: "I understand",
    // Issues #304 and #310 — the five tabs, the + Bill sheet, More, Items, and the new Home.
    mainNavigation: "Main menu", tabHome: "Home", tabKhata: "Khata", tabBill: "Bill", tabItems: "Items", tabMore: "More",
    billSheetTitle: "Make a new…", otherBills: "Other bills", navQuotation: "Quotation", navReturn: "Return", navExpense: "Expense", expenseSoon: "Expenses are coming soon.", booksTitle: "Expenses and the owner's money", booksHelp: "Rent, wages and other costs paid, cash put into or taken out of the bank, and money the owner put in or took out. Check each entry, then save it. A saved entry is never changed: undo it and enter it again.", booksExpense: "An expense paid", booksHead: "What was it for?", booksPaidFrom: "Paid from", booksCash: "Cash", booksBank: "Bank", booksAmount: "Amount before GST", booksConsignment: "Transport only: did the transporter give a consignment note (bilty / LR)?", booksConsignmentNo: "No (bus, train, taxi, auto, tempo hire)", booksConsignmentYes: "Yes", booksGstNote: "Bill shows GST, or rent with no GST? Enter it on Purchases, so the GST reaches your returns.", booksBill: "Bill number", booksNote: "Note", booksDate: "Date", booksOwner: "The owner's money", booksOwnerIn: "The owner put money in", booksOwnerOut: "The owner took money out for home", booksContra: "Cash and bank", booksDeposit: "Cash put into the bank", booksWithdraw: "Cash taken out of the bank", booksJournal: "Journal entry (accountant)", booksJournalHelp: "For adjustments and corrections. Both sides must be equal, and the note must say why.", booksAccount: "Account", booksDebit: "Debit", booksCreditSide: "Credit", booksWhat: "What happened?", booksAmountPlain: "Amount", booksCheck: "Check the entry", booksSave: "Save this entry", booksBookTitle: "Cash book and bank book", booksShowCash: "Cash book", booksShowBank: "Bank book", booksOpening: "Opening", booksClosing: "Closing", booksIn: "In", booksOut: "Out", booksBalance: "Balance", booksAgainst: "Against", booksEntries: "Entries made here", booksUndo: "Undo", booksUndoReason: "Why is this entry being undone?", booksOwedNote: "Not paid yet? Enter it as the supplier's bill on Purchases.",
    navGroupPeople: "People", navGroupBusiness: "Business settings", navGroupReports: "Reports",
    moreTitle: "More", moreHelp: "Everything else in your shop, in one place.",
    itemsTitle: "Items", itemsHelp: "What you sell and buy, and how much is left in the godown.", itemsAdd: "Add item", itemsEdit: "Change", itemsNone: "No items yet. Add the first thing you sell.",
    itemsLeft: "{quantity} {unit} left", itemsNoneLeft: "None left", itemsService: "Service", itemsLine: "HSN {code} · GST {rate}", itemsExempt: "exempt",
    homeGreeting: "Namaste, {company}", homeMoneyTitle: "Your money today", homeSalesToday: "Sales today", homeCash: "Cash in drawer", homeBank: "UPI and bank in today", homeToCollect: "To collect", homeToPay: "To pay",
    homeTasksTitle: "Needs you today", homeAllClear: "All clear for today", homeRecentBills: "Recent bills", homeNoBills: "No bills yet. Press + Bill to make the first one.",
    homeChipPaid: "Paid", homeChipDue: "{amount} due", homeChipLate: "{amount} · {days} days late", homeChipLateOne: "{amount} · 1 day late",
    payCash: "Cash", payUpi: "UPI", payCard: "Card", payBank: "Bank", payCheque: "Cheque", payUdhaar: "Udhaar"
  },
  "hi-IN": {
    // Issue #305 / #311 — the four-slide sale and the checks inside the bill.
    slideItems: "ग्राहक क्या ख़रीद रहा है?", slideCustomer: "कौन ख़रीद रहा है?", slidePayment: "पैसे कैसे दे रहे हैं?", slideTransport: "माल कैसे जा रहा है?", slideExport: "निर्यात की जानकारी", slideShipTo: "माल कहाँ जाएगा?", slideBack: "पीछे", slideNext: "आगे", makeBill: "बिल बनाइए", stepOf: "{count} में से क़दम {step}: {title}", newItemButton: "+ नया सामान", chargesSection: "भाड़ा या दूसरे ख़र्चे", customerAll: "सभी ग्राहक", newCustomerQuick: "+ नया ग्राहक", newCustomerQuickPlaceholder: "GST नंबर या मोबाइल लिखिए", newCustomerQuickGo: "जोड़िए", newCustomerQuickHelp: "GST नंबर से उनका राज्य भर जाता है। नाम और पता एक बार जोड़िए।", deliverElsewhere: "कहीं और पहुँचाना है", customerOwes: "{amount} बाक़ी", payUdhaar: "उधार", payPart: "कुछ पैसे मिले", payCheque: "चेक", payChequeNote: "चेक: बिल उधार पर बनाइए, और चेक आने पर उसे 'मिला पैसा' में दर्ज कीजिए।", payToday: "आज", fifteenDays: "15 दिन में", udhaarDays: "कब तक देंगे", paidNowAmount: "अभी मिले", billSummaryLabel: "बिल", transportEwayNote: "गाड़ी का नंबर हो तो बिल बनते ही ई-वे बिल अपने आप बन जाता है। नंबर न हो तो बिल होम पर रुका रहता है, जब तक गाड़ी पता न चले।", oneLess: "एक कम", oneMore: "एक ज़्यादा", lineFacts: "GST {rate}% · {stock} बचा", lineFactsGst: "GST {rate}%", checkEwayNeeded: "ई-वे बिल चाहिए — बिल बनने के बाद बनेगा", checkEwayNotNeeded: "ई-वे बिल की ज़रूरत नहीं", checkEinvoiceAuto: "ई-इनवॉइस अपने आप भेजा जाएगा", checkEinvoiceNotNeeded: "ई-इनवॉइस की ज़रूरत नहीं", vehicleFound: "{vehicle} परिवहन विभाग के रिकॉर्ड में है।", vehicleNotFound: "परिवहन विभाग के पास {vehicle} नंबर की कोई गाड़ी नहीं है। माल निकलने से पहले नंबर जाँच लीजिए।", vehicleNotChecked: "{vehicle} की जाँच अभी नहीं हो पाई। बिल फिर भी बन सकता है।", doneEwayRaised: "ई-वे बिल {number} अपने आप बन गया · {valid} तक", doneEwayWaiting: "इस माल को ई-वे बिल चाहिए। गाड़ी पता चलने तक ये होम पर रहेगा।", doneEwayFailed: "ई-वे बिल नहीं बना: {reason} ये होम पर है, फिर से कोशिश के लिए।", supplierCheckFine: "GST नंबर चालू है, रिटर्न समय पर", supplierCheckFailed: "सप्लायर की जाँच अभी नहीं हो पाई। बिल फिर भी दर्ज हो सकता है।", purchaseCheckLine: "ख़रीद जाँच (GSTR-2B): {line}",
    // Issues #312 and #303 — the sale review's two lines, and the #design page.
    reviewTurnoverUnknown: "अभी पता नहीं कि आपको ई-इनवॉइस चाहिए या नहीं: बिज़नेस विवरण में नहीं लिखा कि टर्नओवर ₹5 करोड़ से ऊपर गया है या नहीं। बिज़नेस विवरण में एक बार जवाब दीजिए। ये बिल अभी भी जारी हो सकता है।", reviewEinvoiceLate: "इस बिल को सरकारी ई-इनवॉइस नंबर चाहिए, लेकिन ये पोर्टल के लिए बहुत पुराना है।", designEyebrow: "सिर्फ़ मालिक", designTitle: "कारोबार कैसा दिखता है", designHelp: "रंग, शब्द, बटन, चिप, पैसे का कार्ड, बिल की स्लाइड और नीचे की पट्टी, अंग्रेज़ी और हिन्दी एक साथ।", designOwnerOnly: "ये पेज सिर्फ़ दुकान के मालिक खोल सकते हैं।", designTheme: "रंग:", designThemeDevice: "इस डिवाइस जैसा", designThemeLight: "उजला", designThemeDark: "अँधेरा", dsLanguage: "हिन्दी", dsButtons: "बटन: हर स्क्रीन पर एक ही मुख्य गेंदा-रंग बटन", dsMakeBill: "बिल बनाइए", dsSave: "सेव कीजिए", dsBack: "पीछे", dsLater: "बाद में", dsChips: "स्थिति चिप: रंग सिर्फ़ स्थिति बताता है", dsPaid: "चुकाया", dsDue: "7 दिन में देना है", dsLate: "12 दिन देर", dsWalkIn: "काउंटर ग्राहक", dsMoneyCard: "पैसे का कार्ड (आज आपकी दुकान)", dsToCollect: "ग्राहकों से लेना है", dsSalesToday: "आज की बिक्री", dsToPay: "सप्लायर को देना है", dsSlide: "बिल की स्लाइड: एक फ़ैसला, कुल रकम हमेशा दिखे", dsStepItems: "क्या बिक रहा है?", dsStepCustomer: "कौन ख़रीद रहा है?", dsStepPayment: "पैसे कैसे दे रहे हैं?", dsStepDone: "बिल बन गया", dsFineLine: "कर्नाटक में बिक्री · CGST + SGST · ई-वे बिल की ज़रूरत नहीं", dsCustomerPays: "ग्राहक देगा", dsNext: "आगे", dsAgain: "फिर से", dsBottomBar: "फ़ोन पर नीचे की पट्टी", dsHome: "होम", dsKhata: "खाता", dsBill: "बिल", dsItems: "सामान", dsMore: "और",
    skip: "सीधा मुख्य हिस्सा खोलिए", brandSubtitle: "बिल, स्टॉक और GST", navHome: "घर", navSale: "बिक्री", navPurchase: "ख़रीद", navPayment: "मिला पैसा", navMoney: "पैसा", navMore: "और", navStock: "गोदाम में क्या है", navGroupBuying: "ख़रीद", navGroupStock: "स्टॉक", navGroupSelling: "बिक्री", navGroupGst: "GST", navGroupBooks: "बही", navGroupSettings: "सेटिंग्स", navReturns: "वापसी", navActivity: "काम", navReports: "रिपोर्ट", navSetup: "बिज़नेस सेट अप कीजिए", primaryNavigation: "मुख्य नेविगेशन", companyHome: "कारोबार घर", workspaceNavigation: "मुख्य मेनू", menuOpen: "नेविगेशन खोलिए", notifications: "सूचनाएँ", signedIn: "Hanny Kumar के रूप में साइन इन", businessSummary: "बिज़नेस का सार", mobileNavigation: "मोबाइल नेविगेशन",
    deviceReady: "ड्राफ़्ट सुरक्षित है", draftProtection: "अधूरा काम इसी डिवाइस पर रहेगा।", companyLocation: "दिल्ली · मुख्य दुकान", language: "भाषा",
    today: "आज", welcome: "नमस्ते Hanny", welcomeBody: "आज आपकी दुकान का हाल।", newSale: "नई बिक्री",
    salesToday: "आज की बिक्री", salesChange: "कल से 12% ज़्यादा", customersOwe: "ग्राहकों से लेना है", fromCustomers: "8 ग्राहकों से", purchasesMonth: "इस महीने की ख़रीद", purchaseCount: "14 सप्लायर बिल", needsAttention: "ध्यान देना है", attentionBody: "1 ज़रूरी · 2 देखने हैं",
    recentActivity: "अभी का काम", recentBody: "आपके नए बिल और लेन-देन", viewAll: "सब देखिए", saleIssued: "बिक्री जारी · 11:42 AM", purchaseFrom: "Fresh Farms से ख़रीद", purchaseSaved: "आपके रिव्यू का इंतज़ार · 10:58 AM", paymentFrom: "Gupta Mart से पेमेंट", done: "हो गया", waiting: "इंतज़ार", recorded: "दर्ज है",
    yourAttention: "आपका ध्यान", attentionHelp: "काम रुकने से पहले इन्हें देखिए", lowStock: "Apple boxes कम हो रहे हैं", lowStockBody: "मुख्य दुकान पर 12 बॉक्स बचे हैं", approvalWaiting: "एक बिक्री इंतज़ार में है", approvalBody: "₹42,800 के लिए मालिक की मंज़ूरी चाहिए", gstReminder: "GST रिटर्न 6 दिन में है", gstBody: "पहले अधूरे सप्लायर बिल देखिए",
    stepOne: "3 में से क़दम 1", saleTitle: "बिक्री बनाइए", saleHelp: "सामान, ग्राहक, पेमेंट। ग्राहक कितना देगा, ये नीचे हमेशा दिखता है।", savedDevice: "इसी डिवाइस पर सेव", customer: "ग्राहक", date: "बिक्री की तारीख़", item: "सामान", quantity: "मात्रा", rate: "एक का दाम", freight: "भाड़ा", otherCharges: "दूसरे ख़र्चे", chargeReview: "{charge} · टैक्सेबल {amount} · GST {gst}", paymentTerms: "पेमेंट कब मिलेगा?", payNow: "अभी मिल गया", sevenDays: "7 दिन में", thirtyDays: "30 दिन में", moreDetails: "और जानकारी जोड़िए", reference: "ग्राहक रेफ़रेंस", notes: "नोट", saleSummary: "बिक्री का सार", itemTotal: "GST से पहले सामान", gstEstimate: "GST", amountCustomerPays: "ग्राहक देगा", taxSafety: "GST और टोटल लिखते-लिखते उसी नियम से बनते हैं जिससे बिल बनता है। बिल दर्ज करने तक कुछ सेव नहीं होता।", roundOff: "राउंड ऑफ़", estimateChooseCustomer: "GST देखने के लिए ग्राहक चुनिए: उनका राज्य तय करता है कौनसा GST लगेगा।", estimateChooseItem: "टोटल देखने के लिए सामान चुनिए।", editItemButton: "सामान बदलिए", reviewSale: "बिक्री देखिए", discardDraft: "ड्राफ़्ट हटा दीजिए",
    purchaseTitle: "ख़रीद दर्ज कीजिए", purchaseHelp: "सप्लायर बिल जोड़िए। विवरण देखने तक ये अधूरा रहेगा।", supplier: "सप्लायर", supplierBill: "सप्लायर बिल नंबर", billDate: "बिल की तारीख़", billAmount: "बिल की रकम", uploadBill: "बिल का फ़ोटो या PDF", uploadHelp: "फ़ाइल सिर्फ़ यहाँ देखी जाती है। अपलोड नहीं होती।", beforeSaving: "सेव होने से पहले", checkSupplier: "हम सप्लायर पक्का करेंगे", checkDuplicate: "हम वही बिल दोबारा होने से रोकेंगे", checkTax: "आप हर टैक्स रकम देखेंगे", purchaseSafety: "इस ड्राफ़्ट को देखने से स्टॉक, देना पैसा या GST नहीं बदलेगा।", billAmountHelp: "बिल पर छपी हुई टोटल रकम। अगर ये लाइनों के जोड़ से न मिले, तो हम दर्ज करने के बजाय आपको बता देंगे।", whatYouBought: "आपने क्या ख़रीदा", itemSteel: "TMT Steel Bar 12mm (वज़न से बिकता है)", itemSoap: "Herbal Bath Soap 100g (बॉक्स में बिकता है)", itemFreight: "अंदर आने का भाड़ा (सर्विस है, स्टॉक नहीं)", howMany: "कितना", ratePerUnit: "एक का दाम, GST से पहले", gstRate: "बिल पर GST रेट", purchaseLinesLabel: "इस सप्लायर बिल की चीज़ें", purchaseTaxFromGstin: "इस बिल पर IGST लगेगा या CGST और SGST, ये सप्लायर के GST नंबर और आपके GST नंबर से तय होता है — बिना GST नंबर वाले सप्लायर के लिए, उनके पते के राज्य से।", postingTitle: "दर्ज करने पर क्या होगा", postingStock: "सामान आपके गोदाम में आ जाएगा", postingBooks: "ख़रीद, और जो GST वापस मिल सकता है, आपकी बही में आ जाएगी", postingOwed: "सप्लायर को जो देना है वो बन जाएगा, तारीख़ के साथ", postingTogether: "तीनों एक साथ होते हैं। एक भी न हो पाया, तो कुछ भी सेव नहीं होगा।", postingRetrySafe: "पक्का नहीं है कि हुआ या नहीं? दोबारा दबाइए। एक ही बिल दो बार कभी दर्ज नहीं होता।", reviewPurchase: "ख़रीद देखिए",
    paymentTitle: "मिला पैसा दर्ज कीजिए", paymentHelp: "किसने कितना दिया, दर्ज कीजिए। बिल अभी चुनिए या बाद में।", receivedFrom: "किस से मिला", amountReceived: "मिली रकम", paymentDate: "पेमेंट की तारीख़", paymentMethod: "पेमेंट कैसे हुआ?", cash: "नक़द", bankTransfer: "बैंक ट्रांसफ़र", cheque: "चेक", chooseBill: "ये किस बिक्री का पेमेंट है?", chooseLater: "बाद में चुनिए", chooseBillHelp: "जिन बिलों का ये पैसा है, उन पर टिक कीजिए। कोई टिक न हो, या पैसा बिलों से ज़्यादा हो, तो बाक़ी इस ग्राहक के खाते में अलग दिखेगा।", paymentSummary: "पेमेंट का सार", paymentSafety: "ये ड्राफ़्ट है। रिव्यू और सेव होने तक ग्राहक का बाक़ी पैसा कम नहीं होगा।", reviewPayment: "पेमेंट देखिए",
    navPaid: "दिया पैसा", paidTitle: "सप्लायर को दिया पैसा दर्ज कीजिए", paidHelp: "सप्लायर चुनिए, जिन बिलों का पेमेंट है उन पर टिक कीजिए, और बताइए कैसे दिया।", paidTo: "किसको दिया", amountPaid: "दी गई रकम", paidDate: "देने की तारीख़", paidMethod: "आपने कैसे दिया?", chooseSupplierBill: "ये किन बिलों का पेमेंट है", chooseSupplierBillHelp: "सप्लायर के जिन बिलों का ये पैसा है, उन पर टिक कीजिए। बिल से पहले दे रहे हैं? नीचे एडवांस चुनिए।", advanceChoice: "इसे {supplier} को एडवांस के रूप में दर्ज कीजिए", advanceHelpNoBill: "{supplier} का अभी कोई बिल नहीं है। ये पैसा एडवांस रहेगा और उनके अगले बिल से कटा जाएगा।", advanceHelpMore: "जो पैसा ऊपर टिक किए बिलों के सामने नहीं लगा, वो एडवांस रहेगा और {supplier} के अगले बिल से कटा जाएगा।", advanceAlready: "{supplier} के पास पहले से एडवांस: {amount}।", advancePoNumber: "किस परचेज़ ऑर्डर के सामने (नंबर, ज़रूरी नहीं)", advancePoDate: "परचेज़ ऑर्डर की तारीख़", advancePoHelp: "परचेज़ ऑर्डर नहीं है? दोनों खाली छोड़िए; वाउचर पर लिखा होगा कि एडवांस आने वाले माल (goods to be supplied) के सामने है।", advanceReceiptNumber: "सप्लायर का रसीद वाउचर नंबर (ज़रूरी नहीं)", advanceReceiptDate: "रसीद वाउचर की तारीख़", advanceReceiptHelp: "एडवांस मिलने पर सप्लायर रसीद वाउचर देता है। आपके पास हो तो भरिए; ये पेमेंट वाउचर पर छपेगा।", printAdvanceVoucher: "एडवांस वाउचर प्रिंट कीजिए", supplierAdvances: "सप्लायर्स को दिया एडवांस: {amount}", useAdvanceOnBill: "{supplier} को दिया {amount} एडवांस इस बिल से काटिए", paidSummary: "पेमेंट का सार", paidSafety: "ये ड्राफ़्ट है। रिव्यू और सेव होने तक सप्लायर का बाक़ी कम नहीं होगा।", reviewPaid: "पेमेंट देखिए",
    choosePaymentCustomer: "जिस ग्राहक ने दिया, उसे चुनिए", choosePaymentSupplier: "जिस सप्लायर को दिया, उसे चुनिए", chequeNumber: "चेक नंबर", chequeDate: "चेक पर लिखी तारीख़", paymentReferenceLabel: "रेफ़रेंस (UTR या UPI नंबर, ज़रूरी नहीं)", noOpenBills: "कोई बिल बाक़ी नहीं है।", chooseAPartyFirst: "पहले चुनिए किससे लेन-देन है; उनके खुले बिल यहाँ दिखेंगे।", openBillLine: "{number} · {date} · बिल {total} · बाक़ी {due}", printVoucher: "प्रिंट", receiptTitle: "रसीद {number}", paymentVoucherTitle: "पेमेंट वाउचर {number}", chooseSaleCustomer: "ग्राहक चुनिए", cancelBill: "ये बिल रद्द कीजिए", cancelBillReason: "ये बिल क्यों रद्द हो रहा है?", cancelBillReasonHelp: "बिल के साथ और ऑडिट रिकॉर्ड में रहेगा। बिल का नंबर इस्तेमाल हो चुका है और दोबारा कभी नहीं दिया जाएगा।", cancelBillConfirm: "बिल रद्द कीजिए", cancelGovernmentFirst: "पहले सरकार के साथ रद्द कीजिए, फिर ये बिल", cancelBillChecking: "देख रहे हैं कि बिल रद्द करने से क्या होगा…", billCancelledNote: "ये बिल रद्द हो चुका है। अपने नंबर के साथ CANCELLED लिखा हुआ रिकॉर्ड में रहेगा।", makeWholeBillNote: "पूरे बिल का क्रेडिट नोट बनाइए", wholeBillChoice: "पूरा बिल · हर सामान और ख़र्चा · {amount} क्रेडिट करना बाक़ी", documentsIssued: "इस्तेमाल हुए बिल और नोट नंबर (GSTR-1 टेबल 13)", documentsIssuedLine: "{from} से {to}: {total} नंबर इस्तेमाल हुए, {cancelled} रद्द, {issued} गिने गए", documentKindINVOICE: "इनवॉइस", documentKindCREDIT_NOTE: "क्रेडिट नोट", documentKindDEBIT_NOTE: "डेबिट नोट", documentKindADVANCE_RECEIPT: "रसीद वाउचर (एडवांस)", documentKindREFUND_VOUCHER: "रिफ़ंड वाउचर", documentKindDELIVERY_CHALLAN_JOB_WORK: "जॉब वर्क के चालान", documentKindDELIVERY_CHALLAN_APPROVAL: "अप्रूवल पर भेजे सामान के चालान", documentKindDELIVERY_CHALLAN_LIQUID_GAS: "लिक्विड गैस के चालान", documentKindDELIVERY_CHALLAN_OTHER: "बाक़ी डिलीवरी चालान",
    noteHelp: "ये पन्ना ग्राहक को दीजिए। इस पर वो बिल लिखा है जिसके सामने ये नोट है, ताकि वो अपना GST क्रेडिट वापस कर सके।", notePrint: "नोट प्रिंट कीजिए", noteFrame: "छपा हुआ नोट", notesTitle: "जारी किए गए क्रेडिट और डेबिट नोट", noteAgainst: "{number} के सामने", notePrintAction: "प्रिंट", noteNotPrintable: "प्रिंट की सुविधा से पहले दर्ज हुआ", returnsTitle: "वापसी दर्ज कीजिए", returnsHelp: "असली बिल और वापस आया सामान चुनिए। असली बिल नहीं बदलेगा; जुड़ा हुआ क्रेडिट या डेबिट नोट सुधार दर्ज करेगा।", originalBill: "असली ग्राहक या सप्लायर बिल", returnItem: "वापस हो रहा सामान", returnQuantity: "वापस मात्रा", disposition: "सामान का क्या होगा", dispAccepted: "सही स्टॉक में वापस रखिए", dispDamaged: "ख़राब स्टॉक में रखिए", dispScrapped: "वापस लेकर स्क्रैप कीजिए", dispReplacement: "बदला हुआ सामान आएगा", returnDate: "वापसी की तारीख़", returnReference: "वापसी रेफ़रेंस", returnReason: "वापस क्यों हो रहा है?", returnReasonHelp: "ये वज़ह ऑडिट रिकॉर्ड में रहेगी।", returnRemaining: "बची हुई एलिजिबल मात्रा देखने के लिए बिल चुनिए।", returnEligible: "असली बिल पर अभी {quantity} {unit} वापस हो सकता है।", returnLineChoice: "{item} · {quantity} {unit} बचा", customerSale: "ग्राहक की बिक्री", supplierPurchase: "सप्लायर की ख़रीद", returnCheckQuantity: "वापस मात्रा असली एलिजिबल मात्रा से ज़्यादा नहीं हो सकती", returnCheckBooks: "स्टॉक, GST और ग्राहक या सप्लायर बैलेंस एक साथ बदलेंगे", returnCheckCompliance: "सरकारी ई-इनवॉइस नंबर वाले बिल का नोट भी रिपोर्ट होता है", returnSafety: "जाँचने से कुछ नहीं बदलता। दर्ज करने पर जुड़ा हुआ नोट बनता है; असली बिल कभी बदलता या छुपता नहीं।", checkReturn: "वापसी देखिए", noReturnDocuments: "वापसी के लिए अभी कोई जारी बिल नहीं है।", returnActivity: "रिटर्न दर्ज हुआ; असली बिल वैसा ही रहेगा", customerReturnChecked: "ग्राहक वापसी जाँच ली", supplierReturnChecked: "सप्लायर वापसी जाँच ली", returnCheckedBody: "जाँची हुई वापसी {amount} की है।", returnCustomerEffect: "क्रेडिट नोट ग्राहक से लेने वाली रकम घटाएगा।", returnSupplierEffect: "डेबिट नोट सप्लायर को देने वाली रकम घटाएगा।", returnSalesStockEffect: "सही सामान स्टॉक में वापस जाएगा।", lineDiscount: "छूट (₹)", lineDiscountPercent: "या छूट (%)", billDiscount: "पूरे बिल पर छूट", returnCause: "दाम क्यों बदला", causeInvoiceError: "बिल पर ग़लत दाम लगा था", causeDiscountAfterSale: "बिक्री के बाद दी गई छूट", causeChoose: "वज़ह चुनिए", returnMode: "क्या बदला", returnModeGoods: "सामान या सेवा वापस आई", returnModePrice: "दाम सुधार (कुछ वापस नहीं आया)", returnNewRate: "एक का नया दाम, GST से पहले", returnAmountOff: "या कितना कम, GST से पहले", returnPriceHelp: "नया दाम या कितना कम, लिखिए। दाम कम हो तो क्रेडिट नोट बनेगा, ज़्यादा हो तो डेबिट नोट। स्टॉक नहीं बदलेगा।", returnNoStockEffect: "स्टॉक में कुछ नहीं आएगा, न जाएगा।", priceLowerChecked: "कम दाम जाँच लिया", priceHigherChecked: "ज़्यादा दाम जाँच लिया", priceDebitEffect: "डेबिट नोट ग्राहक से लेने वाली रकम बढ़ाएगा।", priceCorrectionRecorded: "दाम सुधार दर्ज हो गया", returnPurchaseStockEffect: "वापस सामान स्टॉक से बाहर जाएगा।", returnComplianceEffect: "इस बिल का सरकारी ई-इनवॉइस नंबर है, इसलिए ये नोट भी सरकार को रिपोर्ट करना होगा।", returnNoComplianceEffect: "इस नोट के लिए सरकार को अलग से कुछ रिपोर्ट नहीं करना।", returnRecorded: "वापसी दर्ज हुई", returnAlreadyRecorded: "वापसी पहले ही एक बार दर्ज है", returnRecordedBody: "असली बिल बदले बिना जुड़ा नोट {number} दर्ज हुआ।",
    workspace: "आपकी दुकान", activityTitle: "सारा काम", activityHelp: "हर पूरा काम उसके समय और स्थिति के साथ यहाँ दिखेगा।", createFirstSale: "बिक्री बनाइए",
    setupTitle: "बिज़नेस सेट अप कीजिए",
    setupHelp: "कुछ सवालों के जवाब दीजिए, हम उसके लिए असली बुक्स खोल देंगे। आपका GST नंबर और शुरुआती आँकड़े जाँचे जाते हैं, माने नहीं जाते।",
    setupAbout: "बिज़नेस के बारे में",
    setupName: "इसका नाम क्या है?",
    setupKind: "किस तरह का काम?",
    setupChoose: "एक चुनिए",
    setupRetail: "रिटेल दुकान",
    setupWholesale: "थोक",
    setupBakery: "बेकरी",
    setupServices: "सर्विसेज़",
    setupTransport: "ट्रांसपोर्ट",
    setupManufacturing: "मैन्युफ़ैक्चरिंग",
    setupState: "कौनसा राज्य?",
    setupPhone: "फ़ोन (मर्ज़ी से)",
    setupGstBooks: "GST और बुक्स",
    setupRegistered: "GST में रजिस्टर्ड हैं?",
    setupRegular: "हाँ, रेगुलर",
    setupComposition: "हाँ, कम्पोज़िशन",
    setupUnregistered: "रजिस्टर्ड नहीं",
    setupGstin: "GST नंबर",
    setupFiling: "GST कितनी बार भरते हैं?",
    setupMonthly: "हर महीने",
    setupQuarterly: "तीन महीने में",
    setupBooksFrom: "हिसाब कब से रखें",
    setupOneThing: "एक चीज़ जो आप बेचते हैं",
    setupItemName: "इसका नाम",
    setupGoodsOrService: "माल या सर्विस?",
    setupGoods: "माल",
    setupService: "सर्विस",
    setupCounted: "इसे कैसे गिनते हैं?",
    setupHsn: "HSN या SAC कोड (मर्ज़ी से)",
    setupRateLegend: "मर्ज़ी से — आप जो GST लेते हैं",
    setupRateHint: "आप रेट बताएंगे तो हम उसे आपका रेट लिखेंगे और बिल पर भी यही लिखा जाएगा। हम ख़ुद कभी नहीं चुनते।",
    setupRateCode: "किस माल या सर्विस के कोड के लिए?",
    setupRatePercent: "कितने फ़ीसदी का रेट?",
    setupRateBasis: "ये रेट कहाँ से आया?",
    setupMoneyLegend: "मर्ज़ी से — पहले दिन का पैसा",
    setupMoneyHint: "जिस नक़द से आपने शुरू किया। हम उसे आपके अपने पैसे के सामने लिखते हैं, ताकि हिसाब बराबर रहे।",
    setupOpeningCash: "पहले दिन हाथ में नक़द",
    setupCheck: "सेटअप जाँचिए",
    setupCreate: "बिज़नेस बनाइए",
    reportsTitle: "रिपोर्ट",
    reportsHelp: "नीचे का हर आँकड़ा इस कंपनी के लेजर, बिक्री, स्टॉक और लेना-देना से अभी निकाला गया है। कुछ भी लिख कर नहीं डाला गया।",
    reportsLoading: "आपकी रिपोर्ट आ रही है…",
    signOut: "साइन आउट कीजिए", loginTitle: "कारोबार में साइन इन कीजिए", loginHelp: "अपना मोबाइल नंबर या ईमेल लिखिए। हम आपको कोड भेजेंगे।", signInAddress: "मोबाइल नंबर या ईमेल", signInCode: "कोड", sendCode: "मुझे कोड भेजिए", signIn: "साइन इन", signInAsTester: "टेस्टर के रूप में साइन इन करें", codeSent: "हमने कोड भेजा है। उसे यहाँ लिखिए।", changeAddress: "दूसरा नंबर या ईमेल", switchCompany: "बिज़नेस",
    salesFromModule: "आज के बिलों से", openSalesInvoices: "जिन बिलों का पैसा नहीं आया", postedSupplierBills: "सप्लायर के बिलों से", calculatedLive: "आपके लिए बाक़ी काम", loadingActivity: "दर्ज काम लोड हो रहा है…", loadingStock: "स्टॉक लोड हो रहा है…", readingInventory: "स्टॉक देख रहे हैं…", loadingSupplier: "सप्लायर बैलेंस लोड हो रहा है…", readingReceivables: "सप्लायर का बाक़ी देख रहे हैं…",
    exportSection: "एक्सपोर्ट या SEZ सप्लाई", exportKindOverseas: "ये ग्राहक भारत के बाहर है, इसलिए ये बिल एक्सपोर्ट है।", exportKindSez: "ये ग्राहक SEZ में है। बिल पर यही लिखा जाएगा, SEZ वाली घोषणा के साथ।", exportKindDeemed: "ये ग्राहक डीम्ड एक्सपोर्ट में ख़रीदता है। GST हमेशा की तरह लगेगा और बिल पर ये लिखा होगा।",
    underLutLabel: "ये एक्सपोर्ट कैसे हो रहा है?", underLutYes: "LUT या बॉन्ड पर — GST नहीं लगेगा", underLutNo: "IGST भरकर", exportCountryLabel: "माल किस देश जा रहा है", exportCountryHelp: "दो अक्षर: UAE के लिए AE, अमेरिका के लिए US।", exportCurrencyLabel: "बिक्री किस करेंसी में", exportCurrencyHelp: "ग्राहक रुपये में दे रहा हो तो खाली छोड़िए।", exchangeRateLabel: "उस करेंसी की एक यूनिट कितने रुपये",
    shippingBillNumberLabel: "शिपिंग बिल नंबर", shippingBillHelp: "अक्सर बिल के बाद बनता है। जब तक न मिले, खाली छोड़िए।", shippingBillDateLabel: "शिपिंग बिल की तारीख़", portCodeLabel: "पोर्ट कोड", portCodeHelp: "कस्टम्स के छह अक्षर, जैसे न्हावा शेवा के लिए INNSA1।",
    customerOverseas: "भारत के बाहर (एक्सपोर्ट)", customerSezWithoutPayment: "SEZ यूनिट — LUT पर सप्लाई", customerSezWithPayment: "SEZ यूनिट — IGST के साथ सप्लाई", customerDeemedExport: "डीम्ड एक्सपोर्ट ख़रीदार",
    deliveryAndReferences: "डिलीवरी, ट्रांसपोर्ट और रेफ़रेंस", shipToWhere: "माल कहाँ जा रहा है?",
    shipToSame: "ग्राहक के बिल वाले पते पर", shipToAddress: "इसी ग्राहक के दूसरे पते पर", shipToParty: "किसी और को, इस ग्राहक के कहने पर",
    shipToWhichAddress: "कौनसा पता?", shipToWhichParty: "माल कौन लेगा?", addDeliveryAddress: "＋ डिलीवरी का पता जोड़िए",
    placeOfSupplyPending: "ग्राहक चुनिए, फिर पता चलेगा कि ये बिक्री किस राज्य की है।", placeOfSupplyIs: "ये बिक्री इस राज्य की है:",
    placeOfSupplyBilling: "माल ग्राहक के बिल वाले पते पर जा रहा है।", placeOfSupplyMovementEnds: "माल का सफ़र वहीं ख़त्म होता है।",
    placeOfSupplyThirdParty: "माल ग्राहक के कहने पर किसी और को जा रहा है, इसलिए बिक्री वहाँ की है जहाँ ग्राहक है।",
    transporterLabel: "ट्रांसपोर्टर", noTransporter: "कोई ट्रांसपोर्टर नहीं", addTransporter: "＋ ट्रांसपोर्टर जोड़िए",
    vehicleNumberLabel: "गाड़ी नंबर", vehicleNumberHelp: "जिस लॉरी से माल जा रहा है। ये उस बिल पर छपता है जो ड्राइवर के पास रहता है।",
    lrNumberLabel: "LR / RR नंबर", lrNumberHelp: "ट्रांसपोर्टर की अपनी रसीद का नंबर, जिससे गुम हुआ माल ढूँढा जाता है।", lrDateLabel: "LR / RR की तारीख़",
    destinationLabel: "कहाँ पहुँचेगा", destinationHelp: "डिलीवरी के पते से लिया गया है। ग़लत हो तो बदल दीजिए।",
    ewayBillNumberLabel: "ई-वे बिल नंबर", ewayBillNumberHelp: "12 अंक। अगर ई-वे बिल यहीं बनाएंगे तो खाली छोड़ दीजिए — नंबर बाद की हर कॉपी पर छप जाएगा।",
    buyerOrderLabel: "ग्राहक का ऑर्डर नंबर", modeOfPaymentLabel: "पेमेंट का तरीक़ा", modeOfPaymentHelp: "पेमेंट कब मिलेगा, उससे लिया गया है। बिल पर कुछ और लिखना हो तो बदल दीजिए।",
    termsOfDeliveryLabel: "डिलीवरी की शर्तें", otherReferencesLabel: "अन्य रेफ़रेंस",
    addTransporterTitle: "ट्रांसपोर्टर जोड़िए", addTransporterHelp: "बिल पर इनका नाम \u201cDispatched through\u201d में छपता है।",
    transporterName: "ट्रांसपोर्टर का नाम", transporterId: "GST नंबर, या ट्रांसपोर्टर ID", transporterIdHelp: "15 अक्षर। जो ट्रांसपोर्टर GST में रजिस्टर्ड नहीं है उसे ट्रांसपोर्टर ID मिलती है; दोनों यहीं आते हैं।",
    transporterPhone: "फ़ोन (मर्ज़ी से)", saveTransporter: "ट्रांसपोर्टर सेव कीजिए",
    addAddressTitle: "डिलीवरी का पता जोड़िए", addAddressHelp: "ये ग्राहक जिस दूसरी जगह माल लेता है। ग्राहक पर सेव हो जाता है, अगली बार लिखना नहीं पड़ेगा।", correctAddress: "पता सही कीजिए", correctAddressTitle: "इस ग्राहक का पता या उधार सीमा सही कीजिए", correctAddressHelp: "ग़लत गली, शहर या PIN कोड ठीक कीजिए, या उनकी उधार सीमा तय कीजिए। पहले जारी हुए बिल पर वही पता रहेगा जो तब था। राज्य वैसा ही रहेगा, क्योंकि टैक्स उसी से तय होता है।", addressCorrected: "पता सही हो गया", addressStateFixed: "राज्य:",
    addressLabelName: "इसे क्या कहें", deliveryStateHelp: "दूसरे राज्य भेजा गया माल इस बिक्री को उस राज्य की बना देता है।",
    deliveryGstinHelp: "सिर्फ़ तब जब इस पते का अपना GST नंबर हो। न हो तो खाली छोड़ दीजिए।", saveAddress: "पता सेव कीजिए", saveCorrection: "बदलाव सेव कीजिए",
    saleLinesLabel: "इस बिल का सामान", addLine: "एक और सामान जोड़िए", removeLine: "हटाइए", addCustomer: "＋ नया ग्राहक जोड़िए", addItem: "＋ नया सामान जोड़िए", itemSearchPlaceholder: "नाम, कोड, HSN या स्कैन", scanButton: "स्कैन", scanTitle: "कैमरा से बारकोड स्कैन कीजिए", scanHint: "बारकोड को कैमरा के सामने रखिए। वो अपने आप पढ़ लिया जाएगा।", cameraRefused: "कैमरा नहीं खुल सका। इस साइट को कैमरा की अनुमति दीजिए, या बारकोड बॉक्स में लिखिए।", mostSoldThisWeek: "इस हफ़्ते सबसे ज़्यादा बिका", newItemFromSearch: "＋ नया सामान", newItemWithCode: "＋ बारकोड {code} के साथ नया सामान", noItemMatch: "कोई सामान नहीं मिला। स्पेलिंग देखिए, या नया सामान जोड़िए।", priceLastCharged: "पिछली बार इनसे लिया: {amount}, {date}", priceLastCounter: "काउंटर पर पिछला दाम: {amount}, {date}", priceUsual: "आम दाम", itemBarcode: "बारकोड (ज़रूरी नहीं)", itemBarcodeHelp: "यहाँ स्कैन कीजिए, या लकीरों के नीचे के अंक लिखिए। फिर बिक्री स्क्रीन पर स्कैन करते ही ये सामान जुड़ जाएगा।", itemPrice: "आम बिक्री दाम (ज़रूरी नहीं)", itemPriceHelp: "नया बिल इसी दाम से शुरू होता है, जब तक इस ग्राहक से पिछली बार अलग दाम न लिया गया हो।", itemOtherName: "दूसरा नाम (ज़रूरी नहीं)", itemOtherNameHelp: "ढूँढने के लिए एक और नाम, हिन्दी या किसी भी भाषा में — जैसे साबुन।",
    // Issue #295 — money received par har bill ke adjustments.
    settleAnotherWay: "किसी और तरह भी सेटल हुआ? (TDS, डिस्काउंट, राइट-ऑफ़)", tdsDeducted: "ग्राहक ने TDS काटा — रक़म", tdsSection: "TDS सेक्शन", tdsSectionChoose: "चुनिए…", tdsQuarter: "क्वार्टर", tdsCertificate: "सर्टिफ़िकेट नंबर (ज़रूरी नहीं)", discountAllowed: "डिस्काउंट दिया — रक़म", discountAsCreditNote: "इस डिस्काउंट का GST क्रेडिट नोट बनाइए", cnAgreed: "डिस्काउंट बिक्री के वक़्त या पहले तय हुआ था", cnItc: "ग्राहक ने अपना GST क्रेडिट वापस दे दिया है", writeOffSmall: "छोटा बाक़ी माफ़ करें — रक़म", writeOffLimitHelp: "एक बिल पर {limit} तक का राइट-ऑफ़ हो सकता है. बिज़नेस डिटेल्स में बदल सकते हैं.", writeOffLimit: "एक बिल पर राइट-ऑफ़ की सीमा (₹)", writeOffLimitHelpForm: "मिले पैसे पर एक बिल का कितना बाक़ी माफ़ किया जा सकता है.",
    // Issues #288 and #307 — the walk-in customer, money taken at the counter, and the done screen.
    walkInCustomer: "वॉक-इन / नक़द ग्राहक", walkInShort: "वॉक-इन ग्राहक", walkInChoose: "वॉक-इन ग्राहक", walkInDetail: "{state} में आपके काउंटर पर बिक्री। ₹50,000 से कम पर नाम या पता ज़रूरी नहीं।", placeOfSupplyCounter: "माल आपके काउंटर पर दिया जा रहा है।",
    paidBy: "कैसे मिला", paidCash: "नक़द", paidUpi: "UPI", paidCard: "कार्ड", saleEffectPaid: "अभी {mode} से {amount} मिले। इस बिल पर कुछ बाक़ी नहीं।", saleEffectPartPaid: "अभी {mode} से {amount} मिले। {due} ग्राहक के खाते में जुड़ेगा।",
    walkInNameRequired: "₹50,000 या उससे ज़्यादा की टैक्सेबल वैल्यू पर बिल में ख़रीदार का नाम, पता और राज्य होना चाहिए (CGST Rule 46(e))। ग्राहक को जोड़िए, फिर उन्हें चुनिए।", walkInDelivery: "वॉक-इन ग्राहक माल काउंटर पर लेता है। कहीं और भेजना हो तो ग्राहक को नाम और पते के साथ जोड़िए।", addNamedCustomer: "ग्राहक का नाम और पता जोड़िए", dateItToday: "आज की तारीख़ डालिए", billPaperThermal58: "छोटी परची, 58mm",
    doneTitle: "बिल बन गया", doneWhatsapp: "WhatsApp पर भेजिए", donePhoneLabel: "ग्राहक का WhatsApp नंबर", donePhoneHelp: "उनकी चैट खोलने के लिए 10 अंकों का मोबाइल नंबर लिखिए।", donePhoneInvalid: "ये 10 अंकों का मोबाइल नंबर नहीं है। देखकर दोबारा लिखिए।", doneUpiIncluded: "संदेश में {due} के लिए UPI लिंक है।", doneUpiMissing: "बिल के साथ पेमेंट लिंक भेजने के लिए ब्रांडिंग में अपनी UPI आईडी सेव कीजिए।",
    donePrinter: "प्रिंटर", doneA4: "A4 पन्ना", done80: "3-इंच परची", done58: "2-इंच परची", donePrint: "रसीद प्रिंट कीजिए", doneNewBill: "नया बिल",
    doneLinePaid: "{name} से {mode} मिल गया। स्टॉक अपडेट हो गया।", doneLinePart: "{mode} से {paid} मिले; {due} {name} के खाते में जुड़े। स्टॉक अपडेट हो गया।", doneLineKhata: "{name} के खाते में जुड़ गया। स्टॉक अपडेट हो गया।", doneModeCASH: "नक़द", doneModeUPI: "UPI", doneModeCARD: "कार्ड",
    doneMessageBill: "नमस्ते{name}, {shop} से ख़रीदने के लिए धन्यवाद। बिल {number}: {amount}।", doneMessagePaid: "पूरा भुगतान मिल गया।", doneMessageDue: "अभी बाक़ी: {due}।", doneMessageUpi: "UPI से चुकाइए: {link}",
    noCustomersYet: "अभी कोई ग्राहक सेव नहीं है", noItemsYet: "अभी कोई सामान सेव नहीं है", cancel: "रहने दीजिए",
    addSupplier: "＋ नया सप्लायर जोड़िए", noSuppliersYet: "अभी कोई सप्लायर नहीं", addSupplierTitle: "सप्लायर जोड़िए", addSupplierHelp: "उनके बिल पर जैसा छपा है वैसा ही भरिए। उनका राज्य उनके GST नंबर से पढ़ा जाता है।", supplierLegalName: "उनके बिल पर नाम", supplierRegistration: "GST रजिस्ट्रेशन", supplierRegular: "रजिस्टर्ड (GST नंबर है)", supplierComposition: "कम्पोज़िशन डीलर (GST नंबर है, GST नहीं लगाता)", supplierUnregistered: "रजिस्टर्ड नहीं (GST नंबर नहीं)", supplierRegularHelp: "उनके बिल पर GST होता है, और आप उसे वापस ले सकते हैं।", supplierCompositionHelp: "कम्पोज़िशन डीलर GST नहीं ले सकता (CGST s.10(4))। उनके बिल पर GST नहीं होता, और क्रेडिट नहीं मिलता।", supplierUnregisteredHelp: "बिना GST नंबर वाला विक्रेता GST नहीं ले सकता (CGST s.32(1)), और उनके बिल पर क्रेडिट नहीं मिलता (s.16(2)(a))।", supplierBasis: "वो रजिस्टर्ड क्यों नहीं हैं?", supplierBasisChoose: "कारण चुनिए", supplierBasisThreshold: "टर्नओवर सीमा से कम (CGST s.22)", supplierBasisFarmer: "किसान, अपनी उपज बेचते हैं (s.23(1)(b))", supplierBasisExempt: "सिर्फ़ छूट वाला सामान या सेवा बेचते हैं (s.23(1)(a))", supplierGstinHelp: "पहले दो अंक उनका राज्य हैं। इससे तय होता है कि उनके बिल पर IGST लगेगा या CGST और SGST।", saveSupplier: "सप्लायर सेव कीजिए", addCustomerTitle: "ग्राहक जोड़िए", addCustomerHelp: "बिल पर यही नाम, पता और GST नंबर छपेगा, इसलिए सही होना चाहिए।",
    customerLegalName: "ग्राहक का बिल वाला नाम", customerRegistration: "GST में रजिस्टर्ड हैं?", customerRegular: "हाँ, रेगुलर", customerComposition: "हाँ, कम्पोज़िशन", customerUnregistered: "रजिस्टर्ड नहीं",
    customerGstin: "GST नंबर", customerGstinHelp: "आख़िरी अक्षर को बाक़ी नंबर से मिलाकर देखते हैं, ताकि ग़लत डिजिट यहीं पकड़ी जाए।",
    customerAddress1: "पते की पहली लाइन", customerAddress2: "पते की दूसरी लाइन (मर्ज़ी से)", customerCity: "शहर या कस्बा", customerPincode: "PIN कोड", customerState: "कौनसा राज्य?",
    customerStateHelp: "रजिस्टर्ड ग्राहक का राज्य उनके GST नंबर के पहले दो अंक से आता है, और बदला नहीं जा सकता।",
    customerPhone: "फ़ोन (मर्ज़ी से)", saveCustomer: "ग्राहक सेव कीजिए",
    customerCreditLimit: "उधार सीमा ₹ में (मर्ज़ी से)", customerCreditLimitHelp: "ये ग्राहक आपका ज़्यादा से ज़्यादा कितना बाक़ी रख सकता है। खाली छोड़िए तो कोई सीमा नहीं, और उनका कोई बिल सीमा से नहीं जाँचा जाएगा।", customerCreditLimitShown: "उधार सीमा {amount}",
    itemCodeTitle: "सामान बदलिए", itemCodeCurrent: "{item} का कोड {code} है ({digits} अंक)।", itemCodeNew: "नया HSN या SAC कोड", itemCodeHelp: "जितने अंक आपके पास हैं, सब भरिए। ज़्यादा अंक हमेशा चलते हैं; छोटे कोड में शून्य नहीं जोड़ा जाता।", itemCodeSave: "सामान सेव कीजिए", itemCodePick: "पहले सामान चुनिए।", turnoverLegend: "पिछले साल का टर्नओवर", turnoverQuestion: "पिछले फ़ाइनेंशियल ईयर में आपके बिज़नेस का कुल टर्नओवर कितना था? आपके PAN पर भारत के हर GST रजिस्ट्रेशन की सारी बिक्री, एग्ज़ेम्प्ट और एक्सपोर्ट मिलाकर, GST से पहले।", turnoverUpTo5: "₹5 करोड़ या उससे कम, और 2017-18 से किसी भी साल ₹5 करोड़ से ज़्यादा नहीं", turnoverUpTo5Earlier: "पिछले साल ₹5 करोड़ या उससे कम, पर 2017-18 से किसी पहले साल ₹5 करोड़ से ज़्यादा", turnover5To10: "₹5 करोड़ से ज़्यादा, पर ₹10 करोड़ से कम", turnover10Plus: "₹10 करोड़ या उससे ज़्यादा", turnoverUnsure: "पक्का नहीं", turnoverWhy: "एक बार जवाब दीजिए। तब तक हम HSN के 6 अंक माँगते हैं, कोई बिल सरकारी ई-इनवॉइस नंबर के लिए नहीं भेजा जाता, और हर बिक्री की जाँच एक लाइन में याद दिलाती है।", turnoverFor: "ये जवाब {year} के बिलों के लिए है। इससे तय होता है कि हर बिल पर HSN के कितने अंक चाहिए, बिल को सरकारी ई-इनवॉइस नंबर चाहिए या नहीं, और उसे 30 दिन के अंदर भेजना है या नहीं।", turnoverAskAgainYES: "पहले आपने सिर्फ़ इतना बताया था कि ये ₹5 करोड़ से ज़्यादा था। ऊपर एक जवाब चुनिए: सिर्फ़ ₹10 करोड़ या उससे ज़्यादा वाले बिज़नेस को हर बिल 30 दिन के अंदर ई-इनवॉइस नंबर के लिए भेजना होता है।", turnoverAskAgainNO: "पहले आपने सिर्फ़ इतना बताया था कि ये ₹5 करोड़ या उससे कम था। ऊपर एक जवाब चुनिए: जो बिज़नेस 2017-18 से किसी भी साल ₹5 करोड़ से ऊपर गया, उसे अब भी ई-इनवॉइस नंबर चाहिए।", addItemTitle: "सामान जोड़िए", addItemHelp: "बिल पर यही विवरण, कोड और यूनिट छपेगा।",
    itemName: "बिल पर इसका नाम", itemKind: "माल है या सेवा?", itemGoods: "माल", itemService: "सेवा",
    itemHsn: "HSN या SAC कोड", itemHsnHelp: "माल का HSN 2, 4, 6 या 8 अंक का होता है; GST-रजिस्टर्ड ग्राहक के बिल पर कम से कम 4, और ₹5 करोड़ से ज़्यादा टर्नओवर पर कम से कम 6। सेवा का SAC 6 अंक का, 99 से शुरू।",
    itemUnit: "कैसे गिना जाता है?", itemTax: "आप इस पर कितना GST लेते हैं", itemTaxHelp: "ये आपके व्यापार का रेट है। हम इसे आपका रेट लिखते हैं और बिल पर भी यही लिखा जाता है; हम ख़ुद कोई रेट नहीं चुनते।",
    itemExempt: "छूट या शून्य रेट", itemOtherRateChoice: "कोई और रेट", itemOtherRate: "कितने फ़ीसदी?",
    itemBasis: "ये रेट कहाँ से आया?", itemBasisHelp: "जैसे: हमारे अकाउंटेंट से, या सप्लायर के बिल पर छपे रेट से।", itemRateFrom: "रेट कब से लागू", itemRateFromHelp: "खाली छोड़िए तो आज से। अगर ये सामान इसी रेट पर पहले बेच चुके हैं, तो पहले की तारीख़ चुनिए।", saveItem: "सामान सेव कीजिए",
    challanConsignee: "माल किसके पास जा रहा है", challanConsigneeHelp: "चालान पर उनका सेव किया नाम, पता और GST नंबर छपता है।",
    billTitle: "बिल", billReady: "यही बिल आपके ग्राहक को मिलेगा। प्रिंट कीजिए, या प्रिंट बॉक्स से PDF सेव कीजिए।",
    billNoAddress: "ग्राहक का पता नहीं लिखा गया, इसलिए बिल बिना पते के छपेगा। GST वाले ग्राहक के बिल पर उसका पता होना चाहिए।",
    billPaper: "काग़ज़", billPaperA4: "A4 पन्ना", billPaperThermal: "छोटी परची, 80mm", billPaperMobile: "फ़ोन की स्क्रीन", printBill: "बिल प्रिंट कीजिए", printBillCopies: "बिल प्रिंट कीजिए ({copies} कॉपी)",
    billFrame: "छपा हुआ बिल", openBill: "बिल खोलिए", billLoadFailed: "बिल नहीं आ पाया।",
    saleCustomerPlaceholder: "Mehta Stores", saleItemPlaceholder: "Apple box, 10 kg", supplierPlaceholder: "Fresh Farms Pvt Ltd", supplierBillPlaceholder: "FF-2048", paymentCustomerPlaceholder: "ABC Traders",
    liveCompany: "आज {company} का हाल।", salesLessReturns: "{billed} के बिल − {returned} ग्राहकों ने लौटाया", purchasesLessReturns: "{billed} के बिल − {returned} सप्लायर्स को लौटाया", customerDocumentsOne: "1 बिल का पैसा आना बाक़ी", customerDocumentsMany: "{count} बिलों का पैसा आना बाक़ी", supplierBillsOne: "1 सप्लायर का बिल", supplierBillsMany: "{count} सप्लायर के बिल", physicalBalance: "{location} में फ़िज़िकल बैलेंस", stockLeastFirst: "{location} में, सबसे कम पहले। {count} पर ध्यान देना है।", supplierPaymentActivity: "सप्लायर को पैसा दिया", supplierDue: "{supplier}: {amount} देना है", supplierDocumentsOne: "1 सप्लायर बिल चुकाना बाक़ी", supplierDocumentsMany: "{count} सप्लायर बिल चुकाना बाक़ी", noActivity: "अभी कोई दर्ज काम नहीं है।", purchaseActivity: "सप्लायर का बिल दर्ज, स्टॉक बढ़ा", paymentActivity: "ग्राहक से पैसा मिला", saleActivity: "बिल बना",
    checking: "एंट्री जाँच रहे हैं…", checkingBody: "आँकड़े जाँच रहे हैं…", nothingSaved: "कुछ सेव नहीं हुआ", signInRequired: "साइन इन ज़रूरी है।", requestFailed: "ये नहीं हो पाया, और कुछ नहीं बदला। दोबारा कोशिश कीजिए।", signInAgain: "जारी रखने के लिए दोबारा साइन इन कीजिए।", close: "बंद कीजिए", recordOnce: "एक बार दर्ज कीजिए", sendForApproval: "मंज़ूरी के लिए भेजिए", approveBill: "मंज़ूर करके जारी कीजिए", saleWaitingTitle: "मंज़ूरी का इंतज़ार कर रहे बिल", approvalReasonLabel: "आप इसे क्यों दे रहे हैं?", approvalYours: "इस बिल को मंज़ूरी चाहिए, और आप दे सकते हैं। कारण लिखिए: आपका नाम और कारण बिल के साथ रहेगा।", approvalSomeoneElse: "इस बिल को {who} की मंज़ूरी चाहिए। बटन इसे उन्हें भेजता है। मंज़ूरी मिलने तक बिल जारी नहीं होता।", approvalReasonNeeded: "पहले कारण लिखिए।", approvalMadeByYou: "ये बिल आपने बनाया है, इसलिए मंज़ूरी कोई और देगा।", recording: "दर्ज हो रहा है…", downloadPdf: "PDF डाउनलोड कीजिए", draftRestored: "इस डिवाइस से ड्राफ़्ट वापस मिला", draftSaleDateMoved: "ये सेल {started} को शुरू हुई थी। इसकी तारीख़ अब आज की है, {today}। इसे तभी बदलिए जब माल सच में किसी और दिन गया हो।", draftPurchaseDateKept: "ये सप्लायर बिल {started} को शुरू हुआ था। इसकी बिल तारीख़ {date} ही रखी गई है, क्योंकि ये सप्लायर की तारीख़ है। उनके बिल से मिला लीजिए।", draftMoneyDateKept: "ये एंट्री {started} को शुरू हुई थी। इसकी तारीख़ {date} ही रखी गई है। अगर पैसा किसी और दिन आया या गया हो तो इसे बदलिए।", draftCleared: "ड्राफ़्ट हटा दिया", working: "काम हो रहा है…", enterPurchaseBill: "परचेज़ बिल दर्ज कीजिए", backToSale: "बिक्री पर वापस जाइए", purchaseForSale: "जो बिक्री आप बना रहे थे: उसमें {item} के {required} {unit} हैं, और {warehouse} में {available} {unit} हैं। सप्लायर के बिल पर छपी मात्रा लिखिए। सामान {warehouse} में जाएगा।", purchaseForSaleDone: "सामान अब स्टॉक में है। बिक्री पर वापस जाइए: आपका लिखा सब वहीं है। बिल जारी करने के लिए उसे दोबारा देखिए।",
    navAsk: "पूछिए",
    agentLegend: "मुझे करने को कहिए", agentHint: "अपने शब्दों में बताइए क्या करना है। मैं आपको ठीक दिखाता हूँ कि क्या करूँगा — कौनसा ग्राहक, कौनसा बिल, कितना — और आपके हाँ कहे बिना कुछ नहीं होता।",
    agentRequest: "मैं क्या करूँ?", agentRequestPlaceholder: "ABC Traders के बाक़ी बिल देख कर रिमाइंडर भेज दो",
    agentShowMe: "दिखाइए आप क्या करेंगे", agentWouldDo: "मैं क्या करूँगा", agentDoIt: "हाँ, कर दीजिए",
    agentSafety: "मैं सिर्फ़ वही करता हूँ जो आप ख़ुद कर सकते हैं। हर काम से पहले बही दोबारा देखता हूँ — अगर बीच में बिल चुक गया तो वो मैसेज नहीं जाएगा।",
    agentCanDo: "मैं आपके लिए क्या कर सकता हूँ",
    askTitle: "अपने बिज़नेस के बारे में पूछिए",
    askHelp: "अंग्रेज़ी या हिंग्लिश में पूछिए। जवाब का हर आँकड़ा आपकी अपनी रिपोर्ट से आता है, और हर नियम के जवाब में उस नोटिफ़िकेशन का नाम होता है जहाँ से वो आया।",
    askLegend: "आपका सवाल",
    askHint: "इनमें से कोई चुनिए, या अपना सवाल लिखिए।",
    askQuestion: "आप क्या जानना चाहते हैं?",
    askQuestionPlaceholder: "मैंने इस महीने कितना बेचा?",
    askSend: "पूछिए",
    navMigration: "अपना डेटा लाइए",
    migrationTitle: "अपना डेटा यहाँ लाइए",
    migrationHelp: "पुराने सॉफ़्टवेयर से निकाली गई फ़ाइल भेजिए — ग्राहक, सामान, स्टॉक या पिछले साल की बाक़ी। हम उसे पढ़कर दिखाएँगे कि क्या होगा, और आपके कहने से पहले कुछ नहीं लिखेंगे।",
    migrationFileHeading: "पुराने सॉफ़्टवेयर की फ़ाइल",
    migrationFileHelp: "यहाँ पेस्ट कीजिए, या डिवाइस से फ़ाइल चुनिए। कुछ भी बाहर नहीं जाता, और अभी हिसाब में कुछ नहीं लिखा जाता।",
    migrationFileName: "फ़ाइल का नाम क्या है?",
    migrationPaste: "फ़ाइल यहाँ पेस्ट कीजिए",
    migrationUpload: "…या फ़ाइल चुनिए",
    migrationRead: "ये फ़ाइल पढ़िए",
    saleChecked: "बिक्री जाँच ली", saleCheckedBody: "जाँची हुई बिक्री {amount} की है।", saleEffectInvoice: "नंबर वाली इनवॉइस जारी होगी।", saleEffectBalance: "ग्राहक का बाक़ी पैसा बढ़ेगा।", purchaseChecked: "ख़रीद जाँच ली", purchaseCheckedBody: "जाँचा हुआ सप्लायर बिल {amount} का है।", purchaseEffectStock: "इस ख़रीद से स्टॉक अपडेट होगा।", purchaseEffectBooks: "GST और सप्लायर का बाक़ी एक साथ दर्ज होंगे।", paymentChecked: "पेमेंट जाँच ली", paymentCheckedBody: "{amount} की रसीद दर्ज करने के लिए तैयार है।", paymentEffectBalance: "दर्ज होने पर ग्राहक का बाक़ी पैसा कम होगा।", saleRecorded: "बिक्री दर्ज हुई", saleRecordedBody: "इनवॉइस {number} जारी हुई।", purchaseRecorded: "ख़रीद दर्ज हुई", purchaseRecordedBody: "स्टॉक, GST और सप्लायर बैलेंस एक साथ दर्ज हुए।", paymentRecorded: "पेमेंट दर्ज हुआ", paymentRecordedBody: "ग्राहक रसीद एक बार दर्ज हुई।", amountInvalid: "शून्य से बड़ी सही रकम भरिए।", referenceRequired: "सप्लायर बिल नंबर भरिए।", rateRequired: "दाम और मात्रा भरिए।", permissionDenied: "आपको ये काम करने की परमिशन नहीं है।",
    navEInvoice: "ई-इनवॉइस",
    einvoiceTitle: "आपके बिलों के ई-इनवॉइस नंबर", einvoiceHelp: "ऐप हर बिल के लिए ख़ुद तय करता है कि उसे सरकारी ई-इनवॉइस नंबर चाहिए या नहीं — बिल किसके लिए है और बिज़नेस विवरण में आपके जवाब से। यहाँ आपसे कुछ नहीं पूछा जाता।",
    whichBill: "कौनसा बिल", einvoiceTurnoverFrom: "बिज़नेस विवरण में दिए टर्नओवर और बिज़नेस के प्रकार से तय होता है। बदलना हो तो बिज़नेस विवरण खोलिए।",
    einvoiceListTitle: "आपके बिल", einvoiceAskTurnover: "अभी पता नहीं कि आपको ई-इनवॉइस चाहिए या नहीं, क्योंकि बिज़नेस विवरण में नहीं लिखा कि आपका टर्नओवर कभी ₹5 करोड़ से ऊपर गया या नहीं।", answerInBusinessDetails: "बिज़नेस विवरण में एक बार बताइए", backToSale: "बिक्री पर वापस", einvoiceNoBills: "अभी कोई बिल जारी नहीं हुआ।", einvoiceOpen: "खोलिए", einvoiceRetry: "फिर से भेजिए", einvoiceCancelOpen: "रद्द कीजिए…",
    einvoiceNeedsYes: "ई-इनवॉइस नंबर चाहिए", einvoiceNeedsNo: "ई-इनवॉइस नहीं चाहिए", einvoiceNeedsUnknown: "अभी पता नहीं",
    exemptLegend: "ई-इनवॉइस से छूट", exemptCategory: "क्या आपका बिज़नेस इनमें से है?", notExempt: "नहीं, इनमें से कोई नहीं", exemptBank: "बैंक या फ़ाइनेंस कंपनी (NBFC)", exemptInsurance: "इंश्योरेंस कंपनी", exemptGta: "माल ढुलाई एजेंसी", exemptPassenger: "सवारी ट्रांसपोर्ट बिज़नेस", exemptCinema: "सिनेमा", exemptSez: "SEZ की यूनिट", exemptGovernment: "सरकारी विभाग या लोकल अथॉरिटी", exemptHint: "सरकार इन बिज़नेसेस को टर्नओवर चाहे जितना हो, ई-इनवॉइस से बाहर रखती है। ज़्यादातर बिज़नेस इनमें से कोई नहीं होते।",
    checkNeeded: "ये बिल जाँचिए", einvoiceSafety: "जिस बिल को ई-इनवॉइस नंबर चाहिए, वो जारी करते ही अपने आप चला जाता है। यहाँ से और कुछ तभी जाता है जब आप बटन दबाएँ।",
    sendToGovernment: "सरकार को भेजिए", downloadOffline: "फ़ाइल डाउनलोड कीजिए", askGovernment: "सरकार से पूछिए उनके पास क्या है",
    cancelReasonKind: "रद्द क्यों कर रहे हैं?", reasonMistake: "कुछ ग़लत टाइप हो गया", reasonDuplicate: "वही बिल दो बार चला गया", reasonOrderOff: "ऑर्डर रद्द हो गया", reasonOther: "दूसरी वजह",
    cancelReasonWhy: "अपने शब्दों में बताइए", cancelEInvoice: "सरकार के साथ रद्द कीजिए",
    navItc: "ख़रीद मिलान",
    itcTitle: "आपकी ख़रीद और सरकारी रिकॉर्ड",
    itcHelp: "हर वो बिल जिसका क्रेडिट अभी क्लेम होना बाक़ी है, और उसके सामने वो जो आपके सप्लायर ने सरकार को बताया। जहाँ दोनों मिलते हैं, वहाँ आपका दिया GST वापस मिल सकता है। जहाँ नहीं मिलते, वहाँ पैसा रोका जाता है और लाइन बताती है किसे क्या करना है।",
    itcWhichMonth: "कौनसा महीना", itcWhichMonthHelp: "जिस महीने का रिटर्न भरना है वो चुनिए।",
    itcCheck: "इस महीने का मिलान कीजिए",
    itcSafety: "ये सिर्फ़ मिलान करता है। यहाँ से कुछ क्लेम, फ़ाइल या भेजा नहीं जाता।",
    itcImportTitle: "सरकारी लिस्ट यहाँ लाइए",
    itcImportHelp: "GST पोर्टल से इस महीने की GSTR-2B फ़ाइल डाउनलोड करके यहाँ चुनिए, या पेस्ट कीजिए। अकाउंटेंट की स्प्रेडशीट भी चलती है।",
    itcImportFile: "डाउनलोड की हुई फ़ाइल", itcImportFileHelp: "आपकी चुनी हुई फ़ाइल के अलावा कुछ भी डिवाइस से बाहर नहीं जाता।",
    itcImportPaste: "या यहाँ पेस्ट कीजिए",
    itcImportButton: "इस महीने का रिकॉर्ड इम्पोर्ट कीजिए",
    itcTypedTitle: "या पोर्टल देख कर बिल हाथ से लिखिए",
    itcTypedHelp: "फ़ाइल डाउनलोड न हो — इंटरनेट, फ़ोन, या पोर्टल न चले — तो पोर्टल पर देख कर बिल यहाँ लिख दीजिए। फ़ाइल जितनी ही सख़्ती से जाँच होती है।",
    itcTypedGstin: "सप्लायर का GST नंबर", itcTypedSupplier: "सप्लायर का नाम", itcTypedNumber: "पोर्टल पर बिल नंबर",
    itcTypedDate: "बिल की तारीख़", itcTypedTaxable: "GST से पहले रकम", itcTypedCgst: "CGST", itcTypedSgst: "SGST",
    itcTypedIgst: "IGST", itcTypedTotal: "बिल का टोटल",
    itcTypedButton: "ये रो जोड़िए",
    itcTypedSafety: "लाइन पर लिखा रहेगा कि ये फ़िगर किसी ने हाथ से लिखा था, डाउनलोड नहीं किया। बाक़ी सब वैसे ही चलता है।",
    itcTotalsTitle: "आपके GST रिटर्न पर इसका क्या असर है",
    itcLinesTitle: "एक-एक बिल",
    itcLinesHelp: "हर लाइन दिखाती है कि आपकी बुक्स क्या कहती हैं, पोर्टल क्या कहता है, और क्रेडिट किस वजह से रुका है। जो बिल पोर्टल पर नहीं है उसे एक्सेप्ट करने के लिए वजह लिखनी होती है, और आपका नाम उस पर रहता है।",
    itcClaimable: "इस महीने लेना ठीक है", itcHeldBack: "रोका गया", itcAtRisk: "आपके कहने पर लिया",
    itcTimeBarred: "लेने का समय निकल गया — ये वापस नहीं आएगा",
    itcAccept: "एक्सेप्ट", itcReject: "रिजेक्ट", itcPending: "पेंडिंग रखिए",
    itcReasonPlaceholder: "क्यों? (रिकॉर्ड पर जाएगा)",
    itcOurs: "आपका", itcTheirs: "पोर्टल",
    itcTypedFlag: "किसी ने हाथ से लिखा",
    navGstReturns: "GST रिटर्न",
    gstReturnsTitle: "इस महीने का आपका GST रिटर्न",
    gstReturnsHelp: "महीने के सारे बिल, सरकार जैसे माँगती है वैसे बाँटते हुए, और हर फ़िगर के पीछे के बिल खोल कर देखे जा सकते हैं। कुछ अंदाज़ा नहीं लगाया जाता: जो बिल रखा न जा सके वो सवाल के साथ एक लिस्ट पर चला जाता है।",
    gstWhichMonth: "कौनसा महीना", gstWhichMonthHelp: "रिटर्न हर महीने का अलग होता है। जिस महीने का भर रहे हैं वो चुनिए।",
    gstPrepare: "इस महीने का तैयार कीजिए",
    gstSafety: "ये सिर्फ़ आपकी बुक्स पढ़ता है और बताता है रिटर्न क्या कहेगा। यहाँ से सरकार को कुछ नहीं जाता।",
    gstDriftTitle: "अप्रूव होने के बाद आपकी बुक्स बदली हैं",
    gstExceptionsTitle: "जो बिल अभी रिटर्न पर नहीं जा सकते",
    gstExceptionsHelp: "हर एक किसी इंसान के जवाब का इंतज़ार कर रहा है। वो आपकी बुक्स में हैं; बस जब तक कोई तय न करे, रिटर्न पर नहीं आते।",
    gstSectionsTitle: "रिटर्न क्या कह रहा है",
    gstSectionsHelp: "सरकार आपकी बिक्री ऐसे बाँटी हुई माँगती है। हर लाइन के नीचे उसके बिल दिखते हैं।",
    gstBooksTitle: "क्या ये आपकी बुक्स से मिलता है?",
    gst3bTitle: "छोटा रिटर्न: कितना देना है और कितना पहले दे चुके हैं",
    gstApproveTitle: "अप्रूव करना और फ़ाइल करना",
    gstApproveHelp: "अप्रूव करते ही ये फ़िगर आपके नाम और उस वक़्त के साथ पक्के हो जाते हैं। उसके बाद बुक्स बदलें तो ऐप आपको बताता है, चुपके से रिटर्न नहीं बदलता।",
    gstApproveNote: "रिकॉर्ड के लिए एक नोट",
    gstApprove: "ये रिटर्न अप्रूव कीजिए",
    gstExport: "ख़ुद अपलोड करने के लिए फ़ाइल लीजिए",
    gstOwe: "देना है", gstCredit: "पहले दिया", gstLeftOver: "बचा", gstCashRcm: "{cash} कैश में भरना है — इसमें {rcm} रिवर्स-चार्ज टैक्स है, जो क्रेडिट से नहीं भरा जा सकता (CGST s.49(4))", gstCreditLeft: "{amount} क्रेडिट बचा", rcmQuestionsTitle: "इस बिल का GST कौन भरेगा?", rcmQuestionsHelp: "कुछ ख़रीद रिवर्स चार्ज में होती है: उनका GST सेलर नहीं, आप (ख़रीदने वाले) सरकार को भरते हैं। ये ख़रीद है या नहीं, ये एक बात पर तय होता है जो सिर्फ़ आप जानते हैं। जवाब दीजिए, फिर ख़रीद दोबारा देखिए।", rcmYes: "हाँ", rcmNo: "नहीं", rcmAnswerAbove: "फ़ॉर्म पर GST कौन भरेगा वाले सवाल का जवाब दीजिए, फिर ख़रीद दोबारा देखिए।", receivedOn: "माल या सेवा आप तक किस दिन पहुँची", receivedOnHelp: "सिर्फ़ तब ज़रूरी है जब GST आप ख़ुद भरते हैं (रिवर्स चार्ज)। बिल की तारीख़ हो तो खाली छोड़ दीजिए।", selfInvoicesTitle: "बनाने वाले सेल्फ़-इनवॉइस", selfInvoicesHelp: "बिना GST नंबर वाले सेलर से रिवर्स चार्ज में माल या सेवा लेने पर बिल आप ख़ुद बनाते हैं — सेल्फ़-इनवॉइस — मिलने के 30 दिन के अंदर (CGST s.31(3)(f), Rule 47A)।", selfInvoiceLine: "{supplier} · बिल {bill} · मिला {date} · GST {tax}", issueSelfInvoice: "सेल्फ़-इनवॉइस बनाइए", printSelfInvoice: "देखिए", selfInvoiceTitle: "सेल्फ़-इनवॉइस {number}", selfInvoiceStateOVERDUE: "देर हो गई", selfInvoiceStateLAST_DAY: "आज आख़िरी दिन", selfInvoiceStateDUE_SOON: "जल्दी बनाइए", selfInvoiceStateNOT_YET_DUE: "बनाना है", selfInvoiceStateISSUED: "बन गया", creditAllowed: "क्या ये GST वापस मिल सकता है?", creditAllowedYes: "हाँ — GST क्लेम हो सकता है", creditAllowedHelp: "नहीं तभी चुनिए जब क़ानून क्रेडिट रोकता है (CGST s.17(5)); तब इसका GST लागत में जाता है।", blocked_motor_vehicle: "नहीं — 13 लोगों तक की कार या गाड़ी (s.17(5)(a))", blocked_vessel_aircraft: "नहीं — नाव, जहाज़ या हवाई जहाज़ (s.17(5)(aa))", blocked_vehicle_insurance_repair: "नहीं — ऐसी कार का इंश्योरेंस या रिपेयर (s.17(5)(ab))", blocked_food_health_etc: "नहीं — खाना, पीना, कैटरिंग, ब्यूटी, हेल्थ, कार किराया, लाइफ़ या हेल्थ इंश्योरेंस (s.17(5)(b))", blocked_club_fitness: "नहीं — क्लब, जिम या फ़िटनेस मेंबरशिप (s.17(5)(b))", blocked_employee_travel: "नहीं — कर्मचारियों की छुट्टी की यात्रा (s.17(5)(b))", blocked_works_contract_building: "नहीं — इमारत पर ठेकेदार का निर्माण काम (s.17(5)(c))", blocked_own_building: "नहीं — अपनी इमारत बनाने का सामान या सेवा (s.17(5)(d))", blocked_csr: "नहीं — CSR काम के लिए (s.17(5)(fa))", blocked_personal_use: "नहीं — निजी इस्तेमाल, बिज़नेस नहीं (s.17(5)(g))", blocked_gift_sample: "नहीं — तोहफ़ा या फ़्री सैंपल (s.17(5)(h))",
    gstOnReturn: "रिटर्न पर", gstInBooks: "बुक्स में",
    supplierNoteNumber: "सप्लायर के क्रेडिट नोट का नंबर", supplierNoteDate: "सप्लायर के क्रेडिट नोट की तारीख़",
    supplierNoteHelp: "अगर सप्लायर ने अपना क्रेडिट नोट दे दिया है तो यहाँ लिखिए। नहीं तो खाली छोड़िए और आने पर जोड़िए — क्रेडिट इस महीने से घट जाता है।",
    supplierNoteAdd: "सप्लायर का क्रेडिट नोट जोड़िए", supplierNoteSave: "सेव", supplierNoteShown: "सप्लायर का नोट {number}, {date}",
    supplierNoteAwaited: "सप्लायर का क्रेडिट नोट अभी नहीं आया",
    gstPurchaseBooksTitle: "ख़रीद पर क्रेडिट: रिटर्न और बुक्स", gstPurchaseExplained: "परचेज़ चेक से समझा गया",
    itcTypedKind: "बिल या क्रेडिट नोट?", itcKindInvoice: "बिल", itcKindCreditNote: "क्रेडिट नोट",
    navVehicle: "गाड़ी की जाँच",
    vehicleCheckTitle: "क्या ये गाड़ी इतना माल ले जा सकती है?",
    vehicleCheckHelp: "माल निकलने से पहले हम देखते हैं कि कितना लोड हो रहा है और गाड़ी कितना ले जाने के लिए रजिस्टर्ड है। हर जवाब बताता है वो बात कहाँ से आई, और जो सर्विस हम तक पहुँच ही नहीं पाई उसे कभी 'सब ठीक है' नहीं दिखाया जाता।",
    recordLookupTitle: "RTO के रिकॉर्ड में इस गाड़ी के बारे में क्या है?",
    recordLookupHelp: "गाड़ी का नंबर लिखिए, हम सरकारी रिकॉर्ड से पूछेंगे। आपको मिलेगा: गाड़ी किस तरह की है, कितना माल ले जा सकती है, और काग़ज़ कब तक वैलिड हैं — उस तारीख़ के साथ जब हमने पूछा। मालिक का नाम सिर्फ़ शुरुआती अक्षर में रखा जाता है, और उसके बारे में और कुछ माँगा ही नहीं जाता।",
    recordPlate: "गाड़ी का नंबर", recordPlateHelp: "जैसे गाड़ी पर लिखा है वैसे लिखिए। स्पेस या डैश से फ़र्क़ नहीं पड़ता।",
    recordLookupButton: "RTO से पूछिए",
    recordSafety: "ये सिर्फ़ पढ़ता है। टैक्स पोर्टल पर कुछ नहीं जाता और कोई ई-वे बिल नहीं बनता।",
    recordAsked: "कब पूछा", recordProvider: "किसने जवाब दिया", recordReference: "उनका रेफ़रेंस नंबर",
    recordReused: "जो पहले से था वही दोबारा दिखाया गया, प्रोवाइडर से दोबारा नहीं पूछा गया।",
    recordAgreed: "इस व्यापार ने क्या पढ़ने की इजाज़त दी है",
    whichVehicle: "कौनसी गाड़ी", whichVehicleHelp: "एक चुनिए और देखिए RTO के रिकॉर्ड में उसके बारे में क्या है।",
    loadWeight: "लोड का वज़न (kg)", loadWeightHelp: "अगर तोला नहीं गया तो खाली छोड़ दीजिए — हम पूछेंगे, अंदाज़ा नहीं लगाएँगे।",
    crossesBorder: "क्या माल दूसरे राज्य जा रहा है?", crossesBorderHelp: "राज्य का परमिट उस राज्य के बाहर नहीं चलता।",
    coldChain: "क्या माल ठंडा रहना चाहिए?", hazardous: "क्या ये ख़तरनाक माल है?",
    platePhoto: "नंबर प्लेट की फ़ोटो", platePhotoHelp: "गोदाम का कैमरा। जो फ़ोटो पढ़ी न जा सके वो सवाल है, ग़लती नहीं।",
    plateTyped: "या प्लेट पर जो लिखा है वो टाइप कीजिए", plateTypedHelp: "अगर फ़ोटो नहीं है तो गाड़ी की प्लेट पढ़ कर यहाँ लिख दीजिए। जाँच वैसी ही होती है, और ये इंसान की पढ़ी हुई बात के रूप में दर्ज होती है।",
    typedClass: "अगर रिकॉर्ड में कुछ नहीं: गाड़ी किस तरह की है?", typedClassHelp: "ये तभी काम आता है जब न RTO के पास न आपकी लिस्ट में ये गाड़ी है। ये उनसे ऊपर कभी नहीं जाता।",
    typedCapacity: "अगर रिकॉर्ड में कुछ नहीं: कितना ले जा सकती है? (kg)", typedCapacityHelp: "RC पर जो क्षमता लिखी है, इस मूवमेंट के लिए टाइप कर दीजिए।",
    classNotSaid: "बताया नहीं",
    checkVehicle: "ये गाड़ी जाँचिए",
    vehicleSafety: "ये सिर्फ़ जाँचता है। कहीं कुछ नहीं भेजा जाता और कोई ई-वे बिल नहीं बनता।",
    evidenceUsed: "हमने क्या पढ़ा, और कहाँ से", evidenceUsedHelp: "RTO का रिकॉर्ड और आपकी अपनी गाड़ियों की लिस्ट, अलग-अलग। ओवरराइड इनमें से कुछ नहीं बदलता।",
    overrideWhich: "आप किस बात की ज़िम्मेदारी ले रहे हैं?", overrideWhichHelp: "सिर्फ़ वही चीज़ें यहाँ हैं जिन्हें ओवरराइड किया जा सकता है। जो गाड़ी माल उठा ही नहीं सकती, वो उनमें नहीं है।",
    overrideWhy: "भेजना क्यों ठीक है?", overrideButton: "मेरी ज़िम्मेदारी पर भेजिए",
    overrideSafety: "इससे आपका नाम, समय और वजह फ़ाइंडिंग्स के साथ जुड़ जाती है। कोई वज़न, कोई क्षमता और कोई सरकारी रिकॉर्ड नहीं बदलता।",
    heldBack: "डिस्पैच डेस्क पर रुका हुआ", heldBackHelp: "वो मूवमेंट्स जिन्हें गाड़ी की कोई दिक्कत रोक रही है, और क्या बाक़ी है।",
    // Issue #142 — quotations and proforma invoices.
    navPresale: "कोटेशन / प्रोफ़ॉर्मा",
    presaleTitle: "कोटेशन और प्रोफ़ॉर्मा इनवॉइस", presaleHelp: "कोटेशन बिक्री से पहले भेजा गया रेट का ऑफ़र है। प्रोफ़ॉर्मा इनवॉइस एडवांस का बिल है, जो अक्सर इसलिए भेजा जाता है कि ग्राहक माल जाने से पहले पेमेंट करे। दोनों टैक्स इनवॉइस नहीं हैं: असली बिल बनने तक आपके खाते, स्टॉक या GST में कुछ नहीं जाता।",
    presaleWhich: "कौनसा काग़ज़?", presaleQuotation: "कोटेशन — रेट का ऑफ़र", presaleProforma: "प्रोफ़ॉर्मा इनवॉइस — एडवांस का बिल",
    presaleQuotationRule: "रेट का ऑफ़र। आपके खाते में कुछ नहीं लिखा जाता। ग्राहक मान ले तो इसे बिना दोबारा लिखे बिल बना सकते हैं।",
    presaleProformaRule: "एडवांस का बिल, माल जाने से पहले पेमेंट लेने के लिए। इस पर \u201cYeh tax invoice nahin hai\u201d लिखा होता है और आपके बैंक की जानकारी होती है। बाद वाला टैक्स इनवॉइस इसके साथ जोड़ा जाता है।",
    presaleDate: "तारीख़", presaleValidUntil: "कब तक वैलिड (ज़रूरी नहीं)", presaleValidHelp: "आपका रेट कब तक रहेगा। तारीख़ का वादा नहीं करना हो तो खाली छोड़ दीजिए।",
    presaleRate: "एक यूनिट का रेट", presaleRateHelp: "GST से पहले। GST बिल की तरह ही लगाया जाता है।",
    presalePurpose: "ये प्रोफ़ॉर्मा किस लिए है?", presalePurposeHelp: "प्रोफ़ॉर्मा के साथ रखा जाता है, छपता नहीं। इसी से बाद वाला बिल इसके साथ मिलाया जाता है।",
    presaleBuyerOrder: "ग्राहक का ऑर्डर नंबर (ज़रूरी नहीं)", presalePaymentTerms: "पेमेंट कैसे करें? (ज़रूरी नहीं)",
    presaleBank: "आपके बैंक की जानकारी (ज़रूरी नहीं)", presaleBankHelp: "प्रोफ़ॉर्मा पर छपती है ताकि ग्राहक को पता हो कि पेमेंट कहाँ भेजें। हर लाइन अलग लिखिए।",
    presaleTerms: "आपकी शर्तें (ज़रूरी नहीं)", presaleTermsHelp: "बिल्कुल वैसी ही छपती हैं। हम अपनी तरफ़ से कुछ नहीं जोड़ते।",
    presaleCheck: "जाँचिए", presaleSafety: "जाँचने से कुछ सेव नहीं होता और कोई नंबर नहीं लगता। नंबर सिर्फ़ बनाने पर मिलता है।",
    presaleIssue: "बनाइए", presaleIssued: "कोटेशन और प्रोफ़ॉर्मा", presaleIssuedHelp: "नए पहले। खोलकर प्रिंट कीजिए, कोटेशन को बिक्री बनाइए, प्रोफ़ॉर्मा को उसके बिल से जोड़िए, या रद्द कीजिए।",
    presaleNone: "अभी कुछ नहीं बना।", presaleOpen: "खोलिए", presalePrint: "प्रिंट कीजिए",
    presaleConvertTitle: "ग्राहक ने मान लिया?", presaleConvertHelp: "इस कोटेशन को बिना दोबारा लिखे बिल बनाइए। कुछ जारी होने से पहले आप बिल और उसकी जाँच देखेंगे।", presaleConvert: "बिक्री बनाइए", presaleOpenBill: "इससे बना बिल खोलिए",
    presaleIssueBill: "बिल जारी कीजिए",
    presaleLinkTitle: "बाद में बना टैक्स इनवॉइस", presaleLinkHelp: "इस प्रोफ़ॉर्मा के बाद बना बिल चुनिए। हम देखेंगे कि वो उसी ग्राहक का है और इससे पहले की तारीख़ का नहीं, और जो अलग है वो लिख देंगे।",
    advanceTitle: "इस प्रोफ़ॉर्मा पर मिला पैसा", advanceHelp: "हर पेमेंट का अपनी सीरीज़ में रसीद वाउचर बनता है। सर्विस पर इसके अंदर का GST अभी देना होता है, और टैक्स इनवॉइस जोड़ने पर एडजस्ट हो जाता है, ताकि दो बार न लगे। सामान पर इनवॉइस तक कोई GST नहीं।",
    advanceAmount: "मिली रकम", advanceMode: "पेमेंट कैसे हुआ?", advanceCash: "नक़द", advanceUpi: "UPI (आपके करंट अकाउंट में)", advanceBank: "बैंक ट्रांसफ़र (आपके करंट अकाउंट में)", advanceUtr: "रेफ़रेंस (ज़रूरी नहीं)", advanceRecord: "दर्ज कीजिए और रसीद वाउचर बनाइए",
    refundHelp: "जो पैसा किसी बिल में नहीं लगा, वो रिफ़ंड वाउचर के साथ लौटाइए। उस पर दिया GST वापस होता है।", refundReason: "क्यों लौटा रहे हैं?", refundRecord: "लौटाइए और रिफ़ंड वाउचर बनाइए",
    presaleCancelTitle: "इसे रद्द कीजिए", presaleCancelHelp: "अगर ग्राहक ने नहीं लिया। नंबर इस्तेमाल हुआ ही माना जाएगा, ताकि गिनती में खाली जगह न रहे।", presaleCancelReason: "रद्द क्यों कर रहे हैं?", presaleCancel: "रद्द कीजिए",
    // Issue #141 — delivery challans.
    navChallan: "डिलीवरी चालान",
    challanTitle: "माल डिलीवरी चालान पर भेजिए", challanHelp: "डिलीवरी चालान वो काग़ज़ है जो माल के साथ जाता है जब टैक्स इनवॉइस साथ नहीं जाता — जॉब वर्क, पसंद आने पर बिक्री, या ऐसी बिक्री जिसका बिल डिलीवरी के बाद बनता है। GST इसे सिर्फ़ यहाँ लिखी वजहों के लिए मानता है, और बताता है कि उस पर क्या लिखना ज़रूरी है।",
    challanWhy: "माल क्यों जा रहा है?", challanDocDate: "चालान की तारीख़", challanItem: "माल", challanValuePerUnit: "एक यूनिट की कीमत",
    challanReasonNote: "कुछ शब्दों में वजह लिखिए", challanStateHelp: "अगर माल पाने वाले के अपने राज्य में ही जा रहा है तो इसे वैसे ही रहने दीजिए।",
    checkChallan: "चालान जाँचिए", challanSafety: "जाँचने से कुछ सेव नहीं होता और कोई नंबर नहीं लगता। नंबर सिर्फ़ चालान बनाने पर मिलता है।",
    issueChallan: "चालान बनाइए", challansIssued: "बने हुए चालान", challansIssuedHelp: "नए पहले। खोलकर प्रिंट कीजिए, ई-वे बिल जोड़िए, बाद वाला इनवॉइस जोड़िए, या रद्द कीजिए।",
    noChallans: "अभी कोई चालान नहीं बना।", openChallan: "खोलिए", printChallan: "तीनों कॉपी प्रिंट कीजिए",
    billChallanTitle: "इन सामान का बिल बनाइए", billChallanHelp: "इस चालान के सामान का ही बिल बनता है, स्टॉक से एक बार निकलता है, और बिल चालान से जुड़ जाता है।", billChallanBy: "अप्रूवल पर भेजा सामान: {date} तक बिल बनाइए (निकलने के छह महीने)।", billChallan: "बिल बनाइए", linkInvoiceTitle: "डिलीवरी के बाद बना टैक्स इनवॉइस", linkInvoiceHelp: "सिर्फ़ बेचे गए माल के लिए। इनवॉइस चुनिए; हम देखेंगे कि वो उसी ग्राहक का है, चालान के बाद का है, और वही माल बिल करता है।", linkInvoice: "ये इनवॉइस जोड़िए",
    challanEwayTitle: "ई-वे बिल नंबर", challanEwayHelp: "अगर कहीं और बना है तो यहाँ लिखिए। ई-वे बिल वाली स्क्रीन से बना नंबर यहाँ अपने आप आ जाता है।", ewayBillNumberLabel: "ई-वे बिल नंबर (12 अंक)", transporterName: "ट्रांसपोर्टर", recordEwayNumber: "चालान पर जोड़िए",
    printEway: "ड्राइवर के लिए प्रिंट कीजिए", printEwaySend: "प्रिंटर पर भेजिए", printEwayPdf: "PDF डाउनलोड कीजिए",
    cancelChallanTitle: "ये चालान रद्द कीजिए", cancelChallanHelp: "सिर्फ़ तब जब माल इस पर गया ही नहीं। नंबर इस्तेमाल हुआ ही माना जाएगा, ताकि गिनती में खाली जगह न रहे।", cancelChallanReason: "रद्द क्यों कर रहे हैं?", ewayCancelledOnPortal: "इसका ई-वे बिल पोर्टल पर रद्द हो चुका है", cancelChallan: "चालान रद्द कीजिए",
    ewayChallanReasonHelp: "डिलीवरी चालान के लिए चालान पर लिखी वजह ही ली जाती है, ये वाली नहीं।",
    navEway: "ई-वे बिल",
    ewayTitle: "क्या इस माल को ई-वे बिल चाहिए?", ewayHelp: "ई-वे बिल माल ले जाने का परवाना है, टैक्स का काग़ज़ नहीं। छोटी खेपों को अक्सर ज़रूरत नहीं होती। हम गाड़ी पर क्या है, कहाँ जा रहा है और किस राज्य का नियम लगता है, इससे तय करते हैं और वही नियम आपको दिखाते हैं।",
    whyMoving: "माल क्यों जा रहा है?", moveSupply: "बिक्री", moveJobWork: "जॉब वर्क के लिए जा रहा है", moveBranch: "अपनी ही जगह पर जा रहा है", moveReturn: "ग्राहक से वापस आ रहा है",
    deliveryState: "माल किस राज्य में जा रहा है?", deliveryStateHelp: "हर राज्य की अपनी लिमिट इसमें बनी हुई है। अगर माल ख़रीदार के अपने पते पर ही जा रहा है तो इसे वैसे ही रहने दीजिए। अगर बिल पर पहले से डिलीवरी का पता है, तो वही लिया जाएगा।", buyerOwnState: "जहाँ ख़रीदार है",
    deliveryPlace: "डिलीवरी का शहर", deliveryAddress: "डिलीवरी का पता (बिल्डिंग, गली, इलाक़ा)",
    deliveryPincode: "डिलीवरी का PIN कोड", deliveryPincodeHelp: "डिलीवरी वाले पते का PIN कोड, ख़रीदार का नहीं। पोर्टल इसी से रास्ता निकालता है।",
    distanceKm: "सड़क की दूरी (km)", distanceHelp: "खाली छोड़ दीजिए: पोर्टल दोनों PIN कोड से दूरी ख़ुद निकालता है। तभी भरिए जब सड़क सच में लंबी हो; पोर्टल अपनी दूरी से ज़्यादा से ज़्यादा 10% ज़्यादा मानता है। दूरी से तय होता है बिल कितने दिन चलेगा: हर 200 km या उसके हिस्से पर एक दिन।", ewayFromBill: "ई-वे बिल बनाइए", ewayOpen: "ई-वे बिल खोलिए", ewayFilledFrom: "बिल {number} से भरा गया। जाँच लीजिए, फिर बनाने का बटन दबाइए।",
    vehicleNumber: "गाड़ी का नंबर", vehicleHelp: "खाली छोड़ दीजिए तो अभी Part A बन जाएगा और गाड़ी बाद में जोड़ी जा सकती है। गाड़ी जुड़े बिना माल नहीं हिल सकता।",
    oversized: "क्या लोड बहुत बड़ा है?", answerYes: "हाँ", answerNo: "नहीं", answerNotSaid: "बताया नहीं",
    sameCity: "क्या माल एक ही शहर में रह रहा है?", sameCityHelp: "कुछ राज्य, जैसे गुजरात, एक ही शहर के अंदर कोई ई-वे बिल नहीं माँगते। पक्का नहीं तो 'बताया नहीं' रहने दीजिए — हम पूछेंगे, अंदाज़ा नहीं लगाएँगे।",
    checkMovement: "ये मूवमेंट जाँचिए", ewaySafety: "जाँचने से कुछ नहीं जाता। बनाने का बटन दबाने तक पोर्टल तक कुछ नहीं पहुँचता।",
    raiseEway: "ई-वे बिल बनाइए", askPortal: "पोर्टल से पूछिए उनके पास क्या है",
    vehicleChangeReason: "ये गाड़ी क्यों?", changeFirst: "ये पहली है", changeBreakdown: "पिछली ख़राब हो गई", changeTransshipment: "माल दूसरी गाड़ी पर गया", changeNote: "क्या हुआ, बताइए", fromPlace: "कहाँ से उठा रहा है",
    addVehicle: "ये गाड़ी बिल पर लगाइए",
    currentPlace: "गाड़ी अभी कहाँ है?", currentState: "कौनसा राज्य कोड?", remainingKm: "कितने किलोमीटर बाक़ी हैं", extendWhy: "देर क्यों हो रही है?", extendValidity: "ई-वे बिल की अवधि बढ़ाइए",
    cancelEway: "पोर्टल के साथ रद्द कीजिए",
    onTheRoad: "अभी सड़क पर", onTheRoadHelp: "हर खेप जिसका ई-वे बिल चल रहा है, और हर एक के पास कितना समय बचा है।",
    navSupplier: "सप्लायर जाँच",
    navTeam: "इस बिज़नेस के लोग", teamTitle: "इस बिज़नेस के लोग", teamHelp: "कौन इस बिज़नेस में sign in कर सकता है, और हर व्यक्ति क्या कर सकता है। किसी को हटाने पर वह तुरंत sign out हो जाता है।",
    teamInviteTitle: "एक व्यक्ति जोड़िए", teamRole: "वह क्या कर सकते हैं", teamInvite: "निमंत्रण लिंक बनाइए", teamLeave: "यह बिज़नेस छोड़िए",
    teamLinkMade: "यह लिंक {address} को भेजिए। यह 7 दिन चलेगा, सिर्फ़ उसी नंबर या email के लिए: {link}", teamYou: "आप",
    teamRemove: "हटाइए", teamHandOver: "बिज़नेस सौंपिए", teamConfirmRemove: "{name} को हटाइए? वह तुरंत sign out हो जाएँगे।", teamConfirmHandOver: "बिज़नेस {name} को सौंपिए? वह owner बन जाएँगे और आप admin रहेंगे।", teamConfirmLeave: "यह बिज़नेस छोड़िए? आप इससे sign out हो जाएँगे।",
    roleOwner: "Owner", roleAdmin: "Admin", roleAccountant: "Accountant (या CA)", roleStaff: "Staff", roleViewer: "देखने वाले", roleCustom: "अलग", joinInvited: "आपको एक बिज़नेस में बुलाया गया है। उसी नंबर या email से sign in कीजिए जिस पर निमंत्रण आया।",
    navPlan: "आपका प्लान",
    planTitle: "आपके प्लान में क्या है", planHelp: "प्लान सिर्फ़ इतने में अलग हैं कि आप कितना काम करते हैं। काम कितनी सावधानी से होता है उसमें कोई फ़र्क़ नहीं — हर चेतावनी, हर जाँच और आपका अपना डेटा हर प्लान में है, मुफ़्त वाले में भी।",
    planUsage: "इस महीने आपने कितना इस्तेमाल किया", planNeverWithheld: "जो कोई प्लान छीन नहीं सकता",
    planChoose: "प्लान बदलिए", planPay: "इस महीने का भुगतान कीजिए", planInvoices: "हमारे आपको भेजे गए बिल",
    navReminders: "याद-दिलावा",
    remindersTitle: "पैसे के लिए किसे याद दिलाना है", remindersHelp: "नीचे हर लाइन अभी इस वक़्त आपकी बही से निकाली गई है। जो बिल चुक गया, जिस पर सवाल है, या जिसका वादा हुआ है — उसे छोड़ दिया जाता है, और वजह लिखी होती है; क्योंकि अगला सवाल यही होता है कि \"उन्हें याद क्यों नहीं दिलाया?\"",
    remindersToday: "आज क्या जाएगा", remindersSendAll: "जो तय हुआ सब भेज दीजिए",
    remindersSafety: "आपके कहे बिना कुछ नहीं जाता। हर मैसेज से पहले बिल दोबारा जाँचा जाता है — अगर पैसा अभी आ गया है तो मैसेज नहीं जाएगा।",
    remindersSend: "ये भेज दीजिए", remindersRetry: "दोबारा कोशिश कीजिए",
    remindersTellUs: "ग्राहक ने क्या कहा, हमें बताइए", remindersBill: "कौनसा बिल", remindersWhatHappened: "क्या हुआ",
    remindersPromise: "उन्होंने देने का वादा किया", remindersDispute: "उनका कहना है बिल में कुछ ग़लत है",
    remindersPromisedOn: "कब तक देने को कहा", remindersAmount: "कितने का वादा", remindersNote: "उनके शब्दों में",
    remindersRecord: "ये लिख लीजिए", remindersStopTitle: "इस ग्राहक को याद दिलाना बंद कीजिए",
    remindersCustomer: "ग्राहक", remindersStopReason: "क्यों", remindersStop: "याद दिलाना बंद कीजिए", remindersResume: "दोबारा शुरू कीजिए",
    remindersHistory: "क्या भेजा गया", remindersOutbox: "ग्राहक को क्या मिला",
    remindersNothing: "अभी कुछ नहीं।",
    supplierTitle: "पैसा देने से पहले सप्लायर जाँचिए", supplierHelp: "हम दिखाते हैं कि GST विभाग क्या कहता है और आपकी अपनी बही क्या कहती है — हर बात की तारीख़ और सोर्स के साथ। हम कभी नहीं बताते कि कोई कैसा है; सिर्फ़ ये कि रिकॉर्ड में क्या लिखा है।",
    theirGstin: "उनका GST नंबर", theirGstinHelp: "हम इसे GST विभाग से जाँचते हैं।",
    trySomeone: "या इनमें से कोई देखिए", checkSupplier: "ये सप्लायर जाँचिए",
    supplierSafety: "ये सिर्फ़ देखता है। सप्लायर के खाते में कुछ दर्ज नहीं होता और पैसा नहीं हिलता।",
    whatWeFound: "हमें क्या मिला", whereFrom: "हर जवाब कहाँ से आया",
    ackReason: "आगे बढ़ना क्यों ठीक है?", ackButton: "स्वीकार करके आगे बढ़िए",
    navDeliveries: "ऑर्डर और डिलीवरी", orderDate: "ऑर्डर की तारीख़", deliveryDate: "डिलीवरी की तारीख़",
    deliveriesTitle: "ऑर्डर, डिलीवरी और सप्लायर का बिल", deliveriesHelp: "जो मँगाया, जो असली में आया, और जिसका पैसा माँगा जा रहा है — तीनों मिलाइए। कुछ ज़रूरी नहीं है — अगर आप ऑर्डर नहीं बनाते, पहला बॉक्स छोड़ दीजिए।",
    stepOrder: "1 · आपने क्या मँगाया", stepOrderHelp: "सिर्फ़ अगर आप ऑर्डर बनाते हैं। इससे कुछ ख़रीदा नहीं जाता और स्टॉक नहीं बदलता।",
    orderNumber: "ऑर्डर नंबर", orderedQty: "कितना मँगाया", agreedRate: "एक का तय दाम, GST से पहले",
    placeOrder: "ऑर्डर भेजिए", orderSafety: "ऑर्डर एक वादा है, ख़रीद नहीं। जब तक सामान नहीं आता, बही या गोदाम में कुछ नहीं जाता।",
    stepReceipt: "2 · असली में क्या आया", stepReceiptHelp: "गेट पर गिनिए। सिर्फ़ जो आप रखते हैं वही स्टॉक में जाता है।",
    receiptNumber: "डिलीवरी नंबर", againstOrder: "किस ऑर्डर के अगेंस्ट", againstOrderHelp: "अगर कोई ऑर्डर नहीं था तो खाली छोड़ दीजिए।",
    arrivedQty: "कितना आया", keptQty: "कितना रखा", keptQtyHelp: "आए हुए से कम रखने पर वजह बतानी होगी।",
    rateIfNoOrder: "एक का दाम (जब ऑर्डर न हो)", whyRejected: "बाक़ी क्यों नहीं रखा",
    confirmGoods: "सामान पक्का कीजिए", receiptSafety: "पक्का करते ही रखा हुआ सामान तुरंत गोदाम में चला जाता है। बाक़ी कभी स्टॉक में नहीं आता, तो लौटाया हुआ माल आपके खाते में नहीं रहता।",
    stepMatch: "3 · सप्लायर का बिल", stepMatchHelp: "हम तीनों को साथ रख कर बताते हैं कि ठीक क्या नहीं मिल रहा।",
    billedQty: "बिल कितने का पैसा माँग रहा है", billedRate: "बिल पर एक का दाम", checkBill: "ये बिल जाँचिए",
    matchSafety: "ये सिर्फ़ मिलान है। बही में कुछ दर्ज नहीं होता और स्टॉक नहीं हिलता।",
    colItem: "सामान", colOrdered: "मँगाया", colArrived: "आया", colKept: "रखा", colTurnedAway: "वापस किया", colBilled: "बिल में", colAgreedPrice: "तय दाम", colBilledPrice: "बिल का दाम",
    differencesTitle: "क्या नहीं मिल रहा", approveReason: "ये अंतर क्यों ठीक है?", approveDifferences: "ये अंतर स्वीकार कीजिए",
    navCollections: "वसूली", collectionsTitle: "पेमेंट याद दिलाना", collectionsHelp: "भेजने से पहले संदेश देखिए, वादे या विवाद पर रोक लगाइए, और हर संदेश के साथ देखा गया बैलेंस संभल कर रखिए।", reminderPlan: "रिमाइंडर बनाइए", reminderDate: "इस तारीख़ का बैलेंस", reminderChannel: "इस ज़रिए भेजिए", channelInApp: "ऐप में", channelEmail: "ईमेल", channelWhatsapp: "WhatsApp", scheduleReminder: "रिव्यू में जोड़िए", sendDueReminders: "देखे हुए रिमाइंडर भेजिए", scheduledMessages: "तय संदेश", communicationHistory: "बात-चीत का इतिहास", collectionSafety: "भेजने से तुरंत पहले बैलेंस दोबारा देखा जाता है। चुकाए या विवाद वाले बिल पर रिमाइंडर नहीं जाता।", optOutCustomer: "ग्राहक ने रिमाइंडर बंद करने को कहा है", savePreference: "पसंद सेव कीजिए", promiseTitle: "पेमेंट का वादा", promisedAmount: "वादे की रकम", promisedDate: "वादे की तारीख़", savePromise: "वादा दर्ज कीजिए", disputeTitle: "ग्राहक का विवाद", disputedInvoice: "विवाद वाला इनवॉइस", disputeReason: "ग्राहक किस बात से असहमत है?", saveDispute: "इस इनवॉइस के रिमाइंडर रोकिए", noScheduled: "रिव्यू के लिए कोई रिमाइंडर नहीं है।", noCommunications: "अभी कोई कलेक्शन संदेश भेजने की कोशिश नहीं हुई।", navBankFeeds: "बैंक फ़ीड", bankFeedsTitle: "बैंक के लेन-देन अपने आप लाइए", bankFeedsHelp: "प्रोवाइडर को लेन-देन लाने की इजाज़त दीजिए। हर लाइन पहले रिव्यू में जाती है और पैसा कभी नहीं हिलता।", connectBank: "बैंक जोड़िए", bankConsentHelp: "प्रोवाइडर के पेज पर इजाज़त देते हैं और कभी भी कनेक्शन हटा सकते हैं।", giveBankPermission: "बैंक की इजाज़त शुरू कीजिए", approveSandboxPermission: "सैंडबॉक्स इजाज़त मंज़ूर कीजिए", bankFeedSafety: "हम बैंक पासवर्ड, PIN या OTP कभी नहीं माँगते या रखते। कनेक्शन हटाने पर पहले आए लेन-देन बही के लिए बचे रहते हैं।", connectedAccounts: "जुड़े बैंक खाते", importedBankTransactions: "आए हुए लेन-देन", noBankConnections: "अभी कोई बैंक नहीं जुड़ा है।", noBankTransactions: "अभी बैंक से कोई लेन-देन नहीं आया है।", syncNow: "नए लेन-देन लाइए", disconnectBank: "बैंक हटाइए", bankConnected: "बैंक जुड़ गया", bankSynced: "बैंक के लेन-देन आ गए", bankDisconnected: "बैंक हट गया", bankReturnRefused: "बैंक का ये जवाब इस विंडो में शुरू की गई रिक्वेस्ट से मेल नहीं खाता, इसलिए कुछ नहीं जुड़ा। बैंक फ़ीड से दोबारा शुरू कीजिए।",
    navOperations: "सेवा की स्थिति", operationsEyebrow: "सेवा की सेहत", operationsTitle: "क्या सेवा सही चल रही है?", operationsHelp: "इनवॉइस या बैंक रिकॉर्ड खोले बिना सर्विस चेक, बाहरी नाकामी, सुरक्षित रीट्राय और ग्राहक को दिखने वाली घटना देखिए।", operationsSafetyTitle: "ग्राहक का डेटा निजी रहता है। ", operationsSafety: "यहाँ सिर्फ़ एरर कोड और correlation ID दिखते हैं। रीट्राय तभी मिलता है जब काम सुरक्षित और डुप्लिकेट-प्रूफ़ घोषित हो।", operationsHealth: "सेहत की जाँच", operationsFailures: "बाहरी नाकामी", operationsQueue: "सुरक्षित रीट्राय क्यू", operationsRecurring: "नियमित काम", operationsIncidents: "ग्राहक स्थिति का इतिहास", operationsHealthy: "सभी जाँच सही चल रही हैं", operationsDegraded: "एक या अधिक जाँच पर ध्यान चाहिए", operationsNoFailures: "इस कंपनी के लिए कोई बाहरी नाकामी नहीं।", operationsNoJobs: "कोई काम इंतज़ार में नहीं।", operationsNoRecurring: "कोई नियमित काम दर्ज नहीं है।", operationsNextRun: "अगली बार", operationsLastRun: "पिछली बार", operationsNeverRun: "अभी नहीं चला", operationsRunning: "चल रहा है", operationsSucceeded: "पूरा हुआ", operationsFailed: "नाकाम हुआ", operationsDeadLettered: "बार-बार नाकामी के बाद रोका गया", operationsReplay: "सुरक्षित दोबारा चलाइए", operationsNoIncidents: "कोई मौजूदा या हाल की घटना नहीं।",
    navBusiness: "बिज़नेस की जानकारी", businessEyebrow: "आपका बिज़नेस", businessTitle: "आपका बिज़नेस, जैसा हर बिल पर छपता है", businessHelp: "क़ानून कहता है कि हर बिल पर आपका नाम, आपका पता और आपका GST नंबर हो। यहाँ एक बार लिखिए, फिर हर बिल, चालान और कोटेशन पर ये आएगा।",
    businessNameLegend: "नाम", businessLegalName: "रजिस्टर्ड नाम", businessTradeName: "काम का नाम (ऑप्शनल)", businessTradeNameHint: "ये भर दीजिए तो बिल पर रजिस्टर्ड नाम की जगह यही छपेगा।",
    businessAddressLegend: "पता", businessAddressHint: "सिर्फ़ शहर का नाम पता नहीं होता। बिल पर गली और PIN कोड दोनों ज़रूरी हैं।", businessAddress1: "पता, पहली लाइन", businessAddress2: "पता, दूसरी लाइन (ऑप्शनल)", businessCity: "शहर या कस्बा", businessPincode: "PIN कोड", businessState: "राज्य",
    businessContactLegend: "फ़ोन, ईमेल और PAN", businessPhone: "फ़ोन (ऑप्शनल)", businessEmail: "ईमेल (ऑप्शनल)", businessPan: "PAN (ऑप्शनल)",
    businessBankLegend: "बैंक अकाउंट (ऑप्शनल)", businessBankHint: "ग्राहक यहीं पैसा भेजता है। चारों भरिए, या चारों खाली छोड़ दीजिए।", businessBankName: "बैंक का नाम", businessAccountNumber: "अकाउंट नंबर", businessBranch: "ब्रांच", businessIfsc: "IFSC", businessBankRemove: "बैंक की जानकारी हटा दीजिए",
    businessWordsLegend: "आपके अपने शब्द (ऑप्शनल)", businessWordsHint: "यहाँ जो लिखेंगे वही बिल के नीचे वैसे का वैसा छपेगा। हम आपकी तरफ़ से कुछ नहीं लिखते।", businessDeclaration: "डिक्लेरेशन", businessTerms: "शर्तें",
    businessSignatureLegend: "दस्तख़त (ऑप्शनल)", businessSignatureHint: "PNG या JPG, 200 KB से छोटी। ये \u201cAuthorised Signatory\u201d के ऊपर छपती है।", businessNoSignature: "अभी कोई दस्तख़त नहीं", businessChooseSignature: "तस्वीर चुनिए", businessRemoveSignature: "दस्तख़त हटा दीजिए",
    businessSave: "बिज़नेस की जानकारी सेव कीजिए", businessSaved: "सेव हो गया। हर नए बिल पर ये आएगा।", businessSaving: "सेव हो रहा है\u2026", businessGstinNote: "आपका GST नंबर {gstin} है, जो {state} में रजिस्टर्ड है। बिल का पता उसी राज्य का होना चाहिए।", businessPanNote: "आपके GST नंबर में PAN {pan} पहले से है। एक बिज़नेस का एक ही PAN होता है, तो ये वही होना चाहिए।",
    setupAddress1: "पता, पहली लाइन", setupAddress2: "पता, दूसरी लाइन (ऑप्शनल)", setupCity: "शहर या कस्बा", setupPincode: "PIN कोड",
    navBranding: "बिल का डिज़ाइन", brandingEyebrow: "आपका बिल", brandingTitle: "बिल को अपना बनाइए", brandingHelp: "बिल पर अपना लोगो, अपना रंग और अपने काम की तस्वीर लगाइए। तीनों एक्स्ट्रा हैं। बिना इनके भी बिल पूरा और क़ानूनी है।",
    brandingLogoTitle: "आपका लोगो", brandingLogoHelp: "PNG, JPG, WEBP या SVG तस्वीर। सेव करने से पहले यहीं छोटी कर दी जाती है, और बिल के ऊपर दो सेंटीमीटर की छपती है।", brandingNoLogo: "अभी कोई लोगो नहीं", brandingChooseLogo: "तस्वीर चुनिए", brandingRemoveLogo: "लोगो हटा दीजिए", brandingAccentTaken: "हेडिंग और लकीरें इसी रंग में, जो आपके लोगो से लिया गया है।", brandingAccentReset: "डिज़ाइन का अपना रंग रखिए",
    brandingMarkTitle: "आपके काम की तस्वीर", brandingMarkHelp: "जो आप बेचते हैं वो लिखिए और तस्वीर चुनिए। ये सामान के पीछे बहुत हल्की छपती है, और छोटी परची वाले प्रिंटर पर कभी नहीं।", brandingSearchLabel: "आप क्या बेचते हैं?", brandingSearchPlaceholder: "मिठाई, कपड़ा, टायर, दवा", brandingSearchButton: "तस्वीरें ढूँढिए", brandingMarkChosen: "आपके बिल पर:", brandingRemoveMark: "तस्वीर हटा दीजिए", brandingNoMarkResults: "उस शब्द से कुछ नहीं मिला। जो बेचते हैं उसके लिए दूसरा शब्द लिखिए।",
    brandingDesignTitle: "डिज़ाइन और काग़ज़", brandingDesignLabel: "बिल का डिज़ाइन", brandingPaperLabel: "काग़ज़", brandingPaperA4: "A4 पन्ना", brandingPaperThermal: "छोटी परची, 80mm", brandingThermalNote: "छोटी परची वाले प्रिंटर में एक ही इंक होती है और ग्रे नहीं, इसलिए हल्की तस्वीर वहाँ कभी नहीं छपती।",
    brandingPreviewTitle: "नमूने का बिल", brandingPreviewHelp: "नीचे के सभी अंक बनावटी हैं। ये वही असली बिल प्रिंटर है, तो जो यहाँ दिख रहा है वही ग्राहक को मिलेगा।", brandingPreviewFrame: "नमूने के बिल की झलक", brandingSaved: "सेव हो गया। नए बिल पर ये आएगा।", brandingSaving: "सेव हो रहा है…", brandingLoadFailed: "झलक नहीं आ पाई।",
    brandingUpiTitle: "UPI से पेमेंट लीजिए", brandingUpiHelp: "अपनी UPI आईडी एक बार सेव कीजिए। फिर हर बिल पर एक स्क्वेयर छपेगा जिसे ग्राहक PhonePe, Google Pay या Paytm से स्कैन करेगा, और आपका नाम, बिल नंबर और बाक़ी रकम पहले से भरी होगी। पूरा चुका हुआ बिल, या छोटी 58mm परची पर स्क्वेयर नहीं छपता।", brandingUpiLabel: "आपकी UPI आईडी", brandingUpiPlaceholder: "aapkidukaan@okicici", brandingUpiSave: "UPI आईडी सेव कीजिए", brandingUpiSaved: "बिल का पेमेंट यहाँ आएगा:", brandingUpiRemove: "UPI आईडी हटा दीजिए",
    draftReady: "ड्राफ़्ट रिव्यू के लिए तैयार है", keepEditing: "बदलाव कीजिए", understand: "समझ गया",
    // Issues #304 and #310 — the five tabs, the + Bill sheet, More, Items, and the new Home.
    mainNavigation: "मुख्य मेनू", tabHome: "होम", tabKhata: "खाता", tabBill: "बिल", tabItems: "सामान", tabMore: "और",
    billSheetTitle: "नया बनाइए…", otherBills: "दूसरे बिल", navQuotation: "कोटेशन", navReturn: "वापसी", navExpense: "ख़र्च", expenseSoon: "ख़र्च जल्द आ रहा है।", booksTitle: "ख़र्च और मालिक का पैसा", booksHelp: "किराया, मज़दूरी और दूसरे ख़र्च, बैंक में जमा या बैंक से निकाला नक़द, और मालिक का लगाया या निकाला पैसा। हर एंट्री पहले जाँचिए, फिर सेव कीजिए। सेव हुई एंट्री कभी बदली नहीं जाती: उसे रद्द करके दोबारा डालिए।", booksExpense: "चुकाया गया ख़र्च", booksHead: "किस चीज़ का?", booksPaidFrom: "कहाँ से दिया", booksCash: "नक़द", booksBank: "बैंक", booksAmount: "GST से पहले रकम", booksConsignment: "सिर्फ़ भाड़ा: क्या ट्रांसपोर्टर ने बिल्टी / LR दी?", booksConsignmentNo: "नहीं (बस, रेल, टैक्सी, ऑटो, टेम्पो)", booksConsignmentYes: "हाँ", booksGstNote: "बिल पर GST है, या किराया बिना GST? इसे परचेज़ेस में डालिए, ताकि GST रिटर्न में आए।", booksBill: "बिल नंबर", booksNote: "नोट", booksDate: "तारीख़", booksOwner: "मालिक का पैसा", booksOwnerIn: "मालिक ने पैसा लगाया", booksOwnerOut: "मालिक ने घर के लिए पैसा निकाला", booksContra: "नक़द और बैंक", booksDeposit: "नक़द बैंक में जमा किया", booksWithdraw: "बैंक से नक़द निकाला", booksJournal: "जर्नल एंट्री (अकाउंटेंट)", booksJournalHelp: "समायोजन और सुधार के लिए। दोनों तरफ़ बराबर हों, और नोट में कारण लिखिए।", booksAccount: "खाता", booksDebit: "डेबिट", booksCreditSide: "क्रेडिट", booksWhat: "क्या हुआ?", booksAmountPlain: "रकम", booksCheck: "एंट्री जाँचिए", booksSave: "ये एंट्री सेव कीजिए", booksBookTitle: "कैश बुक और बैंक बुक", booksShowCash: "कैश बुक", booksShowBank: "बैंक बुक", booksOpening: "शुरुआती बाक़ी", booksClosing: "आख़िरी बाक़ी", booksIn: "आया", booksOut: "गया", booksBalance: "बाक़ी", booksAgainst: "किसके सामने", booksEntries: "यहाँ की गई एंट्रीज़", booksUndo: "रद्द कीजिए", booksUndoReason: "ये एंट्री क्यों रद्द की जा रही है?", booksOwedNote: "अभी चुकाया नहीं? इसे परचेज़ेस में सप्लायर के बिल की तरह डालिए।",
    navGroupPeople: "लोग", navGroupBusiness: "कारोबार की सेटिंग", navGroupReports: "रिपोर्ट",
    moreTitle: "और", moreHelp: "आपकी दुकान का बाक़ी सब कुछ, एक जगह।",
    itemsTitle: "सामान", itemsHelp: "आप क्या बेचते और ख़रीदते हैं, और गोदाम में कितना बचा है।", itemsAdd: "सामान जोड़िए", itemsEdit: "बदलिए", itemsNone: "अभी कोई सामान नहीं। जो बेचते हैं, पहले वो जोड़िए।",
    itemsLeft: "{quantity} {unit} बचा", itemsNoneLeft: "ख़त्म", itemsService: "सेवा", itemsLine: "HSN {code} · GST {rate}", itemsExempt: "छूट",
    homeGreeting: "नमस्ते, {company}", homeMoneyTitle: "आज आपका पैसा", homeSalesToday: "आज की बिक्री", homeCash: "गल्ले में नक़द", homeBank: "आज UPI और बैंक में आया", homeToCollect: "लेना है", homeToPay: "देना है",
    homeTasksTitle: "आज आपके लिए", homeAllClear: "आज सब ठीक है", homeRecentBills: "हाल के बिल", homeNoBills: "अभी कोई बिल नहीं। पहला बिल बनाने के लिए + बिल दबाइए।",
    homeChipPaid: "चुकाया", homeChipDue: "{amount} बाक़ी", homeChipLate: "{amount} · {days} दिन देर", homeChipLateOne: "{amount} · 1 दिन देर",
    payCash: "नक़द", payUpi: "UPI", payCard: "कार्ड", payBank: "बैंक", payCheque: "चेक", payUdhaar: "उधार"
  }
};

const storage = (() => {
  try {
    const probe = "karobar-storage-probe";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return localStorage;
  } catch { return undefined; }
})();

// Issue #343 — an invitation link (`/#join=…`): kept in memory for the sign-in, and taken out of the
// address bar at once so it is not left in the history or a bookmark.
const invitationToken = location.hash.startsWith("#join=") ? decodeURIComponent(location.hash.slice("#join=".length)) : null;
if (invitationToken !== null) history.replaceState(null, "", "#dashboard");
const state = { locale: storage?.getItem("karobar.locale") ?? "en-IN", view: location.hash.slice(1) || "dashboard", dashboard: null, returnDocuments: [], pendingForm: null, pendingInput: null, pendingReturnInput: null, signedIn: storage?.getItem("karobar.signedIn") === "1", draftStatuses: {} };
if (!(state.locale in copy)) state.locale = "en-IN";

const REPORT_TEXT = {
  answerLabel: { "en-IN": "Answer", "hi-IN": "जवाब" },
  whereFrom: { "en-IN": "Where these figures come from", "hi-IN": "ये आँकड़े कहाँ से आए" },
  recordsBehind: { "en-IN": "records behind it", "hi-IN": "इसके पीछे के रिकॉर्ड" },
  ruleSays: { "en-IN": "What the rule says", "hi-IN": "नियम क्या कहता है" },
  inForceFrom: { "en-IN": "In force from", "hi-IN": "कब से लागू" },
  weCannotSay: { "en-IN": "We will not say", "hi-IN": "हम नहीं कहेंगे" },
  ruleUnclear: { "en-IN": "Not settled enough to rely on", "hi-IN": "भरोसा करने लायक तय नहीं" },
  assumedNote: { "en-IN": "What I took as given", "hi-IN": "मैंने क्या मान लिया" },
  leftOut: { "en-IN": "Left out of this answer", "hi-IN": "इस जवाब से बाहर" },
  askingAbout: { "en-IN": "Period", "hi-IN": "समय" },
  thinking: { "en-IN": "Looking it up…", "hi-IN": "देख रहा हूँ…" },
  bringingIn: { "en-IN": "Bringing it in…", "hi-IN": "लाया जा रहा है…" },
  columnHeader: { "en-IN": "Column in your file", "hi-IN": "आपकी फ़ाइल का कॉलम" },
  weReadItAs: { "en-IN": "We read it as", "hi-IN": "हम इसे समझते हैं" },
  notUsed: { "en-IN": "Not used", "hi-IN": "इस्तेमाल नहीं" },
  pleaseConfirm: { "en-IN": "Please confirm", "hi-IN": "पुष्टि कीजिए" },
  whatThisFileIs: { "en-IN": "What this file looks like", "hi-IN": "ये फ़ाइल क्या लगती है" },
  checkTheColumns: { "en-IN": "Check the columns, then continue", "hi-IN": "कॉलम देखिए, फिर आगे बढ़िए" },
  continueToPreview: { "en-IN": "These are right — show me what happens", "hi-IN": "ये सही हैं — दिखाइए क्या होगा" },
  bringItIn: { "en-IN": "Bring it into my books", "hi-IN": "मेरे हिसाब में लाइए" },
  undoImport: { "en-IN": "Take this back out", "hi-IN": "इसे वापस निकालिए" },
  rowsReady: { "en-IN": "Rows ready", "hi-IN": "तैयार रोज़" },
  rowsToFix: { "en-IN": "Rows to fix first", "hi-IN": "पहले ठीक करनी हैं" },
  rowsAlreadyHere: { "en-IN": "Already here", "hi-IN": "पहले से मौजूद" },
  rowCol: { "en-IN": "Row", "hi-IN": "रो" },
  whatIsWrong: { "en-IN": "What we found", "hi-IN": "हमें क्या मिला" },
  downloadErrors: { "en-IN": "Download the rows to fix", "hi-IN": "ठीक करनी वाली रोज़ डाउनलोड कीजिए" },
  fileTotals: { "en-IN": "What the file adds up to", "hi-IN": "फ़ाइल का जोड़" },
  broughtIn: { "en-IN": "Brought in", "hi-IN": "लाया गया" },
  booksNow: { "en-IN": "Your books now", "hi-IN": "अब आपका हिसाब" },
  stockNow: { "en-IN": "In the godown", "hi-IN": "गोदाम में" },
  customersCreated: { "en-IN": "Customers and suppliers", "hi-IN": "ग्राहक और सप्लायर" },
  itemsCreated: { "en-IN": "Items", "hi-IN": "सामान" },
  whyUndo: { "en-IN": "Why are you taking it back out?", "hi-IN": "इसे वापस क्यों निकाल रहे हैं?" },
  takenBackOut: { "en-IN": "Taken back out", "hi-IN": "वापस निकाल दिया" },
  sameFileAgain: { "en-IN": "This is a file you already brought in", "hi-IN": "ये फ़ाइल पहले ही लाई जा चुकी है" },
  differenceReason: { "en-IN": "The two sides do not agree. If you want it recorded anyway, say why:", "hi-IN": "दोनों तरफ़ बराबर नहीं हैं। फिर भी दर्ज करना है तो कारण लिखिए:" },
  account: { "en-IN": "Account", "hi-IN": "खाता" },
  amount: { "en-IN": "Amount", "hi-IN": "रकम" },
  balanceCol: { "en-IN": "Balance", "hi-IN": "बाक़ी" },
  balanced: { "en-IN": "Balanced", "hi-IN": "बराबर है" },
  booksFrom: { "en-IN": "Books from", "hi-IN": "हिसाब कब से" },
  bothSides: { "en-IN": "Both sides", "hi-IN": "दोनों तरफ़" },
  business: { "en-IN": "Business", "hi-IN": "बिज़नेस" },
  businessCreated: { "en-IN": "Business created", "hi-IN": "बिज़नेस बन गया" },
  canBeSold: { "en-IN": "Can be sold", "hi-IN": "बेच सकते हैं" },
  cashDayOne: { "en-IN": "Cash on day one", "hi-IN": "पहले दिन का कैश" },
  checking: { "en-IN": "Checking…", "hi-IN": "जाँच हो रही है…" },
  claimsOnIt: { "en-IN": "Claims on it", "hi-IN": "उस पर दावे" },
  codeCol: { "en-IN": "Code", "hi-IN": "कोड" },
  creating: { "en-IN": "Creating…", "hi-IN": "बन रहा है…" },
  customer: { "en-IN": "Customer", "hi-IN": "ग्राहक" },
  dateCol: { "en-IN": "Date", "hi-IN": "तारीख़" },
  doesNotBalance: { "en-IN": "Does not balance — look below", "hi-IN": "बराबर नहीं — नीचे देखिए" },
  everythingEarned: { "en-IN": "Everything you earned", "hi-IN": "जो कुछ कमाया" },
  everythingSpent: { "en-IN": "Everything you spent", "hi-IN": "जो कुछ ख़र्च हुआ" },
  firstItem: { "en-IN": "First item", "hi-IN": "पहला सामान" },
  ratesDeclaredLabel: { "en-IN": "GST rates you declared", "hi-IN": "आपके बताए GST रेट" },
  gstCollected: { "en-IN": "GST you collected", "hi-IN": "आपने जो GST लिया" },
  gstPaid: { "en-IN": "GST you had already paid", "hi-IN": "आप पहले जो GST दे चुके थे" },
  godown: { "en-IN": "Godown", "hi-IN": "गोदाम" },
  goodsValue: { "en-IN": "Goods value", "hi-IN": "माल की कीमत" },
  gstCol: { "en-IN": "GST", "hi-IN": "GST" },
  earnedNote: { "en-IN": "Goods value is what you sold on these bills. Goods customers returned are taken off it under \"What you earned and what you spent\", as net sales. The GST beside it is collected for the government and owed to them, so it is not part of your income.", "hi-IN": "माल की कीमत इन बिलों पर हुई बिक्री है। ग्राहकों ने जो माल लौटाया, वो \"कितना कमाया और कितना ख़र्च हुआ\" में इससे घटाया जाता है, नेट बिक्री के रूप में। उसके साथ का GST सरकार के लिए वसूला गया है और उन्हें देना है, इसलिए वो आपकी आमदनी में नहीं गिनता।" },
  itemCol: { "en-IN": "Item", "hi-IN": "सामान" },
  leftCol: { "en-IN": "Left", "hi-IN": "बचा" },
  moneyNoBill: { "en-IN": "Money with no bill", "hi-IN": "बिना बिल का पैसा" },
  numberCol: { "en-IN": "Number", "hi-IN": "नंबर" },
  oldestLate: { "en-IN": "Oldest days late", "hi-IN": "सबसे पुराना कितने दिन लेट" },
  lateCountedTo: { "en-IN": "Days late are counted up to {date}.", "hi-IN": "कितने दिन लेट है, ये {date} तक गिना गया है।" },
  openingEntry: { "en-IN": "Opening entry posted", "hi-IN": "शुरुआती एंट्री दर्ज हुई" },
  owedEarned: { "en-IN": "Owed or earned", "hi-IN": "देना या कमाई" },
  ownedSpent: { "en-IN": "Owned or spent", "hi-IN": "अपना या ख़र्च" },
  ownsMatch: { "en-IN": "Owns and owes match", "hi-IN": "जो है और जो देना है, दोनों मिल रहे हैं" },
  rateDeclared: { "en-IN": "Rate you declared", "hi-IN": "आपका बताया रेट" },
  readyToCreate: { "en-IN": "Ready to create", "hi-IN": "बनाने के लिए तैयार" },
  sideCol: { "en-IN": "Side", "hi-IN": "तरफ़" },
  stillOwed: { "en-IN": "Still owed", "hi-IN": "अभी बाक़ी" },
  supplier: { "en-IN": "Supplier", "hi-IN": "सप्लायर" },
  booksBalance: { "en-IN": "The books balance", "hi-IN": "हिसाब बराबर है" },
  booksDoNotBalance: { "en-IN": "The books do not balance", "hi-IN": "हिसाब बराबर नहीं है" },
  twoSidesSame: { "en-IN": "The two sides come to the same figure.", "hi-IN": "दोनों तरफ़ का जोड़ बराबर है।" },
  twoSidesDiffer: { "en-IN": "The two sides do not match.", "hi-IN": "दोनों तरफ़ का जोड़ बराबर नहीं है।" },
  total: { "en-IN": "Total", "hi-IN": "कुल" },
  whatIsLeft: { "en-IN": "What is left", "hi-IN": "क्या बचा" },
  whatItWas: { "en-IN": "What it was", "hi-IN": "क्या था" },
  businessOwns: { "en-IN": "What the business owns", "hi-IN": "बिज़नेस के पास क्या है" },
  oweSuppliers: { "en-IN": "What you owe suppliers", "hi-IN": "सप्लायर्स को क्या देना है" },
  // Issue #261 — paid before the bill; beside what is owed, never taken out of it.
  advancesToSuppliers: { "en-IN": "Advances paid to suppliers", "hi-IN": "सप्लायर्स को दिया एडवांस" },
  // Issue #295 — the TDS receivable report's columns.
  tdsQuarter: { "en-IN": "Quarter", "hi-IN": "क्वार्टर" },
  billCol: { "en-IN": "Bill", "hi-IN": "बिल" },
  tdsSection: { "en-IN": "Section", "hi-IN": "सेक्शन" },
  worth: { "en-IN": "Worth", "hi-IN": "कीमत" },
  openingBooks: { "en-IN": "Its opening books, straight from the ledger", "hi-IN": "इसकी शुरुआती बुक्स, सीधा लेजर से" },
  nothingCreated: { "en-IN": "Nothing was created. Fix these and check again.", "hi-IN": "कुछ नहीं बना। इन्हें ठीक करके दोबारा जाँचिए।" },
  needsALook: { "en-IN": "A few things need a look", "hi-IN": "कुछ चीज़ें देखनी हैं" },
  checkOut: { "en-IN": "These check out. Nothing is saved until you create the business.", "hi-IN": "ये ठीक हैं। जब तक बिज़नेस नहीं बनाते, कुछ सेव नहीं होता।" },
  booksStartEmpty: { "en-IN": "none — books start empty", "hi-IN": "कोई नहीं — बुक्स ख़ाली शुरू होती हैं" },
};

/** Text the API returns in both languages. The reader's choice decides, with English as the fallback. */
const t = (value) => (value === null || typeof value !== "object" ? (value ?? "") : (value[state.locale] ?? value["en-IN"] ?? ""));

const text = (key, values = {}) => Object.entries(values).reduce((message, [name, value]) => message.replaceAll(`{${name}}`, String(value)), copy[state.locale][key]);
const money = (amount) => new Intl.NumberFormat(state.locale, { style: "currency", currency: "INR", minimumFractionDigits: 2 }).format(Number(amount) || 0);
// Issue #234 — one "today" for the whole app: the date in India (Asia/Kolkata), taken from the
// server once Home has loaded, and worked out the same way in the browser until then. Never the
// device's own time zone, and never UTC, which is still yesterday in India until 05:30.
const indiaDate = (at = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
const dateInput = () => state.today ?? indiaDate();
/** "2026-08" — the month before today's: the one a business is actually filing. */
const previousMonth = () => {
  const [year, month] = dateInput().split("-").map(Number);
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
};
/**
 * The server's today wins when it differs (a device clock set wrong, or a page left open overnight):
 * the date fields still showing the old default move to it, and anything a person typed is left alone.
 */
function adoptServerToday(today) {
  if (typeof today !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(today) || today === dateInput()) return;
  const before = dateInput();
  state.today = today;
  document.querySelectorAll("input[type=date]:not([data-no-default])").forEach((field) => { if (field.value === before) field.value = today; });
  // Issue #266 — a draft's date line names today, so it follows the server's today too.
  document.querySelectorAll(".draft-form").forEach((form) => {
    if (form.dataset.draftStartedOn) settleDraftDate(form, form.dataset.draftStartedOn, form.dataset.draftStartedOn);
  });
  const heading = document.querySelector('[data-i18n="today"]');
  if (heading) heading.textContent = `${copy[state.locale].today} · ${new Intl.DateTimeFormat(state.locale, { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" }).format(new Date(`${today}T12:00:00+05:30`))}`;
}

function translate() {
  document.documentElement.lang = state.locale;
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    const value = copy[state.locale][element.dataset.i18n];
    if (value === undefined) throw new Error(`Missing ${state.locale} translation: ${element.dataset.i18n}`);
    element.textContent = value;
  });
  document.querySelectorAll("[data-i18n-aria]").forEach((element) => {
    const value = copy[state.locale][element.dataset.i18nAria];
    if (value === undefined) throw new Error(`Missing ${state.locale} translation: ${element.dataset.i18nAria}`);
    element.setAttribute("aria-label", value);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((element) => {
    const value = copy[state.locale][element.dataset.i18nPlaceholder];
    if (value === undefined) throw new Error(`Missing ${state.locale} translation: ${element.dataset.i18nPlaceholder}`);
    element.setAttribute("placeholder", value);
  });
  document.querySelectorAll("[data-money]").forEach((element) => { element.textContent = money(element.dataset.money); });
  const today = document.querySelector('[data-i18n="today"]');
  if (today) today.textContent = `${copy[state.locale].today} · ${new Intl.DateTimeFormat(state.locale, { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" }).format(new Date(`${dateInput()}T12:00:00+05:30`))}`;
  document.querySelector("#locale").value = state.locale;
  document.querySelectorAll(".draft-form").forEach((form) => setDraftStatus(form, state.draftStatuses[form.dataset.draft] ?? "savedDevice"));
  updateCalculations();
  if (state.dashboard) renderDashboard(state.dashboard);
  // The reminder rows are sentences from the server in both languages, so switching language must
  // redraw them; a half-translated page is worse than an untranslated one.
  if (state.reminders) renderReminders(state.reminders);
  if (planState !== null) renderPlan(planState);
  renderAskExamples();
  if (lastAskAnswer !== null) renderAnswer(lastAskAnswer);
}

// Issue #241 — an entry may open one part of a screen ("What is in the godown" is the stock part of
// Reports). Only the entry for what is on screen is marked as the current one. Issue #304 — of the
// five tabs, + Bill is current on a bill it opens, and More on any screen no other tab stands for.
function openView(view, section = null) {
  const target = document.querySelector(`#view-${view}`) ? view : "dashboard";
  state.view = target;
  document.querySelectorAll(".view").forEach((element) => element.classList.toggle("active", element.id === `view-${target}`));
  document.querySelectorAll("[data-view]").forEach((element) => {
    const sameScreen = element.dataset.view === target && (element.dataset.section ?? null) === section;
    const active = sameScreen || (element.dataset.alsoViews ?? "").split(" ").includes(target);
    element.classList.toggle("active", active);
    if (active) element.setAttribute("aria-current", "page"); else element.removeAttribute("aria-current");
  });
  const bill = document.querySelector("#bill-button");
  const onBill = [...document.querySelectorAll("#bill-sheet [data-view]")].some((choice) => choice.dataset.view === target);
  if (onBill) bill?.setAttribute("aria-current", "page"); else bill?.removeAttribute("aria-current");
  if (!document.querySelector(".app-tabbar [aria-current]")) document.querySelector("#more-tab")?.setAttribute("aria-current", "page");
  const sheet = document.querySelector("#bill-sheet");
  if (sheet?.open) sheet.close();
  history.replaceState(null, "", `#${target}`);
  document.querySelector(`#view-${target} h1`)?.focus?.();
  if (target === "purchase") loadSelfInvoices();
  // Issue #310 — Home is read afresh every time it is opened, so a task done elsewhere is gone.
  if (target === "dashboard" && state.dashboard) loadDashboard();
  // Issue #358 — the screen keeps what it showed; the reason is not lost.
  if (target === "items") renderItems().catch((error) => console.error("The items list could not be read again.", error));
  if (target === "reports") loadReports().then(() => { if (section && state.view === "reports") document.querySelector(`#${section}`)?.scrollIntoView({ block: "start" }); });
  if (target === "migration") startMigration();
  if (target === "returns") { loadReturnDocuments(); loadReturnNotes(); }
  // Issue #294 — expenses, contra and journal entries, and the cash and bank books.
  if (target === "books") import("/books.js").then((books) => books.openBooks({ api, words: copy[state.locale] })).catch((error) => console.error("The expenses screen could not open.", error));
  if (target === "reminders") loadReminders();
  if (target === "plan") loadPlan();
  if (target === "team") loadTeam();
  if (target === "vehicle") loadVehiclesHeld();
  if (target === "presale") openPresale();
  if (target === "challan") openChallans();
  // The document picker must include anything issued since sign-in, invoices and challans alike.
  if (target === "eway") loadEwayRoad();
  // Issue #240 — back on the bill after raising its e-way bill, the line under it says so.
  // (Guarded: the first view opens while the page is still loading, before the bill state exists.)
  try { if (target === "sale" && billOnScreen.invoiceId) showSaleBillEway(billOnScreen.invoiceId, false); } catch { /* not loaded yet */ }
  // Issue #305 — back on the sale (from Business details, say), the slide it was on is read again.
  try { if (target === "sale") saleSlidesShown(); } catch { /* not loaded yet */ }
  if (target === "itc") openItc();
  if (target === "gst-returns") openGstReturns();
  if (target === "bank-feeds") loadBankFeeds();
  if (target === "operations") loadOperations();
  if (target === "ask") loadAskExamples();
  if (target === "ask") { loadAskExamples(); loadAgentCapabilities(); }
  if (target === "business") openBusinessDetails();
  if (target === "einvoice") loadIssuedInvoices();
  if (target === "setup") loadSetupStates();
  if (target === "branding") openBranding();
  if (target === "design") openDesign();
}

// ------------------------------------------------ issue #303: the design system on one page
//
// Owner-only: the page asks the server who is signed in, and only an owner (who may set up the
// books) sees it. The same specimen is drawn twice, once from each language's words, and the money
// card carries this shop's own figures from Home.

async function openDesign() {
  const content = document.querySelector("#design-content");
  const refused = document.querySelector("#design-owner-only");
  let owner = false;
  try { owner = (await api("/api/session")).permissions.includes("ledger.setup"); } catch { owner = false; }
  content.hidden = !owner;
  refused.hidden = owner;
  if (owner) renderDesign();
}

function renderDesign() {
  const metrics = state.dashboard?.metrics ?? {};
  const figures = { customersOwe: metrics.customersOwe ?? 0, salesToday: metrics.salesToday ?? 0, suppliersOwed: state.dashboard?.supplier?.outstanding ?? 0, specimen: 118944 };
  const template = document.querySelector("#design-specimen");
  document.querySelector("#design-specimens").replaceChildren(...["en-IN", "hi-IN"].map((locale) => {
    const words = copy[locale];
    const specimen = template.content.firstElementChild.cloneNode(true);
    specimen.lang = locale;
    specimen.querySelectorAll("[data-design]").forEach((element) => { element.textContent = words[element.dataset.design]; });
    const format = (amount) => new Intl.NumberFormat(locale, { style: "currency", currency: "INR", minimumFractionDigits: 2 }).format(amount);
    specimen.querySelectorAll("[data-design-money]").forEach((element) => { element.textContent = format(figures[element.dataset.designMoney]); });
    // The slide moves sideways on Next; the last step pops its tick once.
    const steps = ["dsStepItems", "dsStepCustomer", "dsStepPayment", "dsStepDone"];
    let step = 0;
    const slide = specimen.querySelector("[data-slide]");
    const next = specimen.querySelector("[data-slide-next]");
    const show = () => {
      specimen.querySelector("[data-slide-title]").textContent = words[steps[step]];
      specimen.querySelector("[data-slide-ok]").hidden = step !== 2;
      specimen.querySelector("[data-slide-tick]").hidden = step !== 3;
      specimen.querySelectorAll(".slide-dots span").forEach((dot, index) => dot.toggleAttribute("data-current", index === step));
      next.textContent = words[step === 3 ? "dsAgain" : step === 2 ? "dsMakeBill" : "dsNext"];
      slide.classList.remove("entering");
      void slide.offsetWidth;
      slide.classList.add("entering");
    };
    next.addEventListener("click", () => { step = (step + 1) % steps.length; show(); });
    show();
    return specimen;
  }));
}

document.querySelectorAll("[data-theme-choice]").forEach((button) => button.addEventListener("click", () => {
  const theme = button.dataset.themeChoice;
  if (theme) document.documentElement.dataset.theme = theme; else delete document.documentElement.dataset.theme;
  document.querySelectorAll("[data-theme-choice]").forEach((choice) => choice.setAttribute("aria-pressed", String(choice === button)));
}));

function draftData(form) {
  return Object.fromEntries([...new FormData(form).entries()].filter(([, value]) => typeof value === "string"));
}

function setDraftStatus(form, key) {
  state.draftStatuses[form.dataset.draft] = key;
  const status = document.querySelector(`#${form.dataset.draft}-save-state`);
  if (status) status.textContent = copy[state.locale][key];
}

/**
 * Issue #266 — what a saved draft's date means when it comes back on a later day, form by form.
 *
 *   - sale: the date a tax invoice carries is the day it is issued, so a draft left from an earlier
 *     day comes back dated today, and one line above the form says so.
 *   - purchase: the bill date is the supplier's, printed on their bill; it is never changed. The
 *     line says it was kept, so it is checked against the paper.
 *   - payment / paid: the date the money came in or went out, which is a fact about that day, so it
 *     is kept too, and the line says so.
 */
const DRAFT_DATE_RULES = { sale: "moveToToday", purchase: "keepSupplierDate", payment: "keepMoneyDate", paid: "keepMoneyDate" };
const longDate = (iso) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" }).format(new Date(`${iso}T12:00:00+05:30`));

function draftDateNote(form) {
  return document.querySelector(`#${form.dataset.draft}-draft-date-note`);
}

function hideDraftDateNote(form) {
  const note = draftDateNote(form);
  if (note) { note.hidden = true; note.querySelector("[data-note-text]").textContent = ""; }
  delete form.dataset.draftStartedOn;
}

/** Brings a restored draft's date up to today where the form says it should, and says what happened. */
function settleDraftDate(form, startedOn, savedOn) {
  const rule = DRAFT_DATE_RULES[form.dataset.draft];
  const field = form.querySelector('input[name="date"]');
  const note = draftDateNote(form);
  if (!rule || !field || !field.value) return false;
  const today = dateInput();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(startedOn || "") ? startedOn : field.value;
  const lastSaved = /^\d{4}-\d{2}-\d{2}$/.test(savedOn || "") ? savedOn : field.value;
  // Saved today: whatever date is in the box was put there today, on purpose or by default.
  if (lastSaved >= today) return false;
  form.dataset.draftStartedOn = from;
  let message;
  let moved = false;
  if (rule === "moveToToday") {
    if (field.value !== today) { field.value = today; moved = true; }
    message = text("draftSaleDateMoved", { started: longDate(from), today: longDate(today) });
  } else if (rule === "keepSupplierDate") {
    message = text("draftPurchaseDateKept", { started: longDate(from), date: longDate(field.value) });
  } else {
    message = text("draftMoneyDateKept", { started: longDate(from), date: longDate(field.value) });
  }
  if (note) { note.querySelector("[data-note-text]").textContent = message; note.hidden = false; }
  return moved;
}

function restoreDraft(form) {
  const saved = storage?.getItem(`karobar.draft.${form.dataset.draft}`);
  if (!saved) return;
  try {
    const values = JSON.parse(saved);
    const waiting = {};
    Object.entries(values).forEach(([name, value]) => {
      const field = form.elements.namedItem(name);
      if (!field || !("value" in field) || typeof value !== "string") return;
      field.value = value;
      // Follow-up to #266 — a choice whose list has not arrived yet (the customer, the supplier, the
      // delivery address) is held and put back when the list comes, never dropped.
      if (field.value !== value) waiting[name] = value;
    });
    const lines = Array.isArray(values[DRAFT_LINES]) ? values[DRAFT_LINES] : null;
    if (Object.keys(waiting).length > 0 || lines !== null) pendingDraft.set(form.dataset.draft, { choices: waiting, lines });
    // A sale whose goods go somewhere else, or that already carries transport details, opens its
    // delivery box, so where the goods go (and so which state the sale counts in) is in sight.
    const deliveryBox = form.querySelector("#sale-delivery");
    if (deliveryBox && ((values.shipTo && values.shipTo !== "same") || ["transporterId", "vehicleNumber", "lrNumber", "destination", "ewayBillNumber"].some((name) => values[name]))) deliveryBox.open = true;
    // The draft on the device now carries the new date too. Only the date is written back: a box
    // whose choices have not loaded yet (the customer list) must not lose what was saved for it.
    if (settleDraftDate(form, values[DRAFT_STARTED], values[DRAFT_SAVED])) {
      storage?.setItem(`karobar.draft.${form.dataset.draft}`, JSON.stringify({ ...values, date: dateInput(), [DRAFT_STARTED]: values[DRAFT_STARTED] || values.date, [DRAFT_SAVED]: dateInput() }));
    }
    setDraftStatus(form, "draftRestored");
  } catch { storage?.removeItem(`karobar.draft.${form.dataset.draft}`); }
}

// Issue #266 — the days a draft was started and last saved, kept beside its fields on the device.
const DRAFT_STARTED = "__startedOn";
const DRAFT_SAVED = "__savedOn";
// Follow-up to #266 — the item lines of a sale or supplier bill, kept with the draft.
const DRAFT_LINES = "__lines";
/**
 * Saved choices and lines still waiting for their lists (customers, suppliers, items, a customer's
 * delivery addresses), per form. The lists arrive after the page has put the draft back, and a
 * choice missing from a list cannot be shown, so it waits here instead of being lost.
 */
const pendingDraft = new Map();

function draftLines(form) {
  const box = form.querySelector(".sale-lines");
  if (!box) return undefined;
  return [...box.querySelectorAll(".sale-line")].map((line) => Object.fromEntries(
    [...line.querySelectorAll("[data-line-field]")].map((field) => [field.dataset.lineField, field.value]),
  ));
}

function saveDraft(form, startedOn) {
  let started = startedOn;
  if (!started) {
    try { started = JSON.parse(storage?.getItem(`karobar.draft.${form.dataset.draft}`) || "{}")[DRAFT_STARTED]; } catch { started = undefined; }
  }
  // What is still waiting for its list is kept as saved, not replaced by the empty box on screen.
  const waiting = pendingDraft.get(form.dataset.draft);
  const lines = waiting?.lines ?? draftLines(form);
  storage?.setItem(`karobar.draft.${form.dataset.draft}`, JSON.stringify({
    ...draftData(form), ...(waiting?.choices ?? {}),
    ...(lines === undefined ? {} : { [DRAFT_LINES]: lines }),
    [DRAFT_STARTED]: started || dateInput(), [DRAFT_SAVED]: dateInput(),
  }));
  setDraftStatus(form, "savedDevice");
}

/**
 * Puts waiting choices back once their list is on screen. `names` limits it to the boxes that list
 * fills; with `final`, a choice the loaded list does not have (a customer since removed) is let go.
 */
function applyPendingChoices(names, final) {
  pendingDraft.forEach((waiting, draft) => {
    const form = document.querySelector(`[data-draft="${draft}"]`);
    if (!form) return;
    Object.entries(waiting.choices).forEach(([name, value]) => {
      if (!names.includes(name)) return;
      const field = form.elements.namedItem(name);
      if (field && [...(field.options ?? [])].some((option) => option.value === value)) field.value = value;
      else if (!final) return;
      delete waiting.choices[name];
    });
    if (Object.keys(waiting.choices).length === 0 && waiting.lines === null) pendingDraft.delete(draft);
  });
}

/** Follow-up to #266 — rebuilds a draft's item lines once the item list is there to choose from. */
function restorePendingLines() {
  pendingDraft.forEach((waiting, draft) => {
    if (waiting.lines === null) return;
    const add = draft === "sale" ? addSaleLine : draft === "purchase" ? addPurchaseLine : null;
    const box = document.querySelector(`#${draft}-lines`);
    if (add && box && waiting.lines.length > 0) {
      box.replaceChildren();
      waiting.lines.forEach((saved) => {
        const line = add();
        if (!line) return;
        Object.entries(saved).forEach(([name, value]) => {
          const field = line.querySelector(`[data-line-field="${name}"]`);
          if (field && typeof value === "string" && (field.tagName !== "SELECT" || [...field.options].some((option) => option.value === value))) field.value = value;
        });
        showLineUnit(line);
      });
    }
    waiting.lines = null;
    if (Object.keys(waiting.choices).length === 0) pendingDraft.delete(draft);
  });
  updateCalculations();
}

function forgetPendingDraft(form) {
  pendingDraft.delete(form.dataset.draft);
}

// Issue #342 — the session is an HttpOnly cookie the browser sends by itself; this page never sees it.
// "karobar.signedIn" is only a hint for which screen to open first, and opens nothing on the server.
storage?.removeItem("karobar.session");
const SIGN_IN_PATHS = new Set(["/api/auth/code", "/api/auth/sign-in"]);

async function api(path, options = {}) {
  // Issue #298 — the screen's language goes with every call so the server's sentences come back
  // in it: inside the body on writes, in the query on reads.
  if (options.method && String(options.method).toUpperCase() !== "GET" && typeof options.body === "string") {
    options = { ...options, body: JSON.stringify({ ...JSON.parse(options.body), locale: state.locale }) };
  } else {
    path = `${path}${path.includes("?") ? "&" : "?"}locale=${encodeURIComponent(state.locale)}`;
  }
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.message || copy[state.locale].requestFailed);
    error.status = response.status;
    error.code = payload.code;
    // Issue #262 — the facts behind a refusal (the Hindi sentence, the goods that are short).
    error.details = payload.details ?? {};
    if (response.status === 401 && !SIGN_IN_PATHS.has(path)) {
      state.signedIn = false;
      storage?.removeItem("karobar.signedIn");
      showLogin();
    }
    throw error;
  }
  return payload;
}

/**
 * Issue #344 — a list route answers one page at a time. The screens show the whole list, so this
 * follows `nextCursor` until the last page and hands back the response with every item under `key`.
 */
async function apiList(path, key) {
  // The largest page the server gives, so a long list is read in as few calls as possible.
  path = `${path}${path.includes("?") ? "&" : "?"}limit=500`;
  const first = await api(path);
  const items = [...first[key]];
  for (let cursor = first.nextCursor; cursor !== undefined; ) {
    const page = await api(`${path}${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}`);
    items.push(...page[key]);
    cursor = page.nextCursor;
  }
  const { nextCursor: _last, ...rest } = first;
  return { ...rest, [key]: items };
}

function showLogin() {
  const dialog = document.querySelector("#login-dialog");
  if (!dialog.open) dialog.showModal();
  showTesterButton();
}

/** What every sign-in does once the session cookie is set: close the dialog and read this business afresh. */
async function afterSignIn() {
  state.signedIn = true;
  storage?.setItem("karobar.signedIn", "1");
  document.querySelector("#login-dialog").close("signed-in");
  resetLoginForm();
  loadSession();
  await loadDashboard();
  loadCatalogue();
  loadSupplierChoices();
  loadIssuedInvoices();
  loadReturnDocuments();
  loadEwayRoad();
  loadEwayStates();
  loadVehicleChoices();
  loadVehiclesHeld();
  loadSetupStates();
  loadReminders();
}

/** The owner's request: "Sign in as tester", only where the server says it exists (a developer's machine); 404 anywhere else hides it. */
async function showTesterButton() {
  const button = document.querySelector("#login-tester");
  if (!button) return;
  try { button.hidden = !(await fetch("/api/auth/tester", { credentials: "same-origin" })).ok; } catch { button.hidden = true; }
}
document.querySelector("#login-tester")?.addEventListener("click", async () => {
  const error = document.querySelector("#login-error");
  error.textContent = "";
  try {
    await api("/api/auth/tester", { method: "POST" });
    await afterSignIn();
  } catch (failure) { error.textContent = failure.message || copy[state.locale].requestFailed; }
});

function activityRow(item) {
  const row = document.createElement("div");
  row.className = "activity-row";
  const icon = document.createElement("span");
  icon.className = `activity-icon ${item.kind === "payee" ? "red" : item.kind === "purchase" ? "blue" : item.kind === "payment" ? "amber" : "green"}`;
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = item.kind === "payee" ? "!" : item.kind === "purchase" ? "↓" : item.kind === "payment" ? "₹" : item.kind === "return" ? "↩" : "✓";
  const description = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = item.title;
  const detail = document.createElement("small");
  // Issue #280 — a change to where customers pay carries its own sentence and no amount.
  detail.textContent = item.detail ? item.detail : item.kind === "purchase" ? copy[state.locale].purchaseActivity : item.kind === "payment" ? copy[state.locale][item.direction === "PAYMENT" ? "supplierPaymentActivity" : "paymentActivity"] : item.kind === "return" ? copy[state.locale].returnActivity : copy[state.locale].saleActivity;
  description.append(title, detail);
  const value = document.createElement("div");
  value.className = "activity-value";
  const amount = document.createElement("strong");
  amount.textContent = item.amount === null ? "" : money(item.amount);
  const status = document.createElement("span");
  status.className = "pill done";
  status.textContent = item.status === "Recorded" ? copy[state.locale].recorded : item.status;
  value.append(amount, status);
  row.append(icon, description, value);
  // Issue #132 — any bill already issued opens again, printed with the design it carried that day.
  if (item.kind === "sale") {
    const open = document.createElement("button");
    open.type = "button";
    open.className = "secondary-button";
    open.textContent = copy[state.locale].openBill;
    open.addEventListener("click", () => { openView("sale"); showSaleBill(item.id); });
    row.append(open);
  }
  return row;
}

const el = (tag, className = "", textContent = "") => Object.assign(document.createElement(tag), className ? { className } : {}, textContent ? { textContent } : {});
const initials = (name) => String(name).split(/\s+/).filter((word) => /\p{L}/u.test(word)).map((word) => word[0]).slice(0, 2).join("").toUpperCase();

/** Issue #310 — a figure on the money card; it opens its list when this person may see that list. */
function moneyFigure(figure, labelKey, big, note = "") {
  const box = el(figure.opens ? "button" : "div", `money-figure${big ? " money-main" : ""}`);
  if (figure.opens) {
    box.type = "button";
    box.addEventListener("click", () => openView(figure.opens.view, figure.opens.section ?? null));
  }
  box.append(el("small", "", copy[state.locale][labelKey]), el("strong", `amount${big ? " amount-big" : ""}`, money(figure.amount)));
  if (note) box.append(el("small", "", note));
  return box;
}

/** Issue #310 — a task's one button: a screen (on the bill, month or question it is about), or a request. */
async function runHomeTask(action, button) {
  if (action.post) {
    button.disabled = true;
    try {
      const result = await api(action.post.path, { method: "POST", body: JSON.stringify(action.post.body) });
      await refreshDocumentLists();
      // A retry that still got no number says so, not a green tick.
      if (result.title) showDialog({ title: result.title, message: result.message ?? "" }, result.status === "FAILED" ? "failed" : "recorded");
    } catch (error) {
      showDialog({ title: copy[state.locale].nothingSaved, message: error.message }, "failed");
    } finally { button.disabled = false; }
    return;
  }
  const open = action.open;
  if (open.turnover) { openTurnoverQuestion(); return; }
  if (open.view === "eway" && open.bill) { openEwayForBill(open.bill); return; }
  if (open.view === "gst-returns" && open.period) document.querySelector("#gst-period").value = open.period;
  openView(open.view, open.section ?? null);
  if (open.view === "einvoice" && open.bill) openEInvoice(open.bill);
}

const PAID_BY = { CASH: "payCash", UPI: "payUpi", CARD: "payCard", BANK_TRANSFER: "payBank", CHEQUE: "payCheque" };

function homeBillRow(bill) {
  const words = copy[state.locale];
  const row = el("button", "bill-row");
  row.type = "button";
  row.addEventListener("click", () => { openView("sale"); showSaleBill(bill.id); });
  const how = bill.paidBy === null ? words.payUdhaar : bill.paidBy.split(" + ").map((mode) => words[PAID_BY[mode]] ?? mode).join(" + ");
  const who = el("span", "bill-who");
  who.append(el("strong", "", bill.customer), el("small", "", `${bill.number} · ${how}`));
  const chip = bill.status === "PAID" ? el("span", "chip paid", words.homeChipPaid)
    : bill.status === "LATE" ? el("span", "chip late", text(bill.daysLate === 1 ? "homeChipLateOne" : "homeChipLate", { amount: money(bill.due), days: bill.daysLate }))
      : el("span", "chip due", text("homeChipDue", { amount: money(bill.due) }));
  const value = el("span", "bill-value");
  value.append(el("strong", "amount", money(bill.amount)), chip);
  const avatar = el("span", "bill-avatar", initials(bill.customer));
  avatar.setAttribute("aria-hidden", "true");
  row.append(avatar, who, value);
  return row;
}

function renderDashboard(data) {
  state.dashboard = data;
  adoptServerToday(data.today);
  const words = copy[state.locale];
  document.querySelector("#company-name").textContent = data.company.name;
  document.querySelector("#company-location").textContent = data.company.location;
  document.querySelector("#company-avatar").textContent = initials(data.company.name);
  document.querySelector("#dashboard-title").textContent = text("homeGreeting", { company: data.company.name });

  // The money card. Issue #273 — sales are net of goods returned, with the subtraction written under.
  const home = data.home;
  const returned = data.metrics.salesTodayReturned ?? 0;
  document.querySelector("#home-money-main").replaceChildren(moneyFigure(home.money.salesToday, "homeSalesToday", true,
    returned > 0 ? text("salesLessReturns", { billed: money(data.metrics.salesTodayBilled), returned: money(returned) }) : ""));
  document.querySelector("#home-money-row").replaceChildren(
    moneyFigure(home.money.cashInDrawer, "homeCash"), moneyFigure(home.money.bankInToday, "homeBank"),
    moneyFigure(home.money.toCollect, "homeToCollect"), moneyFigure(home.money.toPay, "homeToPay"));

  // Only what needs the owner, most urgent first; nothing to do is one green line.
  document.querySelector("#home-tasks").replaceChildren(...home.tasks.map((task) => {
    const item = el("li", "task");
    const dot = el("span", `task-dot ${task.rank <= 30 ? "late" : "due"}`);
    dot.setAttribute("aria-hidden", "true");
    item.append(dot, el("span", "task-text", t(task.title)));
    if (task.action) {
      const button = el("button", "secondary-button", t(task.action.label));
      button.type = "button";
      button.addEventListener("click", () => runHomeTask(task.action, button));
      item.append(button);
    }
    return item;
  }));
  document.querySelector("#home-all-clear").hidden = home.tasks.length > 0;

  const bills = document.querySelector("#home-bills");
  bills.replaceChildren(...home.recentBills.map((bill) => { const item = el("li"); item.append(homeBillRow(bill)); return item; }));
  if (home.recentBills.length === 0) bills.append(el("li", "loading-copy", words.homeNoBills));

  const all = document.querySelector("#all-activity");
  all.replaceChildren(...(data.activity.length === 0 ? [el("p", "loading-copy", words.noActivity)] : data.activity.map(activityRow)));

  // Issue #230 — the payment screens list the chosen customer's or supplier's own bills, read afresh.
  document.querySelectorAll('form[data-endpoint="payments"]').forEach((form) => loadPaymentBills(form));
  // Issue #303 — the design page's money card shows these same figures.
  if (state.view === "design" && !document.querySelector("#design-content").hidden) renderDesign();
  if (state.view === "items") renderItems();
}

// ------------------------------------------------ issue #304: the Items tab
//
// Every item, what it is counted in, its GST, and what is left in the godown (from Home's stock
// figures). "Change" opens #308's item editor (HSN code, barcode, usual price, other name).

async function renderItems() {
  if (!catalogueLoaded) await loadCatalogue();
  const words = copy[state.locale];
  const stock = new Map((state.dashboard?.stockItems ?? []).map((row) => [row.itemId, row]));
  const list = document.querySelector("#items-list");
  list.replaceChildren(...catalogue.items.map((item) => {
    const row = el("li", "item-row");
    const about = el("span", "item-about");
    about.append(el("strong", "", item.name), el("small", "", text("itemsLine", { code: item.hsnSac, rate: item.taxKind === "taxable" ? `${item.ratePercent}%` : words.itemsExempt })));
    const left = stock.get(item.id);
    const status = item.kind !== "goods" ? el("span", "chip", words.itemsService)
      : left && left.quantity <= 0 ? el("span", "chip late", words.itemsNoneLeft)
        : el("span", "item-left", text("itemsLeft", { quantity: left?.quantity ?? 0, unit: left?.unit || item.unit }));
    const change = el("button", "secondary-button", words.itemsEdit);
    change.type = "button";
    change.setAttribute("aria-label", `${words.itemsEdit}: ${item.name}`);
    change.addEventListener("click", () => openItemEditor(item.id));
    row.append(about, status, change);
    return row;
  }));
  if (catalogue.items.length === 0) list.append(el("li", "loading-copy", words.itemsNone));
}

document.querySelector("#items-add")?.addEventListener("click", () => {
  pickerAwaitingNewRecord = null;
  document.querySelector("#item-other-rate").hidden = document.querySelector("#item-tax")?.value !== "other";
  document.querySelector("#item-dialog").showModal();
});
// An item added or changed from here is on the list as soon as its box closes.
for (const id of ["#item-dialog", "#item-edit-dialog"]) document.querySelector(id)?.addEventListener("close", () => { if (state.view === "items") renderItems(); });

/**
 * Issue #237 — after anything is recorded, issued or cancelled, every list that can show that
 * document is read again, so a bill made a minute ago is already in the e-invoice, e-way bill,
 * challan, returns, payment and reminder lists without reloading the page. Each list is its own
 * read; one failing does not stop the others.
 */
async function refreshDocumentLists() {
  // Issue #358 — one list failing leaves the others, and says why in the console instead of nothing.
  const quietly = (load) => Promise.resolve().then(load).catch((error) => console.error(`${load.name} could not refresh its list.`, error));
  await Promise.all([
    quietly(loadDashboard),
    quietly(loadIssuedInvoices),
    quietly(loadEwayRoad),
    quietly(loadChallans),
    quietly(loadReturnDocuments),
    quietly(loadReturnNotes),
    quietly(loadReminders),
    // Issue #308 — the most-sold chips and last prices count the bill just made.
    quietly(loadSelling),
    quietly(loadSalesWaiting),
  ]);
}

/** Issue #301 — sales held for approval; someone who may approve gives a reason and issues it here. */
async function loadSalesWaiting() {
  const panel = document.querySelector("#sale-waiting");
  if (!panel) return;
  const { bills } = await apiList("/api/sales/waiting", "bills");
  panel.hidden = bills.length === 0;
  panel.querySelector("#sale-waiting-list").replaceChildren(...bills.map((bill) => {
    const item = document.createElement("li");
    const what = document.createElement("p");
    what.textContent = `${bill.customer} · ${money(bill.amount)} · ${bill.why.map(t).join(" ")}`;
    item.append(what);
    if (bill.madeByYou) {
      const note = document.createElement("p");
      note.textContent = text("approvalMadeByYou");
      item.append(note);
    } else if (bill.canApprove) {
      const reason = document.createElement("input");
      reason.type = "text";
      reason.maxLength = 300;
      reason.setAttribute("aria-label", text("approvalReasonLabel"));
      reason.placeholder = text("approvalReasonLabel");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary-button";
      button.textContent = text("approveBill");
      button.addEventListener("click", async () => {
        if (reason.value.trim() === "") { reason.placeholder = text("approvalReasonNeeded"); reason.focus(); return; }
        button.disabled = true;
        try {
          const result = await api("/api/sales/approve", { method: "POST", body: JSON.stringify({ token: bill.token, reason: reason.value.trim() }) });
          await openDoneScreen(result);
          await showSaleBill(result.invoice.id);
          await refreshDocumentLists();
        } catch (error) {
          button.disabled = false;
          showDialog({ title: copy[state.locale].nothingSaved, message: localizedError(error) }, "failed");
        }
      });
      item.append(reason, button);
    }
    return item;
  }));
}

async function loadDashboard() {
  const banner = document.querySelector("#connection-banner");
  try {
    renderDashboard(await api("/api/dashboard"));
    // Issue #312 — nothing to say while the shop answers: the banner is only for a failure.
    banner.hidden = true;
  } catch (error) {
    banner.hidden = false;
    banner.classList.add("failed");
    banner.querySelector("strong").textContent = error.status === 401 ? copy[state.locale].signInRequired : copy[state.locale].nothingSaved;
    banner.querySelector("span span").textContent = ` ${error.status === 401 ? copy[state.locale].signInAgain : copy[state.locale].requestFailed}`;
  }
}

function reportCard(title, sentence) {
  const card = document.createElement("article");
  card.className = "panel report-card";
  const heading = document.createElement("div");
  heading.className = "panel-heading";
  const headingText = document.createElement("div");
  const h2 = document.createElement("h2");
  h2.textContent = title;
  headingText.append(h2);
  if (sentence) {
    const p = document.createElement("p");
    p.textContent = sentence;
    headingText.append(p);
  }
  heading.append(headingText);
  card.append(heading);
  return card;
}

/** A sentence under a register, for a fact the table cannot say on its own. */
function reportNote(text) {
  const note = document.createElement("p");
  note.className = "safety-note";
  const icon = document.createElement("span");
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "i";
  const body = document.createElement("span");
  body.textContent = text;
  note.append(icon, body);
  return note;
}

function reportTable(columns, rows) {
  const wrap = document.createElement("div");
  wrap.className = "report-scroll";
  const table = document.createElement("table");
  table.className = "report-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  columns.forEach((column) => { const th = document.createElement("th"); th.textContent = column.label; if (column.numeric) th.className = "numeric"; headRow.append(th); });
  thead.append(headRow);
  const tbody = document.createElement("tbody");
  rows.forEach((cells) => {
    const tr = document.createElement("tr");
    cells.forEach((cell, index) => { const td = document.createElement("td"); td.textContent = cell; if (columns[index]?.numeric) td.className = "numeric"; tr.append(td); });
    tbody.append(tr);
  });
  table.append(thead, tbody);
  wrap.append(table);
  return wrap;
}

function reportTotalRow(label, amount) {
  const row = document.createElement("div");
  row.className = "report-total";
  const name = document.createElement("span");
  name.textContent = label;
  const value = document.createElement("strong");
  value.textContent = money(amount);
  row.append(name, value);
  return row;
}

function drillDetails(label, total, rows) {
  const details = document.createElement("details");
  details.className = "report-drill";
  const summary = document.createElement("summary");
  const name = document.createElement("span");
  name.textContent = label;
  const value = document.createElement("strong");
  value.textContent = money(total);
  summary.append(name, value);
  details.append(summary);
  details.append(reportTable(
    [{ label: t(REPORT_TEXT.dateCol) }, { label: t(REPORT_TEXT.numberCol) }, { label: t(REPORT_TEXT.whatItWas) }, { label: t(REPORT_TEXT.amount), numeric: true }],
    rows.map((r) => [r.date, r.number ?? "", r.description, money(r.amount)]),
  ));
  return details;
}

function renderReports(data) {
  const content = document.querySelector("#reports-content");
  content.replaceChildren();

  // Things worth a second look come first: what a person must check before trusting the rest.
  const exceptions = reportCard(t(data.exceptions.title), t(data.exceptions.sentence));
  if (!data.exceptions.clean) {
    data.exceptions.items.forEach((item) => {
      const flag = document.createElement("div");
      flag.className = `report-flag ${item.severity === "BLOCKING" ? "blocking" : ""}`;
      const strong = document.createElement("strong");
      strong.textContent = item.amount === null ? t(item.what) : `${t(item.what)} (${money(item.amount)})`;
      const why = document.createElement("span");
      why.textContent = t(item.why);
      flag.append(strong, why);
      exceptions.append(flag);
    });
  }
  content.append(exceptions);

  // Profit and loss, with the income total openable into the bills behind it.
  const pnl = reportCard(t(data.profitAndLoss.title), t(data.profitAndLoss.sentence));
  pnl.append(reportTable(
    [{ label: t(REPORT_TEXT.account) }, { label: t(REPORT_TEXT.amount), numeric: true }],
    // Issue #273 — goods returned by customers are taken off sales (net sales), and goods sent back
    // to suppliers off purchases (net purchases), each subtraction written out on its own lines.
    [
      ...data.profitAndLoss.income.lines.map((l) => [t(l.label), money(l.amount)]),
      [t(REPORT_TEXT.everythingEarned), money(data.profitAndLoss.income.total)],
      ...data.profitAndLoss.expenses.lines.map((l) => [t(l.label), money(l.amount)]),
      [t(REPORT_TEXT.everythingSpent), money(data.profitAndLoss.expenses.total)],
    ],
  ));
  pnl.append(drillDetails(t(REPORT_TEXT.everythingEarned), data.profitAndLoss.income.total, data.profitAndLoss.income.drill));
  pnl.append(reportTotalRow(t(REPORT_TEXT.whatIsLeft), data.profitAndLoss.result));
  content.append(pnl);

  // Balance sheet with the balanced badge.
  const sheet = reportCard(t(data.balanceSheet.title), t(data.balanceSheet.sentence));
  const badge = document.createElement("span");
  badge.className = `pill ${data.balanceSheet.balanced ? "done" : "warn"}`;
  badge.textContent = data.balanceSheet.balanced ? t(REPORT_TEXT.ownsMatch) : t(REPORT_TEXT.doesNotBalance);
  sheet.append(badge);
  sheet.append(reportTotalRow(t(REPORT_TEXT.businessOwns), data.balanceSheet.totalAssets));
  sheet.append(reportTotalRow(t(REPORT_TEXT.claimsOnIt), data.balanceSheet.totalClaims));
  content.append(sheet);

  // Trial balance.
  const trial = reportCard(t(data.trialBalance.title), data.trialBalance.balanced ? t(REPORT_TEXT.twoSidesSame) : t(REPORT_TEXT.twoSidesDiffer));
  trial.id = "report-books"; // Issue #310 — Home's cash in drawer is the cash in hand line here.
  const trialBadge = document.createElement("span");
  trialBadge.className = `pill ${data.trialBalance.balanced ? "done" : "warn"}`;
  trialBadge.textContent = data.trialBalance.balanced ? t(REPORT_TEXT.balanced) : `Off by ${money(data.trialBalance.difference)}`;
  trial.append(trialBadge);
  trial.append(reportTable(
    [{ label: t(REPORT_TEXT.codeCol) }, { label: t(REPORT_TEXT.account) }, { label: t(REPORT_TEXT.balanceCol), numeric: true }, { label: t(REPORT_TEXT.sideCol) }],
    data.trialBalance.rows.map((r) => [r.code, r.name, money(r.closing), r.side === "DEBIT" ? t(REPORT_TEXT.ownedSpent) : t(REPORT_TEXT.owedEarned)]),
  ));
  content.append(trial);

  // Sales register.
  const sales = reportCard(t(data.sales.title), t(data.sales.sentence));
  sales.id = "report-sales"; // Issue #310 — Home's sales today opens here.
  if (data.sales.rows.length > 0) sales.append(reportTable(
    [{ label: t(REPORT_TEXT.dateCol) }, { label: t(REPORT_TEXT.numberCol) }, { label: t(REPORT_TEXT.customer) }, { label: t(REPORT_TEXT.goodsValue), numeric: true }, { label: t(REPORT_TEXT.gstCol), numeric: true }, { label: t(REPORT_TEXT.total), numeric: true }],
    data.sales.rows.map((r) => [r.date, r.number, r.party, money(r.taxable), money(r.tax), money(r.total)]),
  ));
  // Issue #116: the difference between the two figures is GST, and a person should not have to
  // work that out. It is named, and said in words, because it is the difference between what the
  // business earned and what it merely collected.
  if (data.sales.tax > 0) sales.append(reportNote(t(REPORT_TEXT.earnedNote)));
  content.append(sales);

  // Purchase register — real here, because purchases post bills.
  const purchases = reportCard(t(data.purchases.title), t(data.purchases.sentence));
  if (data.purchases.rows.length > 0) purchases.append(reportTable(
    [{ label: t(REPORT_TEXT.dateCol) }, { label: t(REPORT_TEXT.numberCol) }, { label: t(REPORT_TEXT.supplier) }, { label: t(REPORT_TEXT.goodsValue), numeric: true }, { label: t(REPORT_TEXT.gstCol), numeric: true }, { label: t(REPORT_TEXT.total), numeric: true }],
    data.purchases.rows.map((r) => [r.date, r.number, r.party, money(r.taxable), money(r.tax), money(r.total)]),
  ));
  content.append(purchases);

  // What is left in the godown.
  const stock = reportCard(t(data.stock.title), t(data.stock.sentence));
  stock.id = "report-stock"; // Issue #241 — the menu's "What is in the godown" opens here.
  if (data.stock.rows.length > 0) stock.append(reportTable(
    [{ label: t(REPORT_TEXT.itemCol) }, { label: t(REPORT_TEXT.godown) }, { label: t(REPORT_TEXT.leftCol) }, { label: t(REPORT_TEXT.canBeSold) }, { label: t(REPORT_TEXT.worth), numeric: true }],
    data.stock.rows.map((r) => [r.item, r.warehouse, `${r.closing} ${r.unit}`, `${r.available} ${r.unit}`, money(r.value)]),
  ));
  content.append(stock);

  // Who owes whom.
  const dues = reportCard(t(data.dues.receivables.title), t(data.dues.receivables.sentence));
  dues.id = "report-dues"; // Issue #304 — the Khata tab, and Home's to collect and to pay, open here.
  if (data.dues.receivables.rows.length > 0) dues.append(reportTable(
    [{ label: t(REPORT_TEXT.customer) }, { label: t(REPORT_TEXT.stillOwed), numeric: true }, { label: t(REPORT_TEXT.moneyNoBill), numeric: true }, { label: t(REPORT_TEXT.oldestLate), numeric: true }],
    data.dues.receivables.rows.map((r) => [r.party, money(r.outstanding), money(r.onAccount), String(r.oldestDaysOverdue)]),
  ));
  // Issue #234 — say which day lateness is counted to: today, or the end of the period if earlier.
  if (data.period?.lateCountedTo) dues.append(reportNote(t(REPORT_TEXT.lateCountedTo).replace("{date}", new Intl.DateTimeFormat(state.locale, { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" }).format(new Date(`${data.period.lateCountedTo}T12:00:00+05:30`)))));
  dues.append(reportTotalRow(t(REPORT_TEXT.oweSuppliers), data.dues.payables.total));
  dues.append(reportTotalRow(t(REPORT_TEXT.advancesToSuppliers), data.dues.payables.advancesPaid ?? 0));
  content.append(dues);

  // Issue #295 — the TDS customers kept back, by quarter, for matching with Form 26AS.
  const tds = reportCard(t(data.tds.title), t(data.tds.sentence));
  if (data.tds.rows.length > 0) tds.append(reportTable(
    [{ label: t(REPORT_TEXT.tdsQuarter) }, { label: t(REPORT_TEXT.customer) }, { label: t(REPORT_TEXT.billCol) }, { label: t(REPORT_TEXT.tdsSection) }, { label: t(REPORT_TEXT.dateCol) }, { label: t(REPORT_TEXT.amount), numeric: true }],
    data.tds.rows.map((r) => [r.quarter, r.customer, r.bill, r.section === null ? "—" : `s.${r.section}`, r.date, money(r.amount)]),
  ));
  content.append(tds);

  // GST collected and paid.
  const gst = reportCard(t(data.gst.title), t(data.gst.sentence));
  gst.append(reportTotalRow(t(REPORT_TEXT.gstCollected), data.gst.collected));
  gst.append(reportTotalRow(t(REPORT_TEXT.gstPaid), data.gst.alreadyPaid));
  const caution = document.createElement("p");
  caution.className = "report-caution";
  caution.textContent = t(data.gst.caution);
  gst.append(caution);
  content.append(gst);
}

async function loadReports() {
  const content = document.querySelector("#reports-content");
  try {
    renderReports(await api("/api/reports"));
  } catch (error) {
    content.replaceChildren();
    const message = document.createElement("p");
    message.className = "loading-copy";
    message.textContent = `The reports could not be reached: ${error.message}`;
    content.append(message);
  }
}

/** Issue #237 — every current state, the same list Business details offers, read from the server. */
async function loadSetupStates() {
  const select = document.querySelector("#setup-states");
  if (!select) return;
  try {
    const { states } = await api("/api/states");
    const chosen = select.value;
    const blank = document.createElement("option");
    blank.value = "";
    blank.dataset.i18n = "setupChoose";
    blank.textContent = copy[state.locale].setupChoose;
    select.replaceChildren(blank, ...states.map((entry) => {
      const option = document.createElement("option");
      option.value = entry.code;
      option.textContent = `${entry.name} (${entry.code})`;
      return option;
    }));
    if ([...select.options].some((option) => option.value === chosen)) select.value = chosen;
  } catch { /* the form still says which state is missing when it is checked */ }
}

function setupData() {
  const form = document.querySelector("#setup-form");
  return Object.fromEntries([...new FormData(form).entries()].filter(([, value]) => typeof value === "string"));
}

function renderSetupProblems(problems) {
  const box = document.querySelector("#setup-result");
  box.replaceChildren();
  const card = reportCard(t(REPORT_TEXT.needsALook), t(REPORT_TEXT.nothingCreated));
  problems.forEach((problem) => {
    const flag = document.createElement("div");
    flag.className = "report-flag";
    const strong = document.createElement("strong");
    strong.textContent = problem.message;
    flag.append(strong);
    card.append(flag);
  });
  box.append(card);
  document.querySelector("#setup-create").hidden = true;
}

function renderSetupReady(summary) {
  const box = document.querySelector("#setup-result");
  box.replaceChildren();
  const card = reportCard(t(REPORT_TEXT.readyToCreate), t(REPORT_TEXT.checkOut));
  const rows = [
    [t(REPORT_TEXT.business), `${summary.businessName} · ${summary.businessType ?? ""}`],
    ["GST", summary.registration ?? ""],
    [t(REPORT_TEXT.booksFrom), summary.booksStartDate],
    [t(REPORT_TEXT.firstItem), summary.itemName],
  ];
  if (summary.declaredRate) rows.push([t(REPORT_TEXT.rateDeclared), summary.declaredRate]);
  if (summary.openingCash !== null) rows.push([t(REPORT_TEXT.cashDayOne), money(summary.openingCash)]);
  card.append(reportTable([{ label: "" }, { label: "" }], rows));
  box.append(card);
  document.querySelector("#setup-create").hidden = false;
}

function renderSetupResult(result) {
  const box = document.querySelector("#setup-result");
  box.replaceChildren();
  const card = reportCard(t(REPORT_TEXT.businessCreated), result.sentence);
  const badge = document.createElement("span");
  badge.className = `pill ${result.trialBalance.balanced ? "done" : "warn"}`;
  badge.textContent = result.trialBalance.balanced ? t(REPORT_TEXT.booksBalance) : t(REPORT_TEXT.booksDoNotBalance);
  card.append(badge);
  const facts = [
    [t(REPORT_TEXT.openingEntry), result.openingVoucherId ?? t(REPORT_TEXT.booksStartEmpty)],
    [t(REPORT_TEXT.ratesDeclaredLabel), String(result.ratesDeclared)],
  ];
  card.append(reportTable([{ label: "" }, { label: "" }], facts));
  if (result.trialBalance.rows.length > 0) {
    const heading = document.createElement("h3");
    heading.className = "setup-subheading";
    heading.textContent = t(REPORT_TEXT.openingBooks);
    card.append(heading);
    card.append(reportTable(
      [{ label: t(REPORT_TEXT.account) }, { label: t(REPORT_TEXT.ownedSpent), numeric: true }, { label: t(REPORT_TEXT.owedEarned), numeric: true }],
      result.trialBalance.rows.map((r) => [r.name, r.debit ? money(r.debit) : "", r.credit ? money(r.credit) : ""]),
    ));
    card.append(reportTotalRow(t(REPORT_TEXT.bothSides), result.trialBalance.totalDebits));
  }
  box.append(card);
  document.querySelector("#setup-create").hidden = true;
}

async function checkSetup() {
  const button = document.querySelector("#setup-check");
  button.disabled = true;
  const previous = button.textContent;
  button.textContent = t(REPORT_TEXT.checking);
  try {
    const result = await api("/api/onboarding/preview", { method: "POST", body: JSON.stringify(setupData()) });
    if (result.ok) renderSetupReady(result.summary); else renderSetupProblems(result.problems);
  } catch (error) {
    renderSetupProblems([{ message: error.message }]);
  } finally {
    button.disabled = false;
    button.textContent = previous;
  }
}

async function createSetup() {
  const button = document.querySelector("#setup-create");
  button.disabled = true;
  const previous = button.textContent;
  button.textContent = t(REPORT_TEXT.creating);
  try {
    const result = await api("/api/onboarding/finish", { method: "POST", body: JSON.stringify(setupData()) });
    if (result.ok && result.result) renderSetupResult(result.result); else renderSetupProblems(result.problems);
  } catch (error) {
    renderSetupProblems([{ message: error.message }]);
  } finally {
    button.disabled = false;
    button.textContent = previous;
  }
}

function localizedError(error) {
  if (state.locale === "en-IN") return error.message || copy[state.locale].requestFailed;
  // Issue #298 — the server's own Hindi sentence, when it sent one, beats any stand-in here.
  if (error.details?.[state.locale]) return error.details[state.locale];
  // Issue #266 — why a bill's date was refused names the dates, so the server's sentence is shown
  // rather than a general "could not complete".
  if (["SALE_DATE_AFTER_TODAY", "SALE_DATE_MONTH_CLOSED", "SALE_EINVOICE_TOO_LATE"].includes(error.code) && error.message) return error.message;
  // Issue #262 — a sale stopped for short stock says why, and what to do, in the reader's language.
  if (error.code === "SALES_STOCK_NOT_ENOUGH") return error.details?.[state.locale] || error.message;
  const key = {
    API_AMOUNT_INVALID: "amountInvalid",
    API_REFERENCE_REQUIRED: "referenceRequired",
    API_RATE_REQUIRED: "rateRequired",
    PERMISSION_DENIED: "permissionDenied",
    WALK_IN_NAME_REQUIRED: "walkInNameRequired",
    WALK_IN_DELIVERY: "walkInDelivery",
  }[error.code];
  return key ? copy[state.locale][key] : copy[state.locale].requestFailed;
}

function localizeResult(result, flow, mode) {
  // Issue #210 part 3 / #239 — the bill is already issued. Whether it has to carry a government
  // e-invoice number (or that we don't know yet) is said here in every language, rather than
  // leaving the person to go looking on another screen.
  if (flow === "sale" && mode !== "preview" && result.eInvoice?.message) {
    result = { ...result, effects: [result.eInvoice.message], askTurnover: result.eInvoice.askTurnover === true };
  }
  if (state.locale === "en-IN") return result;
  if (mode === "preview") {
    if (flow === "sale") return { ...result, title: copy[state.locale].saleChecked, message: text("saleCheckedBody", { amount: money(result.amount) }), effects: [copy[state.locale].saleEffectInvoice, copy[state.locale].saleEffectBalance] };
    // Issue #261 — the advance and its sum are kept, whatever the language, so the bill never hides it.
    if (flow === "purchase") return { ...result, title: copy[state.locale].purchaseChecked, message: text("purchaseCheckedBody", { amount: money(result.amount) }), effects: [copy[state.locale].purchaseEffectStock, copy[state.locale].purchaseEffectBooks, ...(result.advance?.effects ?? [])] };
    // Issue #230 — the server's own sentences name the customer or supplier and show the sums; a
    // generic line here would say "customer" about a supplier.
    return { ...result, title: copy[state.locale].paymentChecked };
  }
  // Issue #210 part 3 — the bill is already issued. If it also has to carry a government e-invoice
  // number, say so here rather than leaving the person to go looking on another screen.
  if (flow === "sale") return {
    ...result,
    title: copy[state.locale].saleRecorded,
    message: text("saleRecordedBody", { number: result.invoice?.number ?? "—" }),
  };
  if (flow === "purchase") return { ...result, title: copy[state.locale].purchaseRecorded, message: copy[state.locale].purchaseRecordedBody };
  return { ...result, title: copy[state.locale].paymentRecorded };
}

/**
 * Issue #312 — a sale review shows the bill's own figures, one green line for what the law needs
 * (it happens by itself), and at most one warning: the first thing below the owner has to act on.
 * Nothing informational is listed; the bill itself carries the place of supply, and the e-way bill
 * and e-invoice are offered again once it is issued. The server's decisions are shown, never redone.
 */
function saleReview(result, shown) {
  const terms = result.terms ?? {};
  const turnover = result.eInvoice?.askTurnover ? (state.locale === "en-IN" ? result.eInvoice.message : text("reviewTurnoverUnknown")) : null;
  // Worst first: each is something only the owner can settle before this bill goes out.
  const notes = [
    // Issue #266 — a bill dated before today says so, first, so it is never issued unnoticed.
    ...(result.dateNotice ? [result.dateNotice] : []),
    // Issue #235 / #11 — over this customer's credit limit, or a discount above what anyone may give.
    ...(terms.credit && terms.credit.outcome !== "ALLOW" ? [t(terms.credit.sentence)] : []),
    ...(terms.lines ?? []).flatMap((line) => [
      ...(line.discount?.outcome === "NEEDS_APPROVAL" ? [t(line.discount.sentence)] : []),
      ...(line.margin ? [t(line.margin.sentence)] : []),
    ]),
    // Issue #239 — the turnover question, asked on a sale only until it is answered once in Business details.
    ...(turnover ? [turnover] : []),
    ...(result.eInvoice?.lateForPortal ? [state.locale === "en-IN" ? result.eInvoice.message : text("reviewEinvoiceLate")] : []),
  ].filter(Boolean);
  const warning = notes[0] ?? null;
  // Issue #182 / #239 / #143 — what the law needs of this bill, when it all happens by itself.
  // Issue #288 — money taken at the counter goes in with the bill, so it is said on the green line.
  const paid = result.paidNow;
  const fine = [
    ...(paid ? [text(paid.due > 0 ? "saleEffectPartPaid" : "saleEffectPaid", { mode: copy[state.locale][{ CASH: "paidCash", UPI: "paidUpi", CARD: "paidCard" }[paid.mode]], amount: money(paid.amount), due: money(paid.due) })] : []),
    ...(result.exportSupply ? [result.exportSupply.endorsement] : []),
    // Issue #311 — one line per check, said as what will happen by itself.
    ...(result.ewayBill?.outcome === "REQUIRED" ? [text("checkEwayNeeded")] : result.ewayNotNeeded ? [text("checkEwayNotNeeded")] : []),
    ...(result.eInvoice?.needed === "YES" && !result.eInvoice.lateForPortal ? [text("checkEinvoiceAuto")] : []),
    ...(result.eInvoice?.needed === "NO" ? [text("checkEinvoiceNotNeeded")] : []),
  ];
  return {
    ...shown,
    // Issue #205 — the calculator's own charge lines, formatted here, never worked out here.
    effects: (result.chargeLines || []).map((line) => text("chargeReview", {
      charge: copy[state.locale][line.kind === "FREIGHT" ? "freight" : "otherCharges"],
      amount: money(line.taxableValue),
      gst: money(line.gst),
    })),
    fine: fine.length > 0 ? fine.join(" · ") : null,
    warning,
    // The button to Business details goes with the turnover line, and only when that is the line shown.
    askTurnover: turnover !== null && warning === turnover,
  };
}

function localizeReturnResult(result, mode, kind) {
  if (state.locale === "en-IN") return result;
  // Issue #293 — a price correction: a credit or debit note, and nothing into or out of stock.
  if (mode === "preview" && result.noteKind) return {
    ...result,
    title: copy[state.locale][result.noteKind === "SALES_DEBIT_NOTE" ? "priceHigherChecked" : "priceLowerChecked"],
    message: text("returnCheckedBody", { amount: money(result.amount) }),
    effects: [
      copy[state.locale][result.noteKind === "SALES_DEBIT_NOTE" ? "priceDebitEffect" : "returnCustomerEffect"],
      copy[state.locale].returnNoStockEffect,
      copy[state.locale][result.effects?.[2]?.startsWith("This bill has a government") ? "returnComplianceEffect" : "returnNoComplianceEffect"],
      ...(result.warnings ?? []),
    ],
  };
  if (mode === "recorded" && result.note?.priceCorrection) {
    return { ...result, title: copy[state.locale].priceCorrectionRecorded, message: text("returnRecordedBody", { number: result.note?.number ?? "—" }) };
  }
  if (mode === "preview") return {
    ...result,
    title: copy[state.locale][kind === "SALES_RETURN" ? "customerReturnChecked" : "supplierReturnChecked"],
    message: text("returnCheckedBody", { amount: money(result.amount) }),
    effects: [
      copy[state.locale][kind === "SALES_RETURN" ? "returnCustomerEffect" : "returnSupplierEffect"],
      result.stockMoves === false ? copy[state.locale].returnNoStockEffect : copy[state.locale][kind === "SALES_RETURN" ? "returnSalesStockEffect" : "returnPurchaseStockEffect"],
      copy[state.locale][result.effects?.[2]?.startsWith("This bill has a government") ? "returnComplianceEffect" : "returnNoComplianceEffect"],
      ...(result.warnings ?? []),
    ],
  };
  return { ...result, title: copy[state.locale][result.deduplicated ? "returnAlreadyRecorded" : "returnRecorded"], message: text("returnRecordedBody", { number: result.note?.number ?? "—" }) };
}

function showDialog(result, mode) {
  const dialog = document.querySelector("#review-dialog");
  document.querySelector("#review-title").textContent = result.title;
  document.querySelector("#review-body").textContent = result.message;
  document.querySelector("#review-icon").textContent = mode === "failed" ? "!" : mode === "recorded" ? "✓" : "→";
  document.querySelector("#review-effects").replaceChildren(...(result.effects || []).map((effect) => {
    const item = document.createElement("li");
    item.textContent = effect;
    return item;
  }));
  // Issue #312 — a sale review's green line and its one warning; every other dialog has neither.
  for (const [id, line] of [["#review-ok", result.fine], ["#review-warning", result.warning]]) {
    const box = document.querySelector(id);
    box.hidden = !(mode === "preview" && line);
    box.querySelector("[data-line-text]").textContent = line ?? "";
  }
  const cancel = document.querySelector("#review-cancel");
  const confirm = document.querySelector("#review-confirm");
  cancel.textContent = mode === "preview" ? copy[state.locale].keepEditing : copy[state.locale].close;
  cancel.disabled = mode === "loading";
  confirm.hidden = mode !== "preview";
  // Issue #261 — a supplier's advance, offered against their bill: ticked, visible, and one click to leave it.
  const advance = document.querySelector("#review-advance");
  const offered = mode === "preview" && result.advance && state.pendingForm?.dataset.draft === "purchase";
  advance.hidden = !offered;
  if (offered) {
    document.querySelector("#review-advance-use").checked = result.advance.use === true;
    document.querySelector("#review-advance-label").textContent = text("useAdvanceOnBill", { amount: money(Math.min(result.advance.available, result.amount)), supplier: result.supplier });
  }
  // Issue #301 — a sale that needs approval: this person approves it with a reason, or it goes to someone who may.
  const approval = document.querySelector("#review-approval");
  const asked = mode === "preview" && state.pendingForm?.dataset.draft === "sale" && result.approval?.required === true;
  approval.hidden = !asked;
  if (asked) {
    document.querySelector("#review-approval-text").textContent = result.approval.canApprove ? text("approvalYours") : text("approvalSomeoneElse", { who: result.approval.who });
    document.querySelector("#review-approval-field").hidden = !result.approval.canApprove;
    document.querySelector("#review-approval-reason").value = "";
  }
  if (mode === "preview") confirm.textContent = asked && !result.approval.canApprove ? copy[state.locale].sendForApproval : copy[state.locale].recordOnce;
  // Issue #239 — when the app cannot yet tell whether e-invoices apply, one button to the question.
  document.querySelector("#review-turnover").hidden = !(result.askTurnover === true && mode !== "loading");
  const download = document.querySelector("#review-download");
  download.hidden = mode !== "recorded" || !result.invoice?.id;
  download.textContent = copy[state.locale].downloadPdf;
  download.dataset.invoice = result.invoice?.id || "";
  download.dataset.number = result.invoice?.number || "invoice";
  // Issue #240 — goods that need an e-way bill get it in one press, filled in from this bill.
  const eway = document.querySelector("#review-eway");
  eway.hidden = !(mode === "recorded" && result.ewayBill?.outcome === "REQUIRED" && result.invoice?.id);
  eway.textContent = copy[state.locale].ewayFromBill;
  eway.dataset.invoice = result.invoice?.id || "";
  // Issue #262 — a sale stopped for short stock offers the one way through: the purchase bill.
  const purchase = document.querySelector("#review-purchase");
  purchase.hidden = !(mode === "failed" && Array.isArray(result.shortStock) && result.shortStock.length > 0);
  purchase.textContent = copy[state.locale].enterPurchaseBill;
  // The goods the refusal on screen is about, for the button.
  state.saleShortStock = purchase.hidden ? null : result.shortStock;
  document.querySelector("#review-add-customer").hidden = !(mode === "failed" && result.addCustomer === true);
  const dateToday = document.querySelector("#review-date-today");
  dateToday.hidden = !(mode === "failed" && typeof result.dateToday === "string");
  dateToday.dataset.today = result.dateToday ?? "";
  // Issue #274 — a purchase bill that took an advance: its voucher, now showing the bill it was adjusted against.
  const advanceVoucher = document.querySelector("#review-advance-voucher");
  const adjusted = mode === "recorded" && Array.isArray(result.advanceAdjustments) ? result.advanceAdjustments : [];
  advanceVoucher.hidden = adjusted.length === 0;
  advanceVoucher.textContent = copy[state.locale].printAdvanceVoucher;
  advanceVoucher.dataset.payment = adjusted[0]?.paymentId || "";
  // …and once that purchase is recorded, the way back to the sale.
  const back = document.querySelector("#review-back-to-sale");
  back.hidden = !(mode === "recorded" && result.backToSale === true);
  back.textContent = copy[state.locale].backToSale;
  confirm.disabled = false;
  confirm.textContent = copy[state.locale].recordOnce;
  dialog.dataset.mode = mode;
  dialog.setAttribute("aria-busy", String(mode === "loading"));
  if (!dialog.open) dialog.showModal();
}

document.querySelector("#review-advance-voucher").addEventListener("click", async (event) => {
  const paymentId = event.currentTarget.dataset.payment;
  document.querySelector("#review-dialog").close();
  if (!paymentId) return;
  openView("paid");
  const panel = document.querySelector("#view-paid [data-voucher-panel]");
  try {
    const printed = await api("/api/payments/voucher", { method: "POST", body: JSON.stringify({ paymentId }) });
    panel.hidden = false;
    panel.querySelector("[data-voucher-title]").textContent = text("paymentVoucherTitle", { number: printed.number });
    panel.querySelector("[data-voucher-frame]").srcdoc = printed.html;
    panel.scrollIntoView({ block: "start" });
  } catch (error) {
    showDialog({ title: copy[state.locale].nothingSaved, message: localizedError(error) }, "failed");
  }
});

// Issue #288 — from the refusal straight to the new-customer form, as a customer with no GST number.
document.querySelector("#review-add-customer").addEventListener("click", () => {
  document.querySelector("#review-dialog").close();
  pickerAwaitingNewRecord = saleCustomerPicker();
  const registration = document.querySelector('#customer-form [name="registration"]');
  if (registration) registration.value = "unregistered";
  showCustomerRegistrationFields();
  document.querySelector("#customer-dialog")?.showModal();
});

document.querySelector("#review-date-today").addEventListener("click", (event) => {
  const today = event.currentTarget.dataset.today;
  const field = document.querySelector('[data-draft="sale"] input[name="date"]');
  document.querySelector("#review-dialog").close();
  if (!field || !today) return;
  field.value = today;
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.dispatchEvent(new Event("change", { bubbles: true }));
});

document.querySelector("#review-eway").addEventListener("click", (event) => {
  const invoiceId = event.currentTarget.dataset.invoice;
  document.querySelector("#review-dialog").close();
  if (invoiceId) openEwayForBill(invoiceId);
});

async function downloadBillPdf(invoiceId, number) {
  const response = await fetch(`/api/sales/${encodeURIComponent(invoiceId)}/pdf`, { credentials: "same-origin" });
  if (!response.ok) throw new Error((await response.json()).message || copy[state.locale].requestFailed);
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = `${number.replace(/[^a-zA-Z0-9._-]/g, "_")}.pdf`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

document.querySelector("#review-download").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await downloadBillPdf(button.dataset.invoice, button.dataset.number);
  } catch (error) {
    showDialog({ title: copy[state.locale].nothingSaved, message: localizedError(error) }, "failed");
  } finally { button.disabled = false; }
});

// ------------------------------------------------- issue #262: short stock → purchase bill → back
//
// A sale of goods the godown does not hold is always stopped (Samay, 28 Sep 2026): no override, no
// permission, and stock never goes below nothing. The only way through is to enter the purchase bill
// first. The refusal carries a button that opens Purchase with the short goods already chosen, and
// once that bill is recorded, a button back to the sale. The sale form is never cleared on the way:
// it is the same form, and its draft is kept on the device (#266), so nothing is typed twice.

const SALE_WAITING_KEY = "karobar.saleWaitingForStock";
/** The short goods of a stopped sale, from the refusal, or null when this was some other failure. */
function shortStockOf(error) {
  if (error?.code !== "SALES_STOCK_NOT_ENOUGH") return null;
  try {
    const lines = JSON.parse(error.details?.shortStock ?? "[]");
    return Array.isArray(lines) && lines.length > 0 ? lines : null;
  } catch { return null; }
}

/** The failure dialog for a sale; a short-stock refusal gets the purchase bill button. */
function showSaleFailure(error) {
  // Issue #288 — a walk-in cannot be billed ₹50,000 or more, or sent goods: one button to name them.
  const addCustomer = ["WALK_IN_NAME_REQUIRED", "WALK_IN_DELIVERY"].includes(error?.code);
  // Issue #284 — a bill too old for the e-invoice portal: one button to date it today.
  const dateToday = error?.code === "SALE_EINVOICE_TOO_LATE" ? (error.details?.today || dateInput()) : undefined;
  showDialog({ title: copy[state.locale].nothingSaved, message: localizedError(error), shortStock: shortStockOf(error) ?? undefined, addCustomer, dateToday }, "failed");
}

function saleWaitingForStock() {
  try {
    const saved = JSON.parse(storage?.getItem(SALE_WAITING_KEY) || "null");
    return Array.isArray(saved) && saved.length > 0 ? saved : null;
  } catch { return null; }
}

/** The line above the purchase form saying which sale it is for, where the goods go, and the way back. */
function showPurchaseForSaleNote(done = false) {
  const note = document.querySelector("#purchase-for-sale-note");
  if (!note) return;
  const waiting = saleWaitingForStock();
  note.hidden = waiting === null;
  if (waiting === null) return;
  note.querySelector("[data-note-text]").textContent = done
    ? copy[state.locale].purchaseForSaleDone
    : waiting.map((line) => text("purchaseForSale", { required: line.required, unit: line.unit, item: line.itemName, warehouse: line.warehouseName, available: line.available })).join(" ");
  note.querySelector("#purchase-back-to-sale").textContent = copy[state.locale].backToSale;
}

/** Opens Purchase with each short item already on a line of the supplier bill. */
function openPurchaseForSale(shortStock) {
  storage?.setItem(SALE_WAITING_KEY, JSON.stringify(shortStock));
  document.querySelector("#review-dialog").close();
  openView("purchase");
  const form = document.querySelector('[data-draft="purchase"]');
  const box = document.querySelector("#purchase-lines");
  if (form && box) {
    shortStock.forEach((short) => {
      const lines = [...box.querySelectorAll(".sale-line")];
      if (lines.some((line) => line.querySelector("[data-line-field=item]")?.value === short.itemId)) return;
      // An untouched line (no price typed yet) is used; a line already filled in is never changed.
      const untouched = lines.length === 1 && (lines[0].querySelector("[data-line-field=rate]")?.value ?? "") === "" ? lines[0] : null;
      const line = untouched ?? addPurchaseLine();
      const picker = line?.querySelector("[data-line-field=item]");
      // Only goods the item list still has; the line's item box then shows its name (#308).
      if (!picker || itemById(short.itemId) === null) return;
      picker.value = short.itemId;
      // How many came is printed on the supplier's bill; it is typed from there, never guessed.
      const quantity = line.querySelector("[data-line-field=quantity]");
      if (quantity) quantity.value = "";
      setLineGstFromItem(line);
      showLineUnit(line);
    });
    saveDraft(form);
  }
  showPurchaseForSaleNote();
  document.querySelector('#purchase-lines [data-line-field="quantity"]')?.focus?.();
}

/** The "purchase recorded" dialog, when the purchase was entered for a stopped sale. */
function purchaseForSaleRecorded(recorded) {
  return { ...recorded, effects: [...(recorded.effects || []), copy[state.locale].purchaseForSaleDone], backToSale: true };
}

/** Back to the sale as it was typed. It is reviewed again, against the stock as it is now. */
function backToSale() {
  storage?.removeItem(SALE_WAITING_KEY);
  showPurchaseForSaleNote();
  const dialog = document.querySelector("#review-dialog");
  if (dialog.open) dialog.close();
  openView("sale");
}

document.querySelector("#review-purchase").addEventListener("click", () => { if (state.saleShortStock) openPurchaseForSale(state.saleShortStock); });
document.querySelector("#review-back-to-sale").addEventListener("click", backToSale);
document.querySelector("#purchase-back-to-sale")?.addEventListener("click", backToSale);
showPurchaseForSaleNote();

function setFormBusy(form, busy) {
  form.setAttribute("aria-busy", String(busy));
  const submit = form.querySelector('button[type="submit"]');
  if (submit) {
    submit.disabled = busy;
    if (busy) submit.textContent = copy[state.locale].working;
    else submit.textContent = copy[state.locale][`review${form.dataset.draft[0].toUpperCase()}${form.dataset.draft.slice(1)}`];
  }
}

function updateCalculations() {
  const sale = document.querySelector('[data-draft="sale"]');
  // Every line on the bill, not only the first one.
  const subtotal = [...sale.querySelectorAll(".sale-line")].reduce((total, line) => {
    const quantity = Number(line.querySelector("[data-line-field=quantity]")?.value) || 0;
    const rate = Number(line.querySelector("[data-line-field=rate]")?.value) || 0;
    // Issue #293 — the line's discount comes off before GST; the server works out the tax on what is left.
    const discount = Number(line.querySelector("[data-line-field=discount]")?.value) || 0;
    const percent = Number(line.querySelector("[data-line-field=discountPercent]")?.value) || 0;
    return total + quantity * rate - discount - (quantity * rate * percent) / 100;
  }, 0);
  const billDiscount = Number(sale.querySelector('[name="billDiscount"]')?.value) || 0;
  sale.querySelector('[data-calculated="subtotal"]').textContent = money(subtotal - billDiscount);
  // Issue #306 — GST and the total come from the server's own calculator, asked again 250 ms after
  // the last change; until the first answer, and when nothing can be priced, they stay "—".
  renderEstimate();
  scheduleEstimate();
  const payment = Number(document.querySelector('[data-draft="payment"] [name="amount"]').value) || 0;
  document.querySelector("[data-payment-total]").textContent = money(payment);
  const paid = Number(document.querySelector('[data-draft="paid"] [name="amount"]')?.value) || 0;
  const paidTotal = document.querySelector("[data-paid-total]");
  if (paidTotal) paidTotal.textContent = money(paid);
}

// ------------------------------------------------- issue #306: the live GST and total
//
// The same input the Review button sends goes to /api/sales/estimate, which stores nothing and
// answers with the calculator's own figures, so the total on screen is the total the bill will
// carry. The browser formats those figures; it never works the tax out for itself.

const ESTIMATE_DELAY_MS = 250;
let estimateTimer = null;
let estimateAsked = 0;
let lastEstimate = null;
// Issue #305 — the sale's slides, once mounted, and the review shown on its Payment slide: the
// server's answer, the inputs it was for, and its one warning. Declared here because the live total
// above already draws the bill bar while the page is loading.
let saleSlides = null;
const saleReviewState = { result: null, forInput: "", warning: null, timer: null, queue: Promise.resolve() };

function scheduleEstimate() {
  clearTimeout(estimateTimer);
  estimateTimer = setTimeout(runEstimate, ESTIMATE_DELAY_MS);
}

async function runEstimate() {
  const form = saleForm();
  if (!form || !state.signedIn) return;
  const lines = saleLineValues();
  const asked = ++estimateAsked;
  if (lines.length === 0) { lastEstimate = null; renderEstimate(); return; }
  let answer = null;
  try {
    answer = await api("/api/sales/estimate", { method: "POST", body: JSON.stringify({ ...draftData(form), lines: JSON.stringify(lines) }) });
  } catch { answer = null; }
  // An answer to an older question is never shown over a newer one.
  if (asked !== estimateAsked) return;
  lastEstimate = answer;
  renderEstimate();
}

/** What an estimate refusal says, in the reader's language; the two everyday ones are hints. */
function estimateRefusalText(refusal) {
  if (refusal.code === "CUSTOMER_REQUIRED") return copy[state.locale].estimateChooseCustomer;
  if (refusal.code === "ITEM_REQUIRED" || refusal.code === "SALES_NO_LINES") return copy[state.locale].estimateChooseItem;
  // Issue #288 — a walk-in bill from ₹50,000 needs the buyer's name: said in the reader's language.
  if (refusal.code === "WALK_IN_NAME_REQUIRED" || refusal.code === "WALK_IN_DELIVERY") return copy[state.locale][refusal.code === "WALK_IN_DELIVERY" ? "walkInDelivery" : "walkInNameRequired"];
  return t(refusal);
}

function renderEstimate() {
  // Not saleForm(): this first runs from translate() while the page is still loading.
  const sale = document.querySelector('[data-draft="sale"]');
  if (!sale) return;
  const estimate = lastEstimate;
  const totals = estimate?.totals ?? null;
  sale.querySelector('[data-calculated="tax"]').textContent = totals ? money(totals.totalTax) : "—";
  sale.querySelector('[data-calculated="total"]').textContent = totals ? money(totals.total) : "—";
  const roundOff = document.querySelector("#sale-round-off");
  if (roundOff) {
    roundOff.hidden = !totals || totals.roundOff === 0;
    roundOff.querySelector('[data-calculated="roundOff"]').textContent = totals ? money(totals.roundOff) : "";
  }
  const charges = totals ? estimate.lines.filter((line) => line.kind === "CHARGE").reduce((sum, line) => sum + Math.round(line.taxableValue * 100), 0) : 0;
  if (totals) {
    const goods = estimate.lines.filter((line) => line.kind !== "CHARGE").reduce((sum, line) => sum + Math.round(line.taxableValue * 100), 0);
    sale.querySelector('[data-calculated="subtotal"]').textContent = money(goods / 100);
    // Each card's GST, as the calculator charged it (the lines are priced in the order they are sent).
    const priced = estimate.lines.filter((line) => line.kind !== "CHARGE");
    [...document.querySelectorAll("#sale-lines .sale-line")]
      .filter((line) => (line.querySelector("[data-line-field=item]")?.value ?? "") !== "")
      .forEach((line, index) => { if (priced[index]?.ratePercent != null) setLineFacts(line, priced[index].ratePercent); });
  }
  // Issue #305 — the Payment slide's bill summary: the same figures, and freight when there is any.
  const payTotal = sale.querySelector('[data-calculated="payTotal"]');
  if (payTotal) payTotal.textContent = totals ? money(totals.total) : "—";
  const chargesLine = document.querySelector("#sale-charges-line");
  if (chargesLine) {
    chargesLine.hidden = charges === 0;
    chargesLine.querySelector('[data-calculated="charges"]').textContent = money(charges / 100);
  }
  // Issue #305 / #311 — the Customer slide: where the sale counts, then one line per check.
  const checks = document.querySelector("#sale-customer-checks");
  if (checks) {
    checks.replaceChildren(...(estimate ? saleCheckLines(estimate) : []).map(([words, kind]) => {
      const row = document.createElement("li");
      row.className = kind;
      row.textContent = words;
      return row;
    }));
  }
  const notes = document.querySelector("#sale-estimate-notes");
  if (!notes) return;
  const rows = [];
  const note = (words, kind = "") => {
    const row = document.createElement("li");
    if (kind) row.className = kind;
    row.textContent = words;
    rows.push(row);
    return row;
  };
  // The Items slide lists only what would stop the bill; the checks are said on the next slides.
  (estimate?.refusals || []).forEach((refusal) => {
    const row = note(estimateRefusalText(refusal), "hold");
    // Issue #308 — an item held up by its code or rate is fixed in the item's own dialog.
    if (refusal.itemId && /^(HSN_|RATE_|ITEM_NOT_CLASSIFIED)/.test(refusal.code)) {
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "text-button";
      edit.textContent = copy[state.locale].editItemButton;
      edit.addEventListener("click", () => openItemEditor(refusal.itemId));
      row.append(" ", edit);
    }
  });
  notes.replaceChildren(...rows);
  updateSaleBar();
}

/**
 * Issue #305 / #311 — what the live total found, as the Customer slide says it: where the sale counts
 * (green), then one line per check. Only the server's decisions; nothing is decided here.
 */
function saleCheckLines(estimate) {
  const lines = [];
  if (estimate.placeOfSupply) lines.push([t(estimate.placeOfSupply), "line-ok"]);
  if (estimate.ewayBill) lines.push([text(estimate.ewayBill.needed ? "checkEwayNeeded" : "checkEwayNotNeeded"), "line-ok"]);
  const needed = estimate.eInvoice?.needed;
  if (needed === "YES") lines.push([text("checkEinvoiceAuto"), "line-ok"]);
  else if (needed === "NO") lines.push([text("checkEinvoiceNotNeeded"), "line-ok"]);
  // Not decided yet (the turnover question): said here, and asked once on the Payment slide.
  else if (estimate.eInvoice) lines.push([t(estimate.eInvoice), "line-warn"]);
  return lines;
}

// A date the business must choose for itself — how long a quoted price holds (#142) — is marked
// `data-no-default` and left empty: filling it with today would print a promise nobody made.
document.querySelectorAll("input[type=date]:not([data-no-default])").forEach((field) => { if (!field.value) field.value = dateInput(); });
// Issue #234 — a new business's books start, by default, on 1 April of the financial year today is in.
document.querySelectorAll('input[name="booksStartDate"]').forEach((field) => {
  if (field.value) return;
  const [year, month] = dateInput().split("-").map(Number);
  field.value = `${month >= 4 ? year : year - 1}-04-01`;
});
document.querySelectorAll(".draft-form").forEach((form) => {
  restoreDraft(form);
  form.addEventListener("input", () => { saveDraft(form); updateCalculations(); });
  form.addEventListener("change", () => saveDraft(form));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    // Issue #305 — a sale is reviewed on its Payment slide and made with Make bill, never submitted.
    if (form.dataset.draft === "sale") return;
    saveDraft(form);
    const input = draftData(form);
    // Issue #228 — and a supplier bill's lines, each with the GST rate printed on it.
    if (form.dataset.draft === "purchase") input.lines = JSON.stringify(purchaseLineValues());
    // Issue #230 — the bills ticked, and one entry number per payment so pressing Record twice records once.
    if (form.dataset.endpoint === "payments") {
      input.bills = JSON.stringify([...form.querySelectorAll("[data-bill]:checked")].map((box) => box.value));
      input.settlements = JSON.stringify(paymentSettlementValues(form));
      // Issue #261 — an advance only with its own tick, and only while the choice is on the screen.
      const choice = form.querySelector("[data-advance-choice]");
      if (choice) input.advance = !choice.hidden && form.querySelector("[data-advance]")?.checked ? "yes" : "no";
      form.dataset.requestId ||= newPaymentRequestId();
      input.requestId = form.dataset.requestId;
    }
    state.pendingForm = form;
    state.pendingInput = input;
    state.pendingReturnInput = null;
    setFormBusy(form, true);
    showDialog({ title: copy[state.locale].checking, message: copy[state.locale].checkingBody }, "loading");
    try {
      const result = await api(`/api/${form.dataset.endpoint ?? `${form.dataset.draft}s`}/preview`, { method: "POST", body: JSON.stringify(input) });
      const shown = localizeResult(result, form.dataset.draft, "preview");
      showDialog(form.dataset.draft === "sale" ? saleReview(result, shown) : shown, "preview");
    } catch (error) {
      if (form.dataset.draft === "purchase" && error?.code === "PURCHASE_REVERSE_CHARGE_QUESTION") {
        showReverseChargeQuestions(form, error);
        showDialog({ title: copy[state.locale].nothingSaved, message: copy[state.locale].rcmAnswerAbove }, "failed");
      } else showSaleFailure(error);
    } finally { setFormBusy(form, false); }
  });
  form.querySelector(".clear-draft").addEventListener("click", () => {
    if (form.dataset.draft === "purchase") clearReverseChargeQuestions(form);
    if (form.dataset.draft === "sale") { resetSaleForm(form); setDraftStatus(form, "draftCleared"); startNewSaleSlides(); return; }
    storage?.removeItem(`karobar.draft.${form.dataset.draft}`);
    hideDraftDateNote(form);
    forgetPendingDraft(form);
    form.reset();
    const date = form.querySelector('input[type="date"]:not([data-no-default])');
    if (date) date.value = dateInput();
    setDraftStatus(form, "draftCleared");
    updateCalculations();
    if (form.dataset.endpoint === "payments") { delete form.dataset.requestId; showChequeFields(form); loadPaymentBills(form); }
  });
});
showPaidBy();

// ------------------------------------------------- issue #289: reverse charge, asked on the form
//
// The server decides from the notified lists whether the buyer pays a line's GST. Where the law turns
// on a fact the item code cannot tell (did the transporter give a bilty? is the seller an advocate?),
// it sends the question back, and it is asked here as Yes or No. Each answer is a form field named
// `rcm_<question>`, so it goes with the next review and stays with the bill's draft.

function showReverseChargeQuestions(form, error) {
  let questions = [];
  try { questions = JSON.parse(error.details?.questions ?? "[]"); } catch { questions = []; }
  const box = form.querySelector("#purchase-rcm-questions");
  if (!box || questions.length === 0) return;
  const list = box.querySelector("[data-rcm-questions]");
  questions.forEach((ask) => {
    if (list.querySelector(`[name="rcm_${ask.id}"]`)) return;
    const row = document.createElement("div");
    row.className = "rcm-question";
    row.dataset.rcmQuestion = ask.id;
    const question = document.createElement("p");
    question.textContent = ask.question;
    const why = document.createElement("small");
    why.textContent = ask.why;
    const answers = document.createElement("div");
    answers.className = "rcm-answers";
    [["yes", "rcmYes"], ["no", "rcmNo"]].forEach(([value, key]) => {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "radio"; input.name = `rcm_${ask.id}`; input.value = value; input.required = true;
      label.append(input, document.createTextNode(copy[state.locale][key]));
      answers.append(label);
    });
    row.append(question, why, answers);
    list.append(row);
  });
  box.hidden = false;
  box.scrollIntoView?.({ block: "center" });
}

function clearReverseChargeQuestions(form) {
  const box = form.querySelector("#purchase-rcm-questions");
  if (!box) return;
  box.querySelector("[data-rcm-questions]").replaceChildren();
  box.hidden = true;
}

// ------------------------------------------------- issue #289, part 2b: self-invoices
//
// A purchase under reverse charge from a seller with no GST number needs the buyer's own invoice
// within 30 days of receiving it (CGST s.31(3)(f), Rule 47A). The server keeps the list and the
// 30-day count; this shows it, late ones first, with one button to make each and one to show it.

async function loadSelfInvoices() {
  const panel = document.querySelector("#self-invoice-panel");
  if (!panel) return;
  let list;
  try { list = await apiList("/api/purchases/self-invoices", "items"); } catch { panel.hidden = true; return; }
  const items = list?.items ?? [];
  panel.hidden = items.length === 0;
  const box = panel.querySelector("[data-self-invoices]");
  box.replaceChildren(...items.map((item) => {
    const row = document.createElement("li");
    row.className = `self-invoice-row state-${String(item.state).toLowerCase()}`;
    const what = document.createElement("p");
    const badge = document.createElement("strong");
    badge.textContent = copy[state.locale][`selfInvoiceState${item.state}`] ?? item.state;
    what.append(badge, document.createTextNode(` ${text("selfInvoiceLine", { supplier: item.supplier, bill: item.bill, date: longDate(item.receivedOn), tax: money(item.tax) })}`));
    const why = document.createElement("small");
    why.textContent = item.number ? `${item.number} · ${item.words}` : item.words;
    const button = document.createElement("button");
    button.type = "button";
    button.className = item.number ? "secondary-button" : "primary-button";
    button.textContent = copy[state.locale][item.number ? "printSelfInvoice" : "issueSelfInvoice"];
    button.addEventListener("click", () => showSelfInvoice(item.billId, !item.number, button));
    row.append(what, why, button);
    return row;
  }));
}

async function showSelfInvoice(billId, issue, button) {
  const panel = document.querySelector("#self-invoice-panel");
  button.disabled = true;
  try {
    const result = await api(issue ? "/api/purchases/self-invoice" : "/api/purchases/self-invoice/print", { method: "POST", body: JSON.stringify({ billId }) });
    const view = panel.querySelector("[data-self-invoice-view]");
    view.hidden = false;
    view.querySelector("[data-self-invoice-title]").textContent = text("selfInvoiceTitle", { number: result.number });
    view.querySelector("[data-self-invoice-frame]").srcdoc = result.html;
    if (issue) showDialog(result, "recorded");
    await loadSelfInvoices();
    view.scrollIntoView?.({ block: "start" });
  } catch (error) {
    showDialog({ title: copy[state.locale].nothingSaved, message: localizedError(error) }, "failed");
  } finally { button.disabled = false; }
}

document.querySelector("[data-self-invoice-print]")?.addEventListener("click", () => {
  document.querySelector("[data-self-invoice-frame]")?.contentWindow?.print();
});

// A different supplier is a different bill: answers given about the last one do not carry over.
document.querySelector('form[data-draft="purchase"] select[name="supplierId"]')?.addEventListener("change", (event) => clearReverseChargeQuestions(event.currentTarget.form));

// ------------------------------------------------- issue #230: money received and money paid
//
// The customer (money in) or supplier (money out) is picked from the same lists the Sale and
// Purchase screens use, and only that party's own open bills are offered, each with what is still
// due on it. Nothing is chosen for the person: the picker starts empty.

function newPaymentRequestId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function showChequeFields(form) {
  const cheque = form.querySelector("[data-payment-method]")?.value === "CHEQUE";
  form.querySelectorAll("[data-cheque-field]").forEach((field) => {
    field.hidden = !cheque;
    const input = field.querySelector("input");
    if (input) input.required = cheque;
  });
}

async function loadPaymentBills(form) {
  const box = form?.querySelector("[data-payment-bills]");
  if (!box) return;
  const partyId = form.querySelector("[data-payment-party]")?.value ?? "";
  const ticked = new Set([...box.querySelectorAll("[data-bill]:checked")].map((input) => input.value));
  const note = (key) => {
    const empty = document.createElement("p");
    empty.className = "bill-choice-empty";
    empty.textContent = copy[state.locale][key];
    box.replaceChildren(empty);
  };
  if (!partyId || !state.signedIn) { note("chooseAPartyFirst"); updateAdvanceChoice(form); return; }
  let read;
  try {
    read = await api("/api/payments/open-bills", { method: "POST", body: JSON.stringify({ direction: form.dataset.direction, partyId }) });
  } catch (error) {
    note("requestFailed");
    return;
  }
  // The party may have been changed while the list was on its way.
  if ((form.querySelector("[data-payment-party]")?.value ?? "") !== partyId) return;
  form.paymentRead = read;
  updateAdvanceChoice(form);
  if (read.bills.length === 0) { note("noOpenBills"); return; }
  box.replaceChildren(...read.bills.map((bill) => {
    const label = document.createElement("label");
    label.className = "bill-choice";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = bill.id;
    input.dataset.bill = "";
    input.dataset.due = String(bill.outstanding);
    input.checked = ticked.has(bill.id);
    const words = document.createElement("span");
    words.textContent = text("openBillLine", { number: bill.number, date: bill.date, total: money(bill.total), due: money(bill.outstanding) });
    label.append(input, words);
    // Issue #295 — on money received a bill can also be settled by TDS the customer kept, a
    // discount, or a small write-off. The fields sit under the bill; anything left blank is not sent.
    if (form.dataset.direction === "RECEIPT") label.append(paymentAdjustmentFields(bill, read));
    return label;
  }));
}

/** Issue #295 — the "settled another way" fields under one bill on Money received. */
function paymentAdjustmentFields(bill, read) {
  const box = document.createElement("details");
  box.className = "bill-adjust";
  box.dataset.billAdjust = bill.id;
  const head = document.createElement("summary");
  head.textContent = text("settleAnotherWay");
  const rows = document.createElement("div");
  rows.className = "field-grid";
  const field = (labelKey, input) => {
    const label = document.createElement("label");
    const span = document.createElement("span");
    span.textContent = copy[state.locale][labelKey];
    label.append(span, input);
    return label;
  };
  const amount = (name) => {
    const input = document.createElement("input");
    input.type = "number"; input.min = "0.01"; input.step = "0.01"; input.dataset[name] = "";
    return input;
  };
  const words = (name, value) => {
    const input = document.createElement("input");
    input.dataset[name] = ""; if (value) input.value = value;
    return input;
  };
  const sections = document.createElement("select");
  sections.dataset.tdsSection = "";
  sections.replaceChildren(...["", ...(read.tdsSections ?? [])].map((section) => {
    const option = document.createElement("option");
    option.value = section;
    option.textContent = section === "" ? copy[state.locale].tdsSectionChoose : `s.${section}`;
    return option;
  }));
  const agreed = document.createElement("input");
  agreed.type = "checkbox"; agreed.dataset.cnAgreed = "";
  const reversed = document.createElement("input");
  reversed.type = "checkbox"; reversed.dataset.cnItc = "";
  const creditNote = document.createElement("input");
  creditNote.type = "checkbox"; creditNote.dataset.discountCn = "";
  const evidence = document.createElement("div");
  evidence.className = "full-field";
  evidence.hidden = true;
  const agreedLabel = document.createElement("label");
  const agreedSpan = document.createElement("span"); agreedSpan.textContent = copy[state.locale].cnAgreed;
  agreedLabel.append(agreed, agreedSpan);
  const reversedLabel = document.createElement("label");
  const reversedSpan = document.createElement("span"); reversedSpan.textContent = copy[state.locale].cnItc;
  reversedLabel.append(reversed, reversedSpan);
  evidence.append(agreedLabel, reversedLabel);
  creditNote.addEventListener("change", () => { evidence.hidden = !creditNote.checked; });
  rows.append(
    field("tdsDeducted", amount("tdsAmount")), field("tdsSection", sections), field("tdsQuarter", words("tdsQuarter", read.tdsQuarter)), field("tdsCertificate", words("tdsCert")),
    field("discountAllowed", amount("discountAmount")),
  );
  const cnLabel = document.createElement("label");
  const cnSpan = document.createElement("span"); cnSpan.textContent = copy[state.locale].discountAsCreditNote;
  cnLabel.append(creditNote, cnSpan);
  rows.append(cnLabel, evidence);
  rows.append(field("writeOffSmall", amount("writeoffAmount")));
  const help = document.createElement("small");
  help.className = "full-field";
  help.textContent = text("writeOffLimitHelp", { limit: money(read.writeOffLimit ?? 0) });
  rows.append(help);
  box.append(head, rows);
  return box;
}

/** Issue #295 — reads the filled adjustment fields into the `settlements` the payment API reads. */
function paymentSettlementValues(form) {
  return [...form.querySelectorAll("[data-bill-adjust]")].map((box) => {
    const amount = (name) => box.querySelector(`[data-${name}]`)?.value?.trim() ?? "";
    const entry = { bill: box.dataset.billAdjust };
    if (amount("tdsAmount") !== "") {
      entry.tds = {
        amount: amount("tdsAmount"), section: box.querySelector("[data-tds-section]")?.value ?? "",
        quarter: amount("tdsQuarter"), certificate: amount("tdsCert"),
      };
    }
    if (amount("discountAmount") !== "") {
      entry.discount = {
        amount: amount("discountAmount"), creditNote: box.querySelector("[data-discount-cn]")?.checked === true,
        agreedBeforeSupply: box.querySelector("[data-cn-agreed]")?.checked === true,
        buyerReversedItc: box.querySelector("[data-cn-itc]")?.checked === true,
      };
    }
    if (amount("writeoffAmount") !== "") entry.writeOff = { amount: amount("writeoffAmount") };
    return entry;
  }).filter((entry) => entry.tds !== undefined || entry.discount !== undefined || entry.writeOff !== undefined);
}

/**
 * Issue #261 — the advance choice on Money paid. It appears when the supplier has no open bill, or
 * when more is being paid than the bills ticked still have due, and it is never ticked for the
 * person: an advance is recorded only after its own click.
 */
function updateAdvanceChoice(form) {
  const choice = form?.querySelector("[data-advance-choice]");
  if (!choice) return;
  const read = form.paymentRead;
  const partyId = form.querySelector("[data-payment-party]")?.value ?? "";
  if (!read || !partyId || read.party?.id !== partyId) { choice.hidden = true; choice.querySelector("[data-advance]").checked = false; showAdvanceFields(choice); return; }
  const amount = Number(form.querySelector('[name="amount"]')?.value) || 0;
  const ticked = [...form.querySelectorAll("[data-bill]:checked")].reduce((total, box) => total + (Number(box.dataset.due) || 0), 0);
  const show = read.bills.length === 0 || amount > ticked + 0.001;
  if (!show) choice.querySelector("[data-advance]").checked = false;
  choice.hidden = !show;
  const supplier = read.party.name;
  choice.querySelector("[data-advance-label]").textContent = text("advanceChoice", { supplier });
  const help = [text(read.bills.length === 0 ? "advanceHelpNoBill" : "advanceHelpMore", { supplier })];
  if (read.advancesPaid > 0) help.push(text("advanceAlready", { supplier, amount: money(read.advancesPaid) }));
  choice.querySelector("[data-advance-help]").textContent = help.join(" ");
  showAdvanceFields(choice);
}

/** Issue #274 — the advance's purchase order and receipt voucher, only while the advance is ticked. */
function showAdvanceFields(choice) {
  const fields = choice.querySelector("[data-advance-fields]");
  if (!fields) return;
  fields.hidden = choice.hidden || !choice.querySelector("[data-advance]").checked;
  if (fields.hidden) fields.querySelectorAll("input").forEach((field) => { field.value = ""; });
}

// Issue #261 — unticking (or ticking) the advance on a purchase review checks the bill again, so
// the sum on the screen is always the one that will be recorded.
document.querySelector("#review-advance-use")?.addEventListener("change", async (event) => {
  if (!state.pendingForm || !state.pendingInput || state.pendingForm.dataset.draft !== "purchase") return;
  state.pendingInput = { ...state.pendingInput, useAdvance: event.currentTarget.checked ? "yes" : "no" };
  try {
    const result = await api("/api/purchases/preview", { method: "POST", body: JSON.stringify(state.pendingInput) });
    showDialog(localizeResult(result, "purchase", "preview"), "preview");
  } catch (error) {
    showDialog({ title: copy[state.locale].nothingSaved, message: localizedError(error) }, "failed");
  }
});

async function paymentRecorded(form, result) {
  delete form.dataset.requestId;
  form.reset();
  form.querySelectorAll('input[type="date"]:not([data-no-default])').forEach((field) => { field.value = dateInput(); });
  showChequeFields(form);
  updateCalculations();
  await loadPaymentBills(form);
  const panel = form.closest(".view")?.querySelector("[data-voucher-panel]");
  if (!panel) return;
  try {
    const printed = await api("/api/payments/voucher", { method: "POST", body: JSON.stringify({ paymentId: result.paymentId }) });
    panel.hidden = false;
    panel.querySelector("[data-voucher-title]").textContent = text(result.direction === "PAYMENT" ? "paymentVoucherTitle" : "receiptTitle", { number: printed.number });
    panel.querySelector("[data-voucher-frame]").srcdoc = printed.html;
  } catch { panel.hidden = true; }
}

document.querySelectorAll('form[data-endpoint="payments"]').forEach((form) => {
  form.querySelector("[data-payment-party]")?.addEventListener("change", () => loadPaymentBills(form));
  form.addEventListener("input", () => updateAdvanceChoice(form));
  form.addEventListener("change", () => updateAdvanceChoice(form));
  form.querySelector("[data-payment-method]")?.addEventListener("change", () => showChequeFields(form));
  showChequeFields(form);
  form.closest(".view")?.querySelector("[data-voucher-print]")?.addEventListener("click", (event) => {
    event.currentTarget.closest("[data-voucher-panel]")?.querySelector("[data-voucher-frame]")?.contentWindow?.print();
  });
});

// ---------------------------------------------------------------- issue #37: bringing data across
//
// Every step here is a call into the real MigrationService: it reads the file, proposes which
// column is which, waits for the person to approve that, previews what would happen, and only then
// writes. What comes back after the commit is the new company's own trial balance and stock.

const migration = { workspaceId: null, batch: null, columns: [], fields: [], fingerprint: null };

async function startMigration() {
  if (migration.workspaceId !== null) return;
  try {
    const started = await api("/api/migration/start", { method: "POST", body: JSON.stringify({}) });
    migration.workspaceId = started.workspaceId;
    const box = document.querySelector("#migration-samples");
    box.replaceChildren();
    started.samples.forEach((sample) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ghost-button";
      button.textContent = sample.name;
      button.addEventListener("click", () => {
        document.querySelector("#migration-content").value = sample.content;
        document.querySelector("#migration-file-name").value = sample.fileName;
      });
      box.append(button);
    });
  } catch (error) {
    renderMigrationProblem(error.message);
  }
}

function migrationCard(parent, title, sentence) {
  const box = document.querySelector(parent);
  box.replaceChildren();
  const card = reportCard(title, sentence);
  box.append(card);
  return card;
}

function renderMigrationProblem(message) {
  const card = migrationCard("#migration-preview", t(REPORT_TEXT.needsALook), message);
  document.querySelector("#migration-result").replaceChildren();
  return card;
}

async function readMigrationFile() {
  const content = document.querySelector("#migration-content").value;
  if (content.trim() === "") return;
  const button = document.querySelector("#migration-read");
  button.disabled = true;
  try {
    const analysis = await api("/api/migration/analyse", {
      method: "POST",
      body: JSON.stringify({
        workspaceId: migration.workspaceId,
        fileName: document.querySelector("#migration-file-name").value || "export.csv",
        content,
      }),
    });
    migration.workspaceId = analysis.workspaceId;
    migration.batch = analysis;
    migration.columns = analysis.columns;
    migration.fields = analysis.fields;
    migration.fingerprint = analysis.fingerprint;
    document.querySelector("#migration-preview").replaceChildren();
    document.querySelector("#migration-result").replaceChildren();
    renderMigrationMapping(analysis);
  } catch (error) {
    document.querySelector("#migration-mapping").replaceChildren();
    renderMigrationProblem(error.message);
  } finally {
    button.disabled = false;
  }
}

function renderMigrationMapping(analysis) {
  const card = migrationCard(
    "#migration-mapping",
    t(REPORT_TEXT.whatThisFileIs),
    `${analysis.entity.replace("_", " ")} · ${analysis.rowsInFile} ${t(REPORT_TEXT.rowsReady).toLowerCase()} · ${analysis.sourceSystem}`,
  );

  if (analysis.state === "REJECTED_DUPLICATE") {
    const flag = document.createElement("div");
    flag.className = "report-flag";
    const strong = document.createElement("strong");
    strong.textContent = t(REPORT_TEXT.sameFileAgain);
    flag.append(strong);
    card.append(flag);
    return;
  }

  const table = document.createElement("div");
  table.className = "report-scroll";
  const grid = document.createElement("table");
  grid.className = "report-table";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  [t(REPORT_TEXT.columnHeader), t(REPORT_TEXT.weReadItAs)].forEach((label) => {
    const th = document.createElement("th");
    th.textContent = label;
    headRow.append(th);
  });
  head.append(headRow);
  const body = document.createElement("tbody");

  analysis.columns.forEach((column) => {
    const row = document.createElement("tr");
    const name = document.createElement("td");
    name.textContent = column.header;
    const choice = document.createElement("td");
    const select = document.createElement("select");
    const none = document.createElement("option");
    none.value = "";
    none.textContent = t(REPORT_TEXT.notUsed);
    select.append(none);
    migration.fields.forEach((field) => {
      const option = document.createElement("option");
      option.value = field.id;
      option.textContent = field.required ? `${field.label} *` : field.label;
      if (field.id === column.field) option.selected = true;
      select.append(option);
    });
    select.addEventListener("change", () => remapMigrationColumns());
    select.dataset.column = String(column.index);
    choice.append(select);
    if (column.pleaseConfirm) {
      const pill = document.createElement("span");
      pill.className = "pill warn";
      pill.textContent = t(REPORT_TEXT.pleaseConfirm);
      choice.append(pill);
    }
    row.append(name, choice);
    body.append(row);
  });

  grid.append(head, body);
  table.append(grid);
  card.append(table);

  const actions = document.createElement("div");
  actions.className = "setup-actions";
  const approve = document.createElement("button");
  approve.type = "button";
  approve.className = "primary-button";
  approve.textContent = t(REPORT_TEXT.continueToPreview);
  approve.addEventListener("click", () => approveMigrationMapping());
  actions.append(approve);
  card.append(actions);
}

function currentMigrationColumns() {
  return [...document.querySelectorAll("#migration-mapping select[data-column]")].map((select) => ({
    index: Number(select.dataset.column),
    field: select.value === "" ? null : select.value,
  }));
}

async function remapMigrationColumns() {
  try {
    const remapped = await api("/api/migration/mapping", {
      method: "POST",
      body: JSON.stringify({ workspaceId: migration.workspaceId, batchId: migration.batch.batchId, columns: currentMigrationColumns() }),
    });
    migration.fingerprint = remapped.fingerprint;
  } catch (error) {
    renderMigrationProblem(error.message);
  }
}

async function approveMigrationMapping() {
  try {
    const preview = await api("/api/migration/approve", {
      method: "POST",
      body: JSON.stringify({
        workspaceId: migration.workspaceId,
        batchId: migration.batch.batchId,
        columns: currentMigrationColumns(),
        fingerprint: migration.fingerprint,
      }),
    });
    renderMigrationPreview(preview);
  } catch (error) {
    renderMigrationProblem(error.message);
  }
}

function renderMigrationPreview(preview) {
  const card = migrationCard("#migration-preview", t(REPORT_TEXT.checkTheColumns), t(preview.summary));
  card.append(reportTable(
    [{ label: "" }, { label: "", numeric: true }],
    [
      [t(REPORT_TEXT.rowsReady), String(preview.accepted)],
      [t(REPORT_TEXT.rowsToFix), String(preview.rejected)],
      [t(REPORT_TEXT.rowsAlreadyHere), String(preview.skipped)],
    ],
  ));

  if (preview.openingTotals) {
    card.append(reportTable(
      [{ label: t(REPORT_TEXT.fileTotals) }, { label: t(REPORT_TEXT.ownedSpent), numeric: true }, { label: t(REPORT_TEXT.owedEarned), numeric: true }],
      [["", money(preview.openingTotals.debit), money(preview.openingTotals.credit)]],
    ));
  }
  if (preview.stockTotal !== null && preview.stockTotal !== undefined) {
    card.append(reportTotalRow(t(REPORT_TEXT.goodsValue), preview.stockTotal));
  }

  if (preview.problems.length > 0) {
    card.append(reportTable(
      [{ label: t(REPORT_TEXT.rowCol), numeric: true }, { label: t(REPORT_TEXT.whatIsWrong) }],
      preview.problems.map((problem) => [String(problem.row), t(problem.message)]),
    ));
  }

  if (preview.errorFile) {
    const download = document.createElement("a");
    download.className = "ghost-button";
    download.href = `data:text/csv;charset=utf-8,${encodeURIComponent(preview.errorFile)}`;
    download.download = "rows-to-fix.csv";
    download.textContent = t(REPORT_TEXT.downloadErrors);
    card.append(download);
  }

  const actions = document.createElement("div");
  actions.className = "setup-actions";
  let reasonField = null;
  if (preview.openingTotals && !preview.openingTotals.balanced) {
    const label = document.createElement("label");
    const span = document.createElement("span");
    span.textContent = t(REPORT_TEXT.differenceReason);
    reasonField = document.createElement("input");
    label.append(span, reasonField);
    card.append(label);
  }
  const commit = document.createElement("button");
  commit.type = "button";
  commit.className = "primary-button";
  commit.textContent = t(REPORT_TEXT.bringItIn);
  commit.disabled = preview.accepted === 0;
  commit.addEventListener("click", () => commitMigration(commit, reasonField === null ? "" : reasonField.value));
  actions.append(commit);
  card.append(actions);
}

async function commitMigration(button, acceptDifferenceReason) {
  button.disabled = true;
  const previous = button.textContent;
  button.textContent = t(REPORT_TEXT.bringingIn);
  try {
    const result = await api("/api/migration/commit", {
      method: "POST",
      body: JSON.stringify({
        workspaceId: migration.workspaceId,
        batchId: migration.batch.batchId,
        acceptDifferenceReason,
      }),
    });
    renderMigrationResult(result);
  } catch (error) {
    renderMigrationProblem(error.message);
  } finally {
    button.disabled = false;
    button.textContent = previous;
  }
}

function renderMigrationResult(result) {
  const card = migrationCard("#migration-result", t(REPORT_TEXT.broughtIn), t(result.reconciliation.sentence));

  const facts = [
    [t(REPORT_TEXT.customersCreated), String(result.books.customers)],
    [t(REPORT_TEXT.itemsCreated), String(result.books.items)],
  ];
  if (result.reconciliation.stockTotals) {
    facts.push([t(REPORT_TEXT.goodsValue), money(result.reconciliation.stockTotals.recordedValue)]);
  }
  card.append(reportTable([{ label: "" }, { label: "", numeric: true }], facts));

  const badge = document.createElement("span");
  badge.className = `pill ${result.books.trialBalance.balanced ? "done" : "warn"}`;
  badge.textContent = result.books.trialBalance.balanced ? t(REPORT_TEXT.booksBalance) : t(REPORT_TEXT.booksDoNotBalance);
  card.append(badge);

  if (result.books.trialBalance.rows.length > 0) {
    const heading = document.createElement("h3");
    heading.className = "setup-subheading";
    heading.textContent = t(REPORT_TEXT.booksNow);
    card.append(heading);
    card.append(reportTable(
      [{ label: t(REPORT_TEXT.account) }, { label: t(REPORT_TEXT.ownedSpent), numeric: true }, { label: t(REPORT_TEXT.owedEarned), numeric: true }],
      result.books.trialBalance.rows.map((row) => [row.name, row.debit ? money(row.debit) : "", row.credit ? money(row.credit) : ""]),
    ));
  }

  if (result.books.stock.length > 0) {
    const heading = document.createElement("h3");
    heading.className = "setup-subheading";
    heading.textContent = t(REPORT_TEXT.stockNow);
    card.append(heading);
    card.append(reportTable(
      [{ label: t(REPORT_TEXT.itemCol) }, { label: t(REPORT_TEXT.leftCol), numeric: true }],
      result.books.stock.map((line) => [line.name, `${line.quantity} ${line.unit}`]),
    ));
  }

  const label = document.createElement("label");
  const span = document.createElement("span");
  span.textContent = t(REPORT_TEXT.whyUndo);
  const reason = document.createElement("input");
  label.append(span, reason);
  const actions = document.createElement("div");
  actions.className = "setup-actions";
  const undo = document.createElement("button");
  undo.type = "button";
  undo.className = "ghost-button";
  undo.textContent = t(REPORT_TEXT.undoImport);
  undo.addEventListener("click", () => rollbackMigration(reason.value));
  actions.append(undo);
  card.append(label, actions);
}

async function rollbackMigration(reason) {
  try {
    const result = await api("/api/migration/rollback", {
      method: "POST",
      body: JSON.stringify({ workspaceId: migration.workspaceId, batchId: migration.batch.batchId, reason }),
    });
    const card = migrationCard("#migration-result", t(REPORT_TEXT.takenBackOut), reason);
    card.append(reportTable(
      [{ label: t(REPORT_TEXT.account) }, { label: t(REPORT_TEXT.ownedSpent), numeric: true }, { label: t(REPORT_TEXT.owedEarned), numeric: true }],
      result.books.trialBalance.rows.map((row) => [row.name, row.debit ? money(row.debit) : "", row.credit ? money(row.credit) : ""]),
    ));
  } catch (error) {
    renderMigrationProblem(error.message);
  }
}

document.querySelector("#migration-read")?.addEventListener("click", () => readMigrationFile());
document.querySelector("#migration-upload")?.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  document.querySelector("#migration-content").value = await file.text();
  document.querySelector("#migration-file-name").value = file.name;
});


// ------------------------------------------------------------------- issue #34: asking questions
//
// The screen sends the question and shows the answer exactly as the assistant built it: the
// sentences, then every figure with the report it came from and the records behind it, then any
// rule it quoted with the notification and the date it took effect, then what it assumed and what
// it was not allowed to see.

let askExamples = null;
let lastAskAnswer = null;

function renderAskExamples() {
  if (askExamples === null) return;
  const box = document.querySelector("#ask-examples");
  box.replaceChildren();
  askExamples.slice(0, 6).forEach((example) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost-button";
    button.textContent = t(example.label);
    button.addEventListener("click", () => {
      document.querySelector("#ask-question").value = t(example.label);
      askQuestion();
    });
    box.append(button);
  });
}

async function loadAskExamples() {
  if (askExamples !== null) {
    renderAskExamples();
    return;
  }
  try {
    const response = await api("/api/assistant/examples");
    askExamples = response.examples;
    renderAskExamples();
  } catch (error) {
    renderAnswerProblem(error.message);
  }
}

function renderAnswerProblem(message) {
  const box = document.querySelector("#ask-answer");
  box.replaceChildren();
  box.append(reportCard(t(REPORT_TEXT.needsALook), message));
}

async function askQuestion() {
  const question = document.querySelector("#ask-question").value.trim();
  if (question === "") return;
  const button = document.querySelector("#ask-send");
  button.disabled = true;
  const previous = button.textContent;
  button.textContent = t(REPORT_TEXT.thinking);
  try {
    const answer = await api("/api/assistant/ask", { method: "POST", body: JSON.stringify({ question }) });
    lastAskAnswer = answer;
    renderAnswer(answer);
  } catch (error) {
    renderAnswerProblem(error.message);
  } finally {
    button.disabled = false;
    button.textContent = previous;
  }
}

function renderAnswer(answer) {
  const box = document.querySelector("#ask-answer");
  box.replaceChildren();
  const card = reportCard(t(REPORT_TEXT.answerLabel), answer.question);

  answer.sentences.forEach((sentence) => {
    const paragraph = document.createElement("p");
    paragraph.className = "ask-sentence";
    paragraph.textContent = t(sentence);
    card.append(paragraph);
  });

  const badge = document.createElement("span");
  badge.className = `pill ${answer.state === "ANSWERED" ? "done" : answer.state === "NEEDS_PERMISSION" ? "hold" : "warn"}`;
  badge.textContent = answer.state.toLowerCase().replace(/_/g, " ");
  card.append(badge);

  if (answer.amounts.length > 0) {
    const heading = document.createElement("h3");
    heading.className = "setup-subheading";
    heading.textContent = t(REPORT_TEXT.whereFrom);
    card.append(heading);
    answer.amounts.forEach((amount) => {
      card.append(reportTotalRow(`${t(amount.what)} · ${amount.reportId.replace(/_/g, " ")} · ${amount.from} → ${amount.to}`, amount.value));
      if (amount.drill.length > 0) {
        card.append(drillDetails(`${amount.records} ${t(REPORT_TEXT.recordsBehind)}`, amount.value, amount.drill));
      }
    });
  }

  answer.compliance.forEach((citation) => {
    const heading = document.createElement("h3");
    heading.className = "setup-subheading";
    heading.textContent =
      citation.certainty === "THE_RULE_SAYS" ? t(REPORT_TEXT.ruleSays)
      : citation.certainty === "THE_RULE_IS_UNCLEAR" ? t(REPORT_TEXT.ruleUnclear)
      : t(REPORT_TEXT.weCannotSay);
    card.append(heading);
    if (citation.source) {
      const rows = [
        [citation.source.title, citation.source.provision],
        [t(REPORT_TEXT.inForceFrom), citation.effectiveFrom ?? citation.source.effectiveFrom],
      ];
      card.append(reportTable([{ label: "" }, { label: "" }], rows));
      const quote = document.createElement("blockquote");
      quote.className = "ask-quote";
      quote.textContent = citation.source.quotedText;
      card.append(quote);
    }
    citation.missing.forEach((missing) => {
      const flag = document.createElement("div");
      flag.className = "report-flag";
      const strong = document.createElement("strong");
      strong.textContent = `${missing.label} — ${missing.whyNeeded}`;
      flag.append(strong);
      card.append(flag);
    });
  });

  const notes = [
    [t(REPORT_TEXT.assumedNote), answer.assumptions],
    [t(REPORT_TEXT.leftOut), answer.withheld],
  ];
  notes.forEach(([label, list]) => {
    if (list.length === 0) return;
    const heading = document.createElement("h3");
    heading.className = "setup-subheading";
    heading.textContent = label;
    card.append(heading);
    list.forEach((note) => {
      const paragraph = document.createElement("p");
      paragraph.className = "setup-hint";
      paragraph.textContent = t(note);
      card.append(paragraph);
    });
  });

  if (answer.nextSteps.length > 0) {
    const steps = document.createElement("ul");
    steps.className = "ask-steps";
    answer.nextSteps.forEach((step) => {
      const item = document.createElement("li");
      item.textContent = t(step.label);
      steps.append(item);
    });
    card.append(steps);
  }

  const disclaimer = document.createElement("p");
  disclaimer.className = "setup-hint";
  disclaimer.textContent = t(answer.disclaimer);
  card.append(disclaimer);

  box.append(card);
}

document.querySelector("#ask-form")?.addEventListener("submit", (event) => { event.preventDefault(); askQuestion(); });

document.querySelector("#setup-form")?.addEventListener("submit", (event) => { event.preventDefault(); checkSetup(); });
document.querySelector("#setup-form")?.addEventListener("input", () => { document.querySelector("#setup-create").hidden = true; });
document.querySelector("#setup-create")?.addEventListener("click", createSetup);

/* ---------------------------------------------------------------- Issues #146 and #147: bill design
 *
 * A business puts its logo, its colour and a picture of its trade on its own bill, and sees a real
 * bill change as it does it. Three rules hold here:
 *
 *  - Nothing is chosen for anybody. Every one of the three starts empty and can be taken off again.
 *  - The picture is shrunk in the browser before it is ever sent, because a logo is copied onto
 *    every bill and a four-megabyte photograph off a phone would be copied onto every bill too.
 *  - The preview is the real bill printer on the server, not a drawing of a bill made here. A
 *    screen that shows something the printer would not is worse than no screen.
 */

/**
 * Issue #180 — the business's own particulars.
 *
 * One screen holds the name, address, PIN code, phone, e-mail, PAN, bank account, and the two
 * pieces of free text the business writes itself. Every printed document reads them from the API,
 * which is the only copy; nothing on this page is invented for the business.
 */
const businessState = { loaded: null, unsavedSignature: null };

function renderBusinessSignature() {
  const signature = businessState.unsavedSignature ?? businessState.loaded?.details?.signatureDataUri ?? null;
  const box = document.querySelector("#business-signature-box");
  const empty = document.querySelector("#business-signature-empty");
  if (!box) return;
  box.querySelector("img")?.remove();
  if (signature === null) {
    if (empty) empty.hidden = false;
  } else {
    if (empty) empty.hidden = true;
    const image = new Image();
    image.src = signature;
    image.alt = "";
    box.append(image);
  }
  document.querySelector("#business-signature-remove").hidden = signature === null;
}

async function openBusinessDetails() {
  const form = document.querySelector("#business-form");
  if (!form) return;
  const text = copy[state.locale];
  let read;
  try { read = await api("/api/business-details"); }
  catch (error) { document.querySelector("#business-status").textContent = error.message; return; }
  businessState.loaded = read;
  businessState.unsavedSignature = null;

  const select = document.querySelector("#business-state");
  select.replaceChildren(...read.states.map((entry) => {
    const option = document.createElement("option");
    option.value = entry.code;
    option.textContent = `${entry.name} (${entry.code})`;
    return option;
  }));

  // What is saved wins; otherwise what was typed while setting the business up is offered.
  const saved = read.details;
  const fill = (name, value) => { const field = form.elements.namedItem(name); if (field) field.value = value ?? ""; };
  fill("legalName", saved?.legalName ?? read.prefill.legalName);
  fill("tradeName", saved?.tradeName ?? read.prefill.tradeName);
  fill("address1", saved?.address1 ?? read.prefill.address1);
  fill("address2", saved?.address2 ?? read.prefill.address2);
  fill("city", saved?.city ?? read.prefill.city);
  fill("pincode", saved?.pincode ?? read.prefill.pincode);
  fill("stateCode", saved?.stateCode ?? read.gstinStateCode);
  fill("phone", saved?.phone ?? read.prefill.phone);
  fill("email", saved?.email);
  fill("pan", saved?.pan);
  fill("declaration", saved?.declaration);
  fill("terms", saved?.terms);
  fill("writeOffLimit", read.writeOffLimit);
  fill("bankName", read.bank?.bankName);
  fill("accountNumber", read.bank?.accountNumber);
  fill("branch", read.bank?.branchName);
  fill("ifsc", read.bank?.ifsc);
  document.querySelector("#business-bank-remove").hidden = read.bank === null;

  document.querySelector("#business-gstin-note").textContent =
    text.businessGstinNote.replace("{gstin}", read.gstin).replace("{state}", `${read.gstinStateName} (${read.gstinStateCode})`);
  document.querySelector("#business-pan-note").textContent = text.businessPanNote.replace("{pan}", read.gstinPan);
  showTurnoverAnswer(read.turnover);
  fill("eInvoiceExemption", read.eInvoiceExemption ?? "NONE");
  renderBusinessSignature();
}

/**
 * Issue #187 / #236 — the turnover band for this financial year, or none ticked when it was never
 * given. An old yes/no answer ticks nothing and says what it was, so the business picks a band.
 */
function showTurnoverAnswer(turnover) {
  const form = document.querySelector("#business-form");
  if (!form || !turnover) return;
  form.querySelectorAll('[name="turnoverBand"]').forEach((radio) => { radio.checked = radio.value === turnover.band; });
  const text = copy[state.locale];
  const again = turnover.askAgain ? ` ${text[`turnoverAskAgain${turnover.askAgain}`]}` : "";
  document.querySelector("#business-turnover-note").textContent =
    `${text.turnoverFor.replace("{year}", turnover.financialYear)}${turnover.band === null || turnover.band === "UNKNOWN" ? ` ${text.turnoverWhy}` : ""}${again}`;
}

async function saveBusinessDetails(clear = []) {
  const form = document.querySelector("#business-form");
  const status = document.querySelector("#business-status");
  status.textContent = copy[state.locale].businessSaving;
  const body = { ...draftData(form), clear };
  if (businessState.unsavedSignature !== null) body.signatureDataUri = businessState.unsavedSignature;
  try {
    const result = await api("/api/business-details", { method: "POST", body: JSON.stringify(body) });
    businessState.loaded = { ...businessState.loaded, details: result.details, bank: result.bank };
    businessState.unsavedSignature = null;
    status.textContent = copy[state.locale].businessSaved;
    document.querySelector("#business-bank-remove").hidden = result.bank === null;
    if (result.turnover) showTurnoverAnswer(result.turnover);
    // Issue #239 — came here from "Answer once in Business details": back to where they were.
    if (state.returnAfterTurnover) {
      const back = state.returnAfterTurnover;
      state.returnAfterTurnover = null;
      if (back !== "business") openView(back);
    }
    if (result.bank === null) {
      for (const name of ["bankName", "accountNumber", "branch", "ifsc"]) {
        const field = form.elements.namedItem(name);
        if (field) field.value = "";
      }
    }
    renderBusinessSignature();
  } catch (error) {
    status.textContent = error.message;
  }
}

document.querySelector("#business-form")?.addEventListener("submit", (event) => {
  event.preventDefault();
  saveBusinessDetails();
});
document.querySelector("#business-bank-remove")?.addEventListener("click", () => saveBusinessDetails(["bank"]));
document.querySelector("#business-signature-remove")?.addEventListener("click", () => {
  businessState.unsavedSignature = null;
  renderBusinessSignature();
  saveBusinessDetails(["signature"]);
});
document.querySelector("#business-signature-input")?.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  businessState.unsavedSignature = await readFileAsDataUri(file);
  renderBusinessSignature();
});

const brandingState = { branding: null, upiId: null, results: [], pictureId: null, unsavedLogo: null, unsavedAccent: null };

/** The longest side a stored logo is allowed, in pixels. It prints about two centimetres tall. */
const LOGO_MAX_PIXELS = 320;

const readFileAsDataUri = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(new Error("unreadable"));
  reader.readAsDataURL(file);
});

/**
 * Shrinks a picture to something a bill can carry, and reads a colour out of it.
 *
 * An SVG is left exactly as it is: it is already small, and it stays sharp at any size, which is
 * the whole point of the format. Redrawing one through a canvas would throw that away.
 */
async function prepareLogo(file) {
  const original = await readFileAsDataUri(file);
  if (file.type === "image/svg+xml") return { dataUri: original, accent: null };
  const image = new Image();
  await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = original; });
  const scale = Math.min(1, LOGO_MAX_PIXELS / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return { dataUri: canvas.toDataURL("image/png"), accent: accentFrom(context, canvas) };
}

/**
 * The strongest colour in a logo, which becomes the colour of the headings and rules.
 *
 * Near-white and near-black pixels are ignored, because almost every logo is mostly one or the
 * other and the answer would always be grey. The colour is then darkened if it is too pale to read
 * as text on white paper — a legible heading matters more than an exact match.
 */
function accentFrom(context, canvas) {
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  const buckets = new Map();
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
    if (a < 200) continue;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max > 235 && min > 235) continue;
    if (max < 25) continue;
    if (max - min < 20) continue;
    const key = `${r >> 4}-${g >> 4}-${b >> 4}`;
    const bucket = buckets.get(key) ?? { r: 0, g: 0, b: 0, n: 0 };
    bucket.r += r; bucket.g += g; bucket.b += b; bucket.n += 1;
    buckets.set(key, bucket);
  }
  let best = null;
  for (const bucket of buckets.values()) if (best === null || bucket.n > best.n) best = bucket;
  if (best === null) return null;
  let [r, g, b] = [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)];
  // Keep darkening until the colour would be readable as text on white paper.
  let guard = 0;
  while (0.2126 * r + 0.7152 * g + 0.0722 * b > 140 && guard < 12) {
    r = Math.round(r * 0.85); g = Math.round(g * 0.85); b = Math.round(b * 0.85); guard += 1;
  }
  const hex = (value) => value.toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

function renderBrandingLogo() {
  const logo = brandingState.unsavedLogo ?? brandingState.branding?.logoDataUri ?? null;
  const box = document.querySelector("#branding-logo-box");
  const empty = document.querySelector("#branding-logo-empty");
  box.querySelector("img")?.remove();
  empty.hidden = logo !== null;
  if (logo !== null) {
    const image = document.createElement("img");
    image.src = logo;
    image.alt = "";
    box.append(image);
  }
  document.querySelector("#branding-logo-remove").hidden = logo === null;

  const accent = brandingState.unsavedAccent ?? brandingState.branding?.accent ?? null;
  document.querySelector("#branding-accent-row").hidden = accent === null;
  if (accent !== null) document.querySelector("#branding-swatch").style.background = accent;
}

function renderBrandingMark() {
  const chosen = brandingState.pictureId ?? brandingState.branding?.tradeMark?.pictureId ?? null;
  const row = document.querySelector("#branding-mark-chosen");
  row.hidden = chosen === null;
  if (chosen !== null) document.querySelector("#branding-mark-name").textContent = chosen;

  const results = document.querySelector("#branding-mark-results");
  results.replaceChildren();
  if (brandingState.results.length === 0) return;
  for (const picture of brandingState.results) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mark-choice";
    button.classList.toggle("chosen", picture.pictureId === chosen);
    button.setAttribute("aria-pressed", String(picture.pictureId === chosen));
    // The drawing comes from our own library on the server, never from anything a person typed.
    const drawing = document.createElement("span");
    drawing.className = "mark-drawing";
    drawing.innerHTML = picture.svg;
    const name = document.createElement("small");
    name.textContent = picture.pictureId;
    button.append(drawing, name);
    button.addEventListener("click", () => {
      brandingState.pictureId = brandingState.pictureId === picture.pictureId ? null : picture.pictureId;
      renderBrandingMark();
      saveBrandingChoices();
    });
    results.append(button);
  }
}

async function refreshBrandingPreview() {
  const status = document.querySelector("#branding-status");
  try {
    const result = await api("/api/branding/preview", {
      method: "POST",
      body: JSON.stringify({
        templateId: document.querySelector("#branding-template").value,
        format: document.querySelector("#branding-format").value,
        locale: state.locale,
        logoDataUri: brandingState.unsavedLogo ?? "",
        accent: brandingState.unsavedAccent ?? "",
        pictureId: brandingState.pictureId ?? "",
      }),
    });
    document.querySelector("#branding-preview").srcdoc = result.html;
  } catch {
    status.textContent = copy[state.locale].brandingLoadFailed;
  }
}

async function saveBrandingChoices(clear = []) {
  const status = document.querySelector("#branding-status");
  status.textContent = copy[state.locale].brandingSaving;
  const result = await api("/api/branding", {
    method: "POST",
    body: JSON.stringify({
      logoDataUri: brandingState.unsavedLogo ?? "",
      accent: brandingState.unsavedAccent ?? "",
      pictureId: brandingState.pictureId ?? "",
      clear,
    }),
  });
  brandingState.branding = result.branding;
  brandingState.unsavedLogo = null;
  brandingState.unsavedAccent = null;
  brandingState.pictureId = result.branding.tradeMark?.pictureId ?? null;
  status.textContent = copy[state.locale].brandingSaved;
  renderBrandingLogo();
  renderBrandingMark();
  await refreshBrandingPreview();
}

async function openBranding() {
  if (brandingState.branding === null) {
    const result = await api("/api/branding");
    brandingState.branding = result.branding;
    brandingState.pictureId = result.branding.tradeMark?.pictureId ?? null;
    brandingState.upiId = result.upiId ?? null;
    const select = document.querySelector("#branding-template");
    select.replaceChildren();
    for (const template of result.templates) {
      const option = document.createElement("option");
      option.value = template.id;
      option.textContent = template.name[state.locale] ?? template.name["en-IN"];
      select.append(option);
    }
  }
  renderBrandingLogo();
  renderBrandingMark();
  renderBrandingUpi();
  await refreshBrandingPreview();
}

/** Issue #144 — shows the saved UPI id, or the empty box to type one into. */
function renderBrandingUpi() {
  const saved = brandingState.upiId;
  document.querySelector("#branding-upi-saved").hidden = saved === null;
  if (saved !== null) document.querySelector("#branding-upi-value").textContent = saved;
}

/** Saves or removes the UPI id. A mistyped id is refused by the server, and its reason shown here. */
async function saveBrandingUpi(clear) {
  const status = document.querySelector("#branding-status");
  const input = document.querySelector("#branding-upi-input");
  status.textContent = copy[state.locale].brandingSaving;
  try {
    const result = await api("/api/branding/upi", {
      method: "POST",
      body: JSON.stringify(clear ? { clear: true } : { upiId: input.value }),
    });
    brandingState.upiId = result.upiId;
    input.value = "";
    status.textContent = copy[state.locale].brandingSaved;
  } catch (error) {
    status.textContent = error.message;
    return;
  }
  renderBrandingUpi();
  await refreshBrandingPreview();
}

document.querySelector("#branding-upi-save")?.addEventListener("click", () => saveBrandingUpi(false));
document.querySelector("#branding-upi-input")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); saveBrandingUpi(false); }
});
document.querySelector("#branding-upi-remove")?.addEventListener("click", () => saveBrandingUpi(true));

document.querySelector("#branding-logo-input")?.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  const prepared = await prepareLogo(file);
  brandingState.unsavedLogo = prepared.dataUri;
  // A colour is only ever suggested from the logo when one was actually found in it, and the
  // business can put the design's own colour back with one press.
  if (prepared.accent !== null) brandingState.unsavedAccent = prepared.accent;
  renderBrandingLogo();
  await saveBrandingChoices();
  event.target.value = "";
});

document.querySelector("#branding-logo-remove")?.addEventListener("click", async () => {
  brandingState.unsavedLogo = null;
  brandingState.unsavedAccent = null;
  await saveBrandingChoices(["logo", "accent"]);
});

document.querySelector("#branding-accent-reset")?.addEventListener("click", async () => {
  brandingState.unsavedAccent = null;
  await saveBrandingChoices(["accent"]);
});

document.querySelector("#branding-mark-remove")?.addEventListener("click", async () => {
  brandingState.pictureId = null;
  await saveBrandingChoices(["tradeMark"]);
});

async function searchBrandingMarks() {
  const query = document.querySelector("#branding-mark-query").value;
  const result = await api("/api/trade-marks/search", { method: "POST", body: JSON.stringify({ query, limit: 24 }) });
  brandingState.results = result.pictures;
  renderBrandingMark();
  if (result.pictures.length === 0) document.querySelector("#branding-status").textContent = copy[state.locale].brandingNoMarkResults;
}

document.querySelector("#branding-mark-search")?.addEventListener("click", searchBrandingMarks);
document.querySelector("#branding-mark-query")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); searchBrandingMarks(); }
});
document.querySelector("#branding-template")?.addEventListener("change", refreshBrandingPreview);
document.querySelector("#branding-format")?.addEventListener("change", refreshBrandingPreview);

document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => openView(button.dataset.view, button.dataset.section ?? null)));
document.querySelectorAll("[data-open]").forEach((button) => button.addEventListener("click", () => openView(button.dataset.open)));
// Issue #298 — switching the language re-renders the open screen too: translate() covers the page's
// own labels, and opening the view again re-reads the server's sentences in the new language.
document.querySelector("#locale").addEventListener("change", (event) => { state.locale = event.target.value; storage?.setItem("karobar.locale", state.locale); translate(); renderPickers(); loadReturnDocuments(); showSaleBill(billOnScreen.invoiceId); openView(state.view); });
// Issue #304 — + Bill, from anywhere: the tab, F2 or Alt+N open a new sale in one tap. The other bills
// are on the sheet, opened by "Other bills" on the sale. Not over the sign-in or another open box.
function openNewSale() {
  if (document.querySelector("dialog[open]")) return;
  openView("sale");
}
function openBillSheet() {
  const sheet = document.querySelector("#bill-sheet");
  if (!sheet || sheet.open || document.querySelector("dialog[open]")) return;
  sheet.showModal();
  sheet.querySelector(".sheet-main")?.focus();
}
document.querySelector("#bill-button").addEventListener("click", openNewSale);
document.querySelector("#other-bills").addEventListener("click", openBillSheet);
document.addEventListener("keydown", (event) => {
  if (event.key === "F2" || (event.altKey && !event.ctrlKey && !event.metaKey && event.code === "KeyN")) {
    event.preventDefault();
    openNewSale();
  }
});
/** Issue #342 — after signing in, and on every load: the business shown, and the others this person can switch to. */
async function loadSession() {
  const session = await api("/api/session");
  const choice = document.querySelector("#company-choice");
  const select = document.querySelector("#company-switch");
  select.replaceChildren(...session.companies.map((company) => {
    const option = document.createElement("option");
    option.value = company.id;
    option.textContent = company.name;
    option.selected = company.id === session.company.id;
    return option;
  }));
  choice.hidden = session.companies.length < 2;
}

function resetLoginForm() {
  const form = document.querySelector("#login-form");
  form.reset();
  document.querySelector("#login-code-field").hidden = true;
  document.querySelector("#login-change-address").hidden = true;
  form.querySelector('[name="code"]').required = false;
  document.querySelector("#login-hint").hidden = true;
  document.querySelector("#login-error").textContent = "";
  form.querySelector('button[type="submit"]').textContent = copy[state.locale].sendCode;
}

// Two steps: the phone number or email, then the code sent to it (ADR D1). No password exists.
document.querySelector("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const error = document.querySelector("#login-error");
  const button = form.querySelector('button[type="submit"]');
  const codeField = document.querySelector("#login-code-field");
  const hint = document.querySelector("#login-hint");
  const address = form.querySelector('[name="address"]').value;
  const askingForCode = codeField.hidden;
  error.textContent = "";
  button.disabled = true;
  button.textContent = copy[state.locale].working;
  try {
    if (askingForCode) {
      const sent = await api("/api/auth/code", { method: "POST", body: JSON.stringify({ address }) });
      codeField.hidden = false;
      document.querySelector("#login-change-address").hidden = false;
      form.querySelector('[name="code"]').required = true;
      hint.textContent = sent.hint ?? copy[state.locale].codeSent;
      hint.hidden = false;
      form.querySelector('[name="code"]').focus();
      return;
    }
    await api("/api/auth/sign-in", { method: "POST", body: JSON.stringify({ address, code: form.querySelector('[name="code"]').value, ...(invitationToken === null ? {} : { invitation: invitationToken }) }) });
    await afterSignIn();
  } catch (failure) { error.textContent = failure.message || copy[state.locale].requestFailed; }
  finally {
    button.disabled = false;
    if (button.textContent === copy[state.locale].working) button.textContent = codeField.hidden ? copy[state.locale].sendCode : copy[state.locale].signIn;
  }
});
document.querySelector("#login-change-address").addEventListener("click", () => resetLoginForm());
document.querySelector("#sign-out").addEventListener("click", async () => {
  // Ends the session on the server too, so a copy of the cookie stops working at once.
  try { await api("/api/auth/sign-out", { method: "POST" }); } catch { /* already signed out */ }
  state.signedIn = false;
  storage?.removeItem("karobar.signedIn");
  resetLoginForm();
  showLogin();
});
// Another of this person's businesses: a new session from the server, then the page starts afresh,
// so nothing of the business just left stays on the screen.
document.querySelector("#company-switch").addEventListener("change", async (event) => {
  try {
    await api("/api/session/company", { method: "POST", body: JSON.stringify({ companyId: event.target.value }) });
    location.reload();
  } catch (failure) {
    const banner = document.querySelector("#connection-banner");
    banner.hidden = false;
    banner.classList.add("failed");
    banner.querySelector("strong").textContent = copy[state.locale].nothingSaved;
    banner.querySelector("span span").textContent = ` ${failure.message}`;
    loadSession();
  }
});

// ------------------------------------------------ issue #23: payment reminders and collection tracking

// ------------------------------------------------ issue #24: authorised live bank feeds

let pendingBankConnectionId = null;
let pendingBankConsentState = null;

// Issue #402: the bank sends the customer back to the start page "/" with `code` and `state`. The
// request is kept for this tab only, so it survives the trip to the bank, and a reply is finished
// only when its `state` is the one this tab was given. The server checks `state` again.
const BANK_CONSENT_KEY = "karobar.bankConsent";
const tabStorage = (() => { try { return sessionStorage; } catch { return undefined; } })();

function rememberBankConsent(connectionId, consentState) {
  pendingBankConnectionId = connectionId; pendingBankConsentState = consentState;
  try {
    if (connectionId) tabStorage?.setItem(BANK_CONSENT_KEY, JSON.stringify({ connectionId, consentState }));
    else tabStorage?.removeItem(BANK_CONSENT_KEY);
  } catch { /* without tab storage only the in-page approval works */ }
}

async function completeBankConsent(authorizationCode) {
  await api("/api/bank-feeds/consent/complete", { method: "POST", body: JSON.stringify({ connectionId: pendingBankConnectionId, authorizationCode, consentState: pendingBankConsentState }) });
  rememberBankConsent(null, null);
  document.querySelector("#bank-feed-approve").hidden = true;
  showDialog({ title: copy[state.locale].bankConnected, message: copy[state.locale].bankFeedSafety }, "recorded");
  await loadBankFeeds();
}

async function finishBankReturn() {
  const reply = new URLSearchParams(location.search);
  if (!reply.has("code") && !reply.has("state")) return;
  // The code is spent once; it is taken out of the address bar and history before anything else.
  history.replaceState(null, "", `${location.pathname}#bank-feeds`);
  openView("bank-feeds");
  let pending = null;
  try { pending = JSON.parse(tabStorage?.getItem(BANK_CONSENT_KEY) ?? "null"); } catch { pending = null; }
  const code = reply.get("code"); const returned = reply.get("state");
  if (!pending?.connectionId || !code || !returned || returned !== pending.consentState) {
    rememberBankConsent(null, null);
    showDialog({ title: copy[state.locale].nothingSaved, message: copy[state.locale].bankReturnRefused }, "failed");
    return;
  }
  pendingBankConnectionId = pending.connectionId; pendingBankConsentState = pending.consentState;
  try { await completeBankConsent(code); } catch (error) { rememberBankConsent(null, null); showDialog({ title: copy[state.locale].nothingSaved, message: localizedError(error) }, "failed"); }
}

function bankActivityRow(iconText, title, detail, tone = "green") {
  const row = document.createElement("div"); row.className = "activity-row";
  const icon = document.createElement("span"); icon.className = `activity-icon ${tone}`; icon.setAttribute("aria-hidden", "true"); icon.textContent = iconText;
  const body = document.createElement("div"); const strong = document.createElement("strong"); strong.textContent = title; const small = document.createElement("small"); small.textContent = detail; body.append(strong, small); row.append(icon, body); return row;
}

async function loadBankFeeds() {
  const connections = document.querySelector("#bank-feed-connections");
  const transactions = document.querySelector("#bank-feed-transactions");
  if (!connections || !transactions || !state.signedIn) return;
  try {
    const workspace = await api("/api/bank-feeds");
    connections.replaceChildren(); transactions.replaceChildren();
    if (workspace.connections.length === 0) connections.append(Object.assign(document.createElement("p"), { className: "loading-copy", textContent: copy[state.locale].noBankConnections }));
    for (const connection of workspace.connections) {
      const account = connection.accounts[0];
      const detail = account ? `${account.maskedAccountNumber} · ${account.balancePaise === null ? "—" : money(Number(account.balancePaise) / 100)}` : connection.provider;
      const row = bankActivityRow("⇅", `${account?.displayName ?? connection.provider} · ${connection.status}`, detail, connection.status === "CONNECTED" ? "green" : connection.status === "ERROR" || connection.status === "TOKEN_EXPIRED" ? "red" : "amber");
      if (connection.status === "CONNECTED") {
        const actions = document.createElement("div");
        for (const [label, action] of [[copy[state.locale].syncNow, "sync"], [copy[state.locale].disconnectBank, "disconnect"]]) { const button = document.createElement("button"); button.type = "button"; button.className = "secondary-button"; button.textContent = label; button.dataset.bankAction = action; button.dataset.connectionId = connection.id; actions.append(button); }
        row.append(actions);
      }
      connections.append(row);
      connection.transactions.forEach((item) => transactions.append(bankActivityRow(item.creditPaise !== "0" ? "+" : "−", item.description, `${item.bookedOn} · ${money(Number(item.creditPaise !== "0" ? item.creditPaise : item.debitPaise) / 100)}${item.reference ? ` · ${item.reference}` : ""}`)));
    }
    if (transactions.childElementCount === 0) transactions.append(Object.assign(document.createElement("p"), { className: "loading-copy", textContent: copy[state.locale].noBankTransactions }));
  } catch (error) { connections.textContent = localizedError(error); }
}

document.querySelector("#bank-feed-connect")?.addEventListener("click", async () => {
  try {
    const result = await api("/api/bank-feeds/consent", { method: "POST", body: JSON.stringify({ provider: "sandbox-aa" }) });
    rememberBankConsent(result.connection.id, result.consentState);
    document.querySelector("#bank-feed-approve").hidden = false;
    showDialog({ title: copy[state.locale].giveBankPermission, message: copy[state.locale].bankConsentHelp, effects: [result.connection.provider] }, "preview");
    await loadBankFeeds();
  } catch (error) { showDialog({ title: copy[state.locale].nothingSaved, message: localizedError(error) }, "failed"); }
});

document.querySelector("#bank-feed-approve")?.addEventListener("click", async () => {
  if (!pendingBankConnectionId) return;
  try {
    await completeBankConsent("sandbox-approved");
  } catch (error) { showDialog({ title: copy[state.locale].nothingSaved, message: localizedError(error) }, "failed"); }
});

document.querySelector("#bank-feed-connections")?.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-bank-action]"); if (!button) return;
  const sync = button.dataset.bankAction === "sync";
  try {
    const result = await api(sync ? "/api/bank-feeds/sync" : "/api/bank-feeds/disconnect", { method: "POST", body: JSON.stringify({ connectionId: button.dataset.connectionId, idempotencyKey: `${button.dataset.bankAction}:${button.dataset.connectionId}:${new Date().toISOString().slice(0, 10)}` }) });
    showDialog({ title: copy[state.locale][sync ? "bankSynced" : "bankDisconnected"], message: sync ? `${result.imported} new transaction(s), ${result.duplicates} duplicate(s).` : result.message }, "recorded");
    await loadBankFeeds();
  } catch (error) { showDialog({ title: copy[state.locale].nothingSaved, message: localizedError(error) }, "failed"); }
});

document.querySelector("#review-cancel").addEventListener("click", () => { state.pendingReturnInput = null; document.querySelector("#review-dialog").close("cancel"); });
document.querySelector("#review-confirm").addEventListener("click", async (event) => {
  if (state.pendingReturnInput) {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = copy[state.locale].recording;
    try {
      const result = await api("/api/returns/record", { method: "POST", body: JSON.stringify(state.pendingReturnInput) });
      state.pendingReturnInput = null;
      const localized = localizeReturnResult(result, "recorded", result.note.kind);
      showDialog({ ...localized, effects: [`${result.note.number} · ${money(result.note.amount)}`] }, "recorded");
      // Issue #186 — the note is waiting on the screen behind the dialog, ready to print or send.
      await showReturnNote(result.note.id);
      await refreshDocumentLists();
    } catch (error) {
      showDialog({ title: copy[state.locale].nothingSaved, message: localizedError(error) }, "failed");
    }
    return;
  }
  const approval = document.querySelector("#review-approval");
  if (!approval.hidden && !document.querySelector("#review-approval-field").hidden) {
    const reason = document.querySelector("#review-approval-reason");
    if (reason.value.trim() === "") {
      document.querySelector("#review-approval-text").textContent = text("approvalReasonNeeded");
      reason.focus();
      return;
    }
    state.pendingInput = { ...state.pendingInput, approvalReason: reason.value.trim() };
  }
  await recordPending(event.currentTarget);
});

/**
 * Records the review on screen: Record once in the review box, or Make bill on the sale's last slide
 * (#305). The review's own key goes with it (#233), so pressing either twice records once.
 */
async function recordPending(button) {
  if (!state.pendingForm || !state.pendingInput) return null;
  button.disabled = true;
  button.textContent = copy[state.locale].recording;
  try {
    const form = state.pendingForm;
    const result = await api(`/api/${form.dataset.endpoint ?? `${form.dataset.draft}s`}/record`, { method: "POST", body: JSON.stringify(state.pendingInput) });
    storage?.removeItem(`karobar.draft.${form.dataset.draft}`);
    hideDraftDateNote(form);
    forgetPendingDraft(form);
    // Issue #233 — the form becomes a fresh, empty sale, so pressing Review and Record again cannot
    // make a second bill for the same goods by accident. Done before the dialog is filled, because
    // adding the fresh line re-translates the page, dialog included.
    // Issue #262 — a purchase entered for a sale that was stopped: the goods are in, so the way back.
    const forSale = form.dataset.draft === "purchase" && saleWaitingForStock() !== null;
    if (form.dataset.draft === "purchase") resetPurchaseForm(form);
    // Issue #301 — a sale held for approval is not a bill yet: the form is cleared, and it waits in the list.
    const saleWaiting = form.dataset.draft === "sale" && result.state === "waiting";
    if (form.dataset.draft === "sale" && result.invoice) resetSaleForm(form);
    if (saleWaiting) resetSaleForm(form);
    // Issue #307 — a sale finishes on the done screen; everything else in the recorded box.
    const saleDone = form.dataset.draft === "sale" && Boolean(result.invoice);
    if (saleDone) document.querySelector("#review-dialog").close();
    else if (saleWaiting) showDialog({ title: result.title, message: result.message, effects: [] }, "recorded");
    else showDialog(withPurchaseCheck(forSale ? purchaseForSaleRecorded(localizeResult(result, form.dataset.draft, "recorded")) : localizeResult(result, form.dataset.draft, "recorded")), "recorded");
    if (forSale) showPurchaseForSaleNote(true);
    // Issue #230 — the receipt or payment voucher is ready behind the dialog, and the form is empty for the next one.
    if (form.dataset.endpoint === "payments" && result.paymentId) await paymentRecorded(form, result);
    // Issue #289, part 2b — a reverse-charge bill from a seller with no GST number joins the self-invoice list.
    if (form.dataset.draft === "purchase" && result.reverseCharge?.selfInvoice) await loadSelfInvoices();
    // Issue #132 — the bill is waiting on the screen behind the done screen, not on a developer's laptop.
    if (saleDone) { await openDoneScreen(result); await showSaleBill(result.invoice.id); }
    await refreshDocumentLists();
    return result;
  } catch (error) {
    showSaleFailure(error);
    return null;
  } finally {
    button.disabled = false;
    updateSaleBar();
  }
}

/** Issue #311 — a recorded supplier bill says its purchase check (GSTR-2B/IMS) on the bill itself. */
function withPurchaseCheck(result) {
  if (!result.purchaseCheck) return result;
  return { ...result, effects: [...(result.effects || []), text("purchaseCheckLine", { line: t(result.purchaseCheck) })] };
}

// ------------------------------------------------- issue #132: the bill, on screen and on paper
//
// The page in the frame is rendered by the server's own bill printer, from the design frozen onto
// that bill when it was issued. The browser draws nothing of its own, so what a shopkeeper checks
// here is what the printer puts on paper, and an old bill comes back as it was printed. Printing is
// the browser's print box: the page carries its own paper size, so A4 and till roll come out right.

const billOnScreen = { invoiceId: null, paperChosen: false, copies: 1 };

async function showSaleBill(invoiceId) {
  if (!invoiceId) return;
  billOnScreen.invoiceId = invoiceId;
  const panel = document.querySelector("#sale-bill-panel");
  // An A4 grid shrunk into a phone is unreadable, so a phone opens the page made for a phone —
  // until somebody picks the paper themselves, which is then respected.
  const paper = document.querySelector("#sale-bill-format");
  if (!billOnScreen.paperChosen && window.innerWidth <= 760) paper.value = "MOBILE";
  const note = document.querySelector("#sale-bill-note");
  panel.hidden = false;
  try {
    const printed = await api("/api/sales/print", {
      method: "POST",
      body: JSON.stringify({ invoice: invoiceId, locale: state.locale, format: document.querySelector("#sale-bill-format").value }),
    });
    document.querySelector("#sale-bill-title").textContent = `${copy[state.locale].billTitle} · ${printed.number}`;
    note.textContent = copy[state.locale][printed.cancelled ? "billCancelledNote" : printed.hasBuyerAddress ? "billReady" : "billNoAddress"];
    // Issue #233 — only a bill that stands can be cancelled.
    const cancelButton = document.querySelector("#sale-bill-cancel");
    if (cancelButton) { cancelButton.hidden = printed.cancelled === true; cancelButton.dataset.number = printed.number; }
    document.querySelector("#sale-bill-frame").srcdoc = printed.html;
    showSaleBillEway(invoiceId, printed.cancelled === true);
    // Issue #183 — the button says how many sheets one press will produce, because a goods bill is
    // prepared in triplicate and a services bill in duplicate, and the person pressing Print is
    // entitled to know before the paper comes out.
    billOnScreen.copies = printed.copies ?? 1;
    const printButton = document.querySelector("#sale-bill-print");
    if (printButton) {
      printButton.textContent = paper.value === "A4" && billOnScreen.copies > 1
        ? text("printBillCopies", { copies: String(billOnScreen.copies) })
        : copy[state.locale].printBill;
    }
    // Issue #305 — the done slide stays in view; the bill waits below it.
    if (saleSlides?.current() !== "done") panel.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    document.querySelector("#sale-bill-title").textContent = copy[state.locale].billLoadFailed;
    note.textContent = localizedError(error);
  }
}

// ------------------------------------------------- issue #307: the done screen
//
// After Record, the sale finishes here: WhatsApp with the customer's number and a UPI link for what
// is still due, the receipt on the remembered paper, and a new bill. The screen itself lives in
// done-screen.js, so the four-slide sale (#305) shows the same one.

async function openDoneScreen(sale) {
  // Issue #305 — on the sale screen the done screen is the last slide; elsewhere, its own box.
  const slide = saleSlides && state.view === "sale" ? document.querySelector("#sale-done") : null;
  const dialog = slide ?? document.querySelector("#done-screen");
  if (!dialog) return;
  const { mountDoneScreen } = await import("./done-screen.js");
  const words = copy[state.locale];
  const close = () => { if (slide === null) dialog.close(); };
  const first = mountDoneScreen(dialog, sale, {
    words, money, storage,
    onPrint: (format) => printSaleBill(sale.invoice.id, format),
    onNewBill: () => { close(); openView("sale"); startNewSaleSlides(); },
    onDownload: () => downloadBillPdf(sale.invoice.id, sale.invoice.number).catch((error) => { close(); showDialog({ title: words.nothingSaved, message: localizedError(error) }, "failed"); }),
    onEway: () => { close(); openEwayForBill(sale.invoice.id); },
    onCancel: () => {
      close();
      const cancel = document.querySelector("#sale-bill-cancel");
      billOnScreen.invoiceId = sale.invoice.id;
      if (cancel) { cancel.dataset.number = sale.invoice.number; cancel.click(); }
    },
  });
  // Issue #311 — the e-way bill raised by itself (or why it waits on Home), on the finished bill.
  const eway = doneEwayLine(sale);
  if (eway) {
    const line = document.createElement("p");
    line.className = eway.ok ? "line-ok" : "line-warn";
    line.textContent = eway.text;
    dialog.querySelector(".done-line")?.after(line);
  }
  if (slide) saleSlides.show("done", { focus: false });
  else if (!dialog.open) dialog.showModal();
  first?.focus();
}

/** Issue #311 — one line on the done screen for the e-way bill: raised by itself, waiting, or refused. */
function doneEwayLine(sale) {
  const raised = sale.ewayRaised;
  if (raised?.ewayBillNumber) return { ok: true, text: text("doneEwayRaised", { number: raised.ewayBillNumber, valid: raised.validUntilLabel ?? "" }) };
  if (sale.ewayBill?.outcome !== "REQUIRED") return null;
  if (raised) return { ok: false, text: text("doneEwayFailed", { reason: raised.failure?.message ?? raised.message ?? "" }) };
  return { ok: false, text: text("doneEwayWaiting") };
}

/** Issue #307 — the bill on the paper chosen on the done screen, printed through the bill's own print path. */
async function printSaleBill(invoiceId, format) {
  const paper = document.querySelector("#sale-bill-format");
  const frame = document.querySelector("#sale-bill-frame");
  if (!paper || !frame) return;
  paper.value = format;
  billOnScreen.paperChosen = true;
  const loaded = new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
  await showSaleBill(invoiceId);
  await loaded;
  document.querySelector("#sale-bill-print")?.click();
}

// Issue #240 — under the bill: its e-way bill in one press when the goods need one, the number when
// it has been raised, and a plain "not needed, because…" when it is not.
async function showSaleBillEway(invoiceId, cancelled) {
  const button = document.querySelector("#sale-bill-eway");
  const note = document.querySelector("#sale-bill-eway-note");
  if (!button || !note) return;
  button.hidden = true;
  note.hidden = true;
  if (cancelled) return;
  try {
    const found = await api("/api/eway/for-bill", { method: "POST", body: JSON.stringify({ invoice: invoiceId }) });
    if (billOnScreen.invoiceId !== invoiceId) return;
    button.dataset.invoice = invoiceId;
    if (found.raised) {
      button.hidden = false;
      button.textContent = copy[state.locale].ewayOpen;
      note.hidden = false;
      note.textContent = `${found.raised.title}: ${found.raised.ewayBillNumber}${found.raised.validUntilLabel ? ` · ${found.raised.validUntilLabel}` : ""}`;
    } else if (found.check.outcome === "REQUIRED") {
      button.hidden = false;
      button.textContent = copy[state.locale].ewayFromBill;
      note.hidden = false;
      note.textContent = found.check.reason;
    } else {
      note.hidden = false;
      note.textContent = `${found.check.title}. ${found.check.reason}`;
    }
  } catch { /* the bill stands whatever the e-way bill check says; the e-way bill screen still works */ }
}

document.querySelector("#sale-bill-eway")?.addEventListener("click", (event) => {
  const invoiceId = event.currentTarget.dataset.invoice;
  if (invoiceId) openEwayForBill(invoiceId);
});

// ------------------------------------------------- issue #233: cancelling a wrong bill
//
// The server decides everything: whether this bill may still be cancelled, what it will change, and
// what has to be cancelled with the government first. The screen shows that and sends the reason.

const cancelOnScreen = { invoiceId: null, clearFirst: [], documentId: null };

function showCancelEffects(title, message, effects) {
  document.querySelector("#cancel-bill-title").textContent = title;
  document.querySelector("#cancel-bill-message").textContent = message;
  document.querySelector("#cancel-bill-effects").replaceChildren(...(effects || []).map((effect) => {
    const item = document.createElement("li");
    item.textContent = effect;
    return item;
  }));
}

document.querySelector("#sale-bill-cancel")?.addEventListener("click", async () => {
  if (!billOnScreen.invoiceId) return;
  const dialog = document.querySelector("#cancel-bill-dialog");
  const confirm = document.querySelector("#cancel-bill-confirm");
  const creditNote = document.querySelector("#cancel-bill-credit-note");
  const reasonField = document.querySelector("#cancel-bill-reason-field");
  document.querySelector("#cancel-bill-form").reset();
  document.querySelector("#cancel-bill-error").textContent = "";
  cancelOnScreen.invoiceId = billOnScreen.invoiceId;
  cancelOnScreen.clearFirst = [];
  confirm.hidden = true;
  creditNote.hidden = true;
  reasonField.hidden = true;
  showCancelEffects(`${copy[state.locale].cancelBill} · ${document.querySelector("#sale-bill-cancel").dataset.number ?? ""}`, copy[state.locale].cancelBillChecking, []);
  if (!dialog.open) dialog.showModal();
  try {
    const preview = await api("/api/sales/cancel/preview", { method: "POST", body: JSON.stringify({ invoice: cancelOnScreen.invoiceId }) });
    cancelOnScreen.clearFirst = preview.clearFirst || [];
    showCancelEffects(preview.title, preview.message, preview.effects);
    confirm.textContent = copy[state.locale][cancelOnScreen.clearFirst.length > 0 ? "cancelGovernmentFirst" : "cancelBillConfirm"];
    confirm.hidden = false;
    reasonField.hidden = false;
  } catch (error) {
    // Refused: the month is approved or filed, a credit note exists, or the government's window has
    // closed. The way forward is a credit note for the whole bill, offered right here.
    showCancelEffects(copy[state.locale].nothingSaved, localizedError(error), []);
    cancelOnScreen.documentId = cancelOnScreen.invoiceId;
    creditNote.hidden = false;
  }
});

document.querySelector("#cancel-bill-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const confirm = document.querySelector("#cancel-bill-confirm");
  confirm.disabled = true;
  try {
    const result = await api("/api/sales/cancel", {
      method: "POST",
      body: JSON.stringify({
        invoice: cancelOnScreen.invoiceId,
        reason: form.elements.namedItem("reason").value,
        cancelGovernmentDocuments: cancelOnScreen.clearFirst.length > 0,
      }),
    });
    document.querySelector("#cancel-bill-dialog").close();
    showDialog({ title: result.title, message: result.message, effects: result.onAccount ? [result.onAccount.message] : [] }, "recorded");
    await showSaleBill(result.invoice.id);
    await refreshDocumentLists();
  } catch (error) {
    document.querySelector("#cancel-bill-error").textContent = localizedError(error);
  } finally { confirm.disabled = false; }
});

document.querySelector("#cancel-bill-credit-note")?.addEventListener("click", async () => {
  const documentId = cancelOnScreen.documentId;
  document.querySelector("#cancel-bill-dialog").close();
  openView("returns");
  await loadReturnDocuments();
  const select = document.querySelector("#return-document");
  if (select && [...select.options].some((option) => option.value === documentId)) {
    select.value = documentId;
    updateReturnLines();
    document.querySelector("#return-line").value = WHOLE_BILL;
    updateReturnRemaining();
  }
});

/**
 * Issue #183 — on A4, Print produces every marked copy in one job: the Original for the customer,
 * the Duplicate for the transporter and the Triplicate for the business. The screen keeps showing
 * the Original, so what is printed is fetched for the printing rather than swapped on screen.
 * A till roll prints one slip, marked Original; three counter slips would be waste, not compliance.
 */
document.querySelector("#sale-bill-print")?.addEventListener("click", async () => {
  const frame = document.querySelector("#sale-bill-frame");
  const paper = document.querySelector("#sale-bill-format").value;
  if (paper !== "A4" || (billOnScreen.copies ?? 1) <= 1) { frame.contentWindow?.print(); return; }
  try {
    const printed = await api("/api/sales/print", {
      method: "POST",
      body: JSON.stringify({ invoice: billOnScreen.invoiceId, locale: state.locale, format: paper, copies: "all" }),
    });
    const sheets = document.querySelector("#sale-bill-copies");
    sheets.srcdoc = printed.html;
    sheets.addEventListener("load", () => sheets.contentWindow?.print(), { once: true });
  } catch { frame.contentWindow?.print(); }
});
document.querySelector("#sale-bill-format")?.addEventListener("change", () => { billOnScreen.paperChosen = true; showSaleBill(billOnScreen.invoiceId); });

// ----------------------------------------------------------- issue #45: linked return notes
//
// The choices come from issued/posted documents, and preview calls the same service that will
// post. The browser never calculates eligible quantity, tax or balances on its own.

/** Issue #233 — the Returns screen's choice that credits a whole sales bill, freight included. */
const WHOLE_BILL = "__whole__";

function updateReturnLines() {
  const documentSelect = document.querySelector("#return-document");
  const lineSelect = document.querySelector("#return-line");
  const selectedDocument = state.returnDocuments.find((candidate) => candidate.id === documentSelect.value);
  lineSelect.replaceChildren();
  if (!selectedDocument) {
    documentSelect.form.elements.kind.value = "";
    documentSelect.form.elements.unit.value = "";
    return;
  }
  documentSelect.form.elements.kind.value = selectedDocument.kind;
  // Issue #293 — a price correction is for our own bills; a supplier's comes on their own note.
  const modeField = document.querySelector("#return-mode-field");
  if (modeField) {
    modeField.hidden = selectedDocument.kind !== "SALES_RETURN";
    if (modeField.hidden) documentSelect.form.elements.namedItem("mode").value = "";
  }
  // Issue #249 — only goods sent back to a supplier have a supplier's credit note.
  const supplierNote = document.querySelector("#return-supplier-note");
  if (supplierNote) supplierNote.hidden = selectedDocument.kind !== "PURCHASE_RETURN";
  selectedDocument.lines.forEach((line) => {
    const option = document.createElement("option");
    option.value = line.id;
    option.dataset.unit = line.unit;
    option.dataset.remaining = String(line.quantity - line.returned);
    option.textContent = text("returnLineChoice", { item: line.item, quantity: line.quantity - line.returned, unit: line.unit });
    lineSelect.append(option);
  });
  // Issue #233 — a customer's bill can be credited whole: every item still on it and every charge.
  if (selectedDocument.kind === "SALES_RETURN" && selectedDocument.leftToCredit > 0 && documentSelect.form.elements.namedItem("mode")?.value !== "PRICE") {
    const whole = document.createElement("option");
    whole.value = WHOLE_BILL;
    whole.textContent = text("wholeBillChoice", { amount: money(selectedDocument.leftToCredit) });
    lineSelect.append(whole);
  }
  updateReturnRemaining();
}

function updateReturnRemaining() {
  const option = document.querySelector("#return-line").selectedOptions[0];
  const form = document.querySelector("#return-form");
  // The whole bill has no quantity to type: the server credits what is left of every line.
  const whole = option?.value === WHOLE_BILL;
  const quantity = form.elements.namedItem("quantity");
  quantity.disabled = whole;
  quantity.closest("label").hidden = whole;
  if (whole) {
    form.elements.unit.value = "";
    document.querySelector("#return-remaining").textContent = option.textContent;
    return;
  }
  form.elements.unit.value = option?.dataset.unit ?? "";
  document.querySelector("#return-remaining").textContent = option
    ? text("returnEligible", { quantity: option.dataset.remaining, unit: option.dataset.unit })
    : copy[state.locale].returnRemaining;
  applyReturnMode(form);
}

/**
 * Issue #293 — "Price correction": the new price or the amount off instead of a quantity, and no
 * "what happens to the goods", because nothing comes back. The server decides credit or debit note.
 */
function applyReturnMode(form) {
  const price = form.elements.namedItem("mode")?.value === "PRICE";
  const fields = document.querySelector("#return-price");
  if (fields) fields.hidden = !price;
  if (fields) fields.disabled = !price;
  const quantity = form.elements.namedItem("quantity");
  const disposition = form.elements.namedItem("disposition");
  if (price) { quantity.disabled = true; quantity.closest("label").hidden = true; }
  disposition.disabled = price;
  disposition.closest("label").hidden = price;
}

// ------------------------------------------------ issue #186: the credit or debit note on paper

const noteOnScreen = { noteId: null, number: "note", paperChosen: false };

async function showReturnNote(noteId) {
  if (!noteId) return;
  noteOnScreen.noteId = noteId;
  const panel = document.querySelector("#note-panel");
  const paper = document.querySelector("#note-format");
  if (!noteOnScreen.paperChosen && window.innerWidth <= 760) paper.value = "MOBILE";
  panel.hidden = false;
  try {
    const printed = await api("/api/returns/print", { method: "POST", body: JSON.stringify({ note: noteId, locale: state.locale, format: paper.value }) });
    noteOnScreen.number = printed.number;
    document.querySelector("#note-title").textContent = printed.number;
    document.querySelector("#note-frame").srcdoc = printed.html;
    panel.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    document.querySelector("#note-title").textContent = localizedError(error);
  }
}

async function loadReturnNotes() {
  const list = document.querySelector("#note-list");
  if (!list || !state.signedIn) return;
  try {
    const { notes } = await apiList("/api/returns/notes", "notes");
    document.querySelector("#note-list-panel").hidden = notes.length === 0;
    list.replaceChildren(...notes.map((note) => {
      const row = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = `${note.number} · ${text("noteAgainst", { number: note.against })} · ${money(note.amount)}`;
      row.append(label);
      // Issue #249 — a return to a supplier shows their credit note, or lets it be added when it comes.
      if (note.kind === "PURCHASE_RETURN") {
        const small = document.createElement("small");
        small.textContent = ` · ${note.supplierCreditNote
          ? text("supplierNoteShown", { number: note.supplierCreditNote.number, date: note.supplierCreditNote.date })
          : copy[state.locale].supplierNoteAwaited}`;
        row.append(small);
        if (!note.supplierCreditNote) {
          const form = document.createElement("form");
          form.className = "inline-form";
          form.dataset.supplierNote = note.id;
          const number = document.createElement("input");
          number.name = "supplierNoteNumber"; number.required = true; number.maxLength = 16;
          number.placeholder = copy[state.locale].supplierNoteNumber;
          number.setAttribute("aria-label", copy[state.locale].supplierNoteNumber);
          const date = document.createElement("input");
          date.name = "supplierNoteDate"; date.type = "date"; date.required = true;
          date.setAttribute("aria-label", copy[state.locale].supplierNoteDate);
          const save = document.createElement("button");
          save.type = "submit"; save.className = "text-button"; save.textContent = copy[state.locale].supplierNoteAdd;
          form.append(number, " ", date, " ", save);
          row.append(" ", form);
        }
      }
      if (note.printable) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "text-button";
        button.dataset.printNote = note.id;
        button.textContent = copy[state.locale].notePrintAction;
        row.append(" ", button);
      } else {
        const small = document.createElement("small");
        small.textContent = ` ${copy[state.locale].noteNotPrintable}`;
        row.append(small);
      }
      return row;
    }));
  } catch { /* the list is a convenience; the note itself is shown after recording */ }
}

document.querySelector("#note-list")?.addEventListener("submit", async (event) => {
  const form = event.target instanceof HTMLFormElement ? event.target : null;
  if (!form?.dataset.supplierNote) return;
  event.preventDefault();
  try {
    const result = await api("/api/returns/supplier-note", {
      method: "POST",
      body: JSON.stringify({ noteId: form.dataset.supplierNote, ...formValues(form) }),
    });
    showDialog({ title: result.title, message: result.message }, "recorded");
    loadReturnNotes();
  } catch (error) {
    showDialog({ title: copy[state.locale].nothingSaved, message: localizedError(error) }, "failed");
  }
});
document.querySelector("#note-list")?.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest("[data-print-note]") : null;
  if (button) showReturnNote(button.dataset.printNote);
});
document.querySelector("#note-print")?.addEventListener("click", () => document.querySelector("#note-frame").contentWindow?.print());
document.querySelector("#note-format")?.addEventListener("change", () => { noteOnScreen.paperChosen = true; showReturnNote(noteOnScreen.noteId); });
document.querySelector("#note-download")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const response = await fetch(`/api/returns/${encodeURIComponent(noteOnScreen.noteId)}/pdf`, { credentials: "same-origin" });
    if (!response.ok) throw new Error((await response.json()).message || copy[state.locale].requestFailed);
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = `${noteOnScreen.number.replace(/[^a-zA-Z0-9._-]/g, "_")}.pdf`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (error) {
    document.querySelector("#note-help").textContent = localizedError(error);
  } finally { button.disabled = false; }
});

async function loadReturnDocuments() {
  const select = document.querySelector("#return-document");
  if (!select || !state.signedIn) return;
  try {
    const result = await apiList("/api/returns/documents", "documents");
    state.returnDocuments = result.documents;
    const selected = select.value;
    select.replaceChildren();
    if (result.documents.length === 0) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = copy[state.locale].noReturnDocuments;
      select.append(option);
    } else {
      result.documents.forEach((entry) => {
        const option = document.createElement("option");
        option.value = entry.id;
        option.textContent = `${copy[state.locale][entry.kind === "SALES_RETURN" ? "customerSale" : "supplierPurchase"]} · ${entry.number} · ${entry.party}`;
        select.append(option);
      });
      if (result.documents.some((entry) => entry.id === selected)) select.value = selected;
    }
    updateReturnLines();
  } catch (error) {
    document.querySelector("#return-remaining").textContent = localizedError(error);
  }
}

document.querySelector("#return-document")?.addEventListener("change", updateReturnLines);
document.querySelector("#return-line")?.addEventListener("change", updateReturnRemaining);
document.querySelector("#return-mode")?.addEventListener("change", updateReturnLines);
document.querySelector("#return-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const input = formValues(form);
  // Issue #392 — one key per checked return, sent again with Record, so pressing it twice records one note.
  input.requestId = newPaymentRequestId();
  state.pendingForm = null;
  state.pendingInput = null;
  state.pendingReturnInput = input;
  form.setAttribute("aria-busy", "true");
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  submit.textContent = copy[state.locale].working;
  showDialog({ title: copy[state.locale].checking, message: copy[state.locale].checkingBody }, "loading");
  try {
    const result = await api("/api/returns/preview", { method: "POST", body: JSON.stringify(input) });
    showDialog(localizeReturnResult(result, "preview", input.kind), "preview");
  } catch (error) {
    state.pendingReturnInput = null;
    showDialog({ title: copy[state.locale].nothingSaved, message: localizedError(error) }, "failed");
  } finally {
    submit.disabled = false;
    submit.textContent = copy[state.locale].checkReturn;
    form.setAttribute("aria-busy", "false");
  }
});

// ------------------------------------------------------- issue #18: orders, deliveries, matching
//
// Three small forms rather than one wizard, because the three things happen on three different
// days: the order on Monday, the lorry on Thursday, the bill the week after. Each posts to the
// real service, so what appears here is what the module actually decided.

const formValues = (form) => Object.fromEntries([...new FormData(form).entries()].filter(([, value]) => typeof value === "string"));

/** Shows the plain-language line the service returned, or the plain-language refusal. */
function showStep(id, text, failed) {
  const target = document.querySelector(id);
  target.textContent = text;
  target.classList.toggle("failed-copy", Boolean(failed));
}

function refreshStock(stock) {
  if (!stock) return;
  document.querySelector("#stock-now").textContent = `${stock.name}: ${stock.onShelf} in the godown`;
}

const cell = (value) => {
  const td = document.createElement("td");
  td.textContent = value === null || value === undefined ? "—" : String(value);
  return td;
};

function renderMatch(result) {
  const panel = document.querySelector("#match-panel");
  panel.hidden = false;
  document.querySelector("#match-title").textContent = result.title;
  document.querySelector("#match-message").textContent = result.message;
  // A held bill that somebody has accepted keeps its findings — they are still true — but it is
  // no longer stopping anything, and the badge has to say so or the screen reads as unresolved.
  const stopping = !result.cleared;
  const badge = document.querySelector("#match-outcome");
  badge.textContent = stopping ? result.outcome.replace(/_/g, " ").toLowerCase() : result.outcome === "HOLD_FOR_APPROVAL" ? "accepted" : "ok to record";
  badge.className = `pill ${stopping ? "hold" : "done"}`;

  const body = document.querySelector("#match-rows");
  body.replaceChildren();
  result.rows.forEach((row) => {
    const tr = document.createElement("tr");
    tr.append(
      cell(row.description), cell(row.ordered), cell(row.received), cell(row.accepted),
      cell(row.rejected), cell(row.invoiced),
      cell(row.orderedRate === null ? null : money(row.orderedRate)),
      cell(row.invoicedRate === null ? null : money(row.invoicedRate)),
    );
    body.append(tr);
  });

  // Every finding, worst first, with the field it is about — that is the acceptance criterion.
  const list = document.querySelector("#match-findings");
  list.replaceChildren();
  result.findings.forEach((finding) => {
    const row = document.createElement("div");
    row.className = "activity-row";
    const icon = document.createElement("span");
    icon.className = `activity-icon ${finding.severity === "HOLD" ? "red" : finding.severity === "REVIEW" ? "amber" : "blue"}`;
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = finding.severity === "HOLD" ? "!" : finding.severity === "REVIEW" ? "?" : "i";
    const description = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = finding.message;
    const detail = document.createElement("small");
    const parts = [`Field: ${finding.field}`];
    if (finding.orderSays) parts.push(`order says ${finding.orderSays}`);
    if (finding.receiptSays) parts.push(`delivery says ${finding.receiptSays}`);
    if (finding.invoiceSays) parts.push(`bill says ${finding.invoiceSays}`);
    if (finding.difference) parts.push(`difference ${finding.difference}`);
    detail.textContent = parts.join(" · ");
    description.append(title, detail);
    row.append(icon, description);
    list.append(row);
  });

  document.querySelector("#approve-form").hidden = result.outcome !== "HOLD_FOR_APPROVAL" || result.cleared;
  refreshStock(result.stock);
}

const submitStep = (selector, handler) => {
  const form = document.querySelector(selector);
  if (form) form.addEventListener("submit", async (event) => { event.preventDefault(); await handler(form); });
};

submitStep("#order-form", async (form) => {
  try {
    const result = await api("/api/purchase-orders", { method: "POST", body: JSON.stringify(formValues(form)) });
    showStep("#order-result", result.message, false);
    refreshStock(result.stock);
  } catch (error) { showStep("#order-result", error.message, true); }
});

submitStep("#receipt-form", async (form) => {
  try {
    const result = await api("/api/goods-receipts", { method: "POST", body: JSON.stringify(formValues(form)) });
    showStep("#receipt-result", result.message, false);
    refreshStock(result.stock);
    await refreshDocumentLists();
  } catch (error) { showStep("#receipt-result", error.message, true); }
});

submitStep("#match-form", async (form) => {
  state.lastMatchInput = formValues(form);
  try {
    renderMatch(await api("/api/purchases/match", { method: "POST", body: JSON.stringify(state.lastMatchInput) }));
  } catch (error) {
    showDialog({ title: "Nothing was checked", message: error.message }, "failed");
  }
});

submitStep("#approve-form", async (form) => {
  const reason = formValues(form).reason;
  try {
    renderMatch(await api("/api/purchases/match/approve", { method: "POST", body: JSON.stringify({ ...state.lastMatchInput, reason }) }));
  } catch (error) {
    showDialog({ title: "Nothing was accepted", message: error.message }, "failed");
  }
});


// ---------------------------------------------------------- issue #19: supplier risk warnings
//
// Every warning is shown with the evidence under it — the source, what it said, the date it took
// effect and the date we read it. That is the acceptance criterion, and it is also the only
// honest way to show this: the buyer draws their own conclusion from facts, and the product
// never tells them what sort of business someone is.

const SOURCE_NAMES = {
  GST_PORTAL: "The GST department",
  IMS_GSTR2B: "Your GSTR-2B",
  OUR_RECORDS: "Your own books",
  SUPPLIER_DOCUMENT: "The supplier's own bill",
};

function evidenceLine(evidence) {
  const bits = [SOURCE_NAMES[evidence.source] ?? evidence.source];
  if (evidence.effectiveFrom) bits.push(`in force from ${evidence.effectiveFrom}`);
  if (evidence.observedAt) bits.push(`read on ${String(evidence.observedAt).slice(0, 10)}`);
  if (evidence.ageInDays !== null && evidence.ageInDays > 0) bits.push(`${evidence.ageInDays} days old`);
  if (evidence.stale) bits.push("may be out of date");
  if (evidence.unavailable) bits.push(`could not be reached (${evidence.unavailable})`);
  return bits.join(" · ");
}

function renderSupplier(result) {
  const panel = document.querySelector("#supplier-panel");
  panel.hidden = false;
  document.querySelector("#supplier-result-title").textContent = result.title;
  document.querySelector("#supplier-result-message").textContent = result.message;
  // The badge says the same thing as the lights, in the fewest words. "information" told a
  // shopkeeper nothing, which is what prompted issue #99.
  const badge = document.querySelector("#supplier-level");
  const stopping = result.level === "SERIOUS" && !result.cleared;
  const worstLight = (result.lights || []).some((light) => light.colour === "RED") ? "RED"
    : (result.lights || []).some((light) => light.colour === "AMBER") ? "AMBER"
    : (result.lights || []).some((light) => light.colour === "GREY") ? "GREY" : "GREEN";
  badge.textContent = stopping ? "check before paying"
    : result.level === "SERIOUS" ? "accepted"
    : worstLight === "AMBER" ? "worth a look"
    : worstLight === "GREY" ? "could not check fully"
    : "looks fine";
  badge.className = `pill ${stopping ? "hold" : worstLight === "AMBER" ? "warn" : "done"}`;

  // Issue #99 — two lights, before the detail. Someone who reads nothing else must still get
  // the answer, and must be able to tell the government's verdict from our own.
  const lights = document.querySelector("#supplier-lights");
  lights.replaceChildren();
  (result.lights || []).forEach((light) => {
    const card = document.createElement("div");
    card.className = `light-card ${light.colour.toLowerCase()}`;
    const top = document.createElement("div");
    top.className = "light-top";
    const dot = document.createElement("span");
    dot.className = "light-dot";
    dot.setAttribute("aria-hidden", "true");
    const title = document.createElement("span");
    title.className = "light-title";
    title.textContent = light.title;
    top.append(dot, title);
    const headline = document.createElement("strong");
    headline.className = "light-headline";
    // Screen readers get the colour in words; sighted users get it as a colour.
    headline.textContent = light.headline;
    const detail = document.createElement("span");
    detail.className = "light-detail";
    detail.textContent = light.detail;
    card.append(top, headline, detail);
    lights.append(card);
  });

  const list = document.querySelector("#supplier-warnings");
  list.replaceChildren();
  result.warnings.forEach((warning) => {
    const row = document.createElement("div");
    row.className = "activity-row";
    const icon = document.createElement("span");
    icon.className = `activity-icon ${warning.level === "SERIOUS" ? "red" : warning.level === "CAUTION" ? "amber" : "blue"}`;
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = warning.level === "SERIOUS" ? "!" : warning.level === "CAUTION" ? "?" : "i";
    const body = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = warning.message;
    const action = document.createElement("small");
    action.textContent = `What to do: ${warning.action}`;
    body.append(title, action);
    // The evidence, spelled out, is the point of the whole screen.
    warning.evidence.forEach((evidence) => {
      const line = document.createElement("small");
      line.className = "evidence-line";
      line.textContent = `${evidence.statement} — ${evidenceLine(evidence)}`;
      body.append(line);
    });
    row.append(icon, body);
    list.append(row);
  });

  const sources = document.querySelector("#supplier-sources");
  sources.replaceChildren();
  result.sources.forEach((source) => {
    const row = document.createElement("div");
    row.className = "activity-row";
    const icon = document.createElement("span");
    icon.className = `activity-icon ${source.answered && !source.stale ? "green" : "amber"}`;
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = source.answered && !source.stale ? "✓" : "—";
    const body = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = SOURCE_NAMES[source.source] ?? source.source;
    const note = document.createElement("small");
    note.textContent = source.note;
    body.append(title, note);
    row.append(icon, body);
    sources.append(row);
  });

  document.querySelector("#supplier-ack-form").hidden = result.level === "INFORMATION" || result.cleared;
}

submitStep("#supplier-form", async (form) => {
  state.lastSupplierInput = formValues(form);
  try {
    renderSupplier(await api("/api/suppliers/check", { method: "POST", body: JSON.stringify(state.lastSupplierInput) }));
  } catch (error) {
    showDialog({ title: "Nothing was checked", message: error.message }, "failed");
  }
});

submitStep("#supplier-ack-form", async (form) => {
  try {
    renderSupplier(await api("/api/suppliers/check/acknowledge", {
      method: "POST",
      body: JSON.stringify({ ...state.lastSupplierInput, reason: formValues(form).reason }),
    }));
  } catch (error) {
    showDialog({ title: "Nothing was accepted", message: error.message }, "failed");
  }
});

// The invented registrations this screen can be tried against, so every branch can be seen.
async function loadSupplierChoices() {
  const select = document.querySelector("#supplier-choices");
  if (!select) return;
  try {
    const { choices } = await api("/api/suppliers/choices");
    choices.forEach((choice) => {
      const option = document.createElement("option");
      option.value = choice.gstin;
      option.dataset.name = choice.name;
      option.textContent = choice.label;
      select.append(option);
    });
    select.addEventListener("change", (event) => {
      const option = event.target.selectedOptions[0];
      if (!option?.value) return;
      const form = document.querySelector("#supplier-form");
      form.elements.gstin.value = option.value;
      form.elements.party.value = option.dataset.name ?? "";
    });
  } catch { /* the picker is a convenience; the form works without it */ }
}


// ------------------------------------------------------------- issue #42: what the plan covers
//
// The screen opens with the promise and only then shows the numbers, because the fear a pricing
// page creates is "what will they switch off?" — and the answer here is "nothing that matters".

let planState = null;

function planUsageRow(total) {
  const limit = total.limit === null ? "no limit" : `${total.used} of ${total.limit}`;
  const row = document.createElement("div");
  row.className = "activity-row";
  const icon = document.createElement("span");
  // Amber only when the end is actually near. A limit of one is not "nearly used up" at zero used.
  const tight = total.limit !== null && total.limit >= 10 && total.remaining <= total.limit * 0.1;
  icon.className = `activity-icon ${total.limit === null ? "blue" : tight ? "amber" : "green"}`;
  icon.textContent = total.limit === null ? "∞" : tight ? "!" : "✓";
  const body = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = `${t(total.label)} — ${limit}`;
  const detail = document.createElement("p");
  detail.textContent = total.limit === null
    ? "Your plan does not limit this."
    : `${total.remaining} left.`;
  body.append(title, detail);
  row.append(icon, body);
  return row;
}

// ---------------------------------------------------------- issue #47: asking it to do the work
//
// The screen never offers a "do it" button before it has shown the whole list. Every step names
// the customer and the amount, so a wrong party or a wrong figure is visible in the sentence a
// person reads rather than buried in what happens afterwards.

const agentState = { plan: null };

const AGENT_EXAMPLES = [
  "Find ABC Traders' unpaid invoices and send reminders",
  "Who owes me money?",
  "Stop reminding ABC Traders",
  "Transfer ₹50,000 to Shree Ram Steels",
];

function agentStepRow(step) {
  const row = document.createElement("div");
  row.className = "activity-row";
  const icon = document.createElement("span");
  const writes = step.kind === "WRITE";
  icon.className = `activity-icon ${step.executability === "PREPARE_ONLY" ? "amber" : writes ? "green" : "blue"}`;
  icon.textContent = writes ? "✎" : "👁";
  const body = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = step.amount === null ? step.tool : `${step.tool} · ${money(step.amount)}`;
  const detail = document.createElement("p");
  detail.textContent = t(step.describe);
  body.append(title, detail);
  row.append(icon, body);
  return row;
}

function planCheckRow(check) {
  const row = document.createElement("div");
  row.className = "activity-row";
  const icon = document.createElement("span");
  icon.className = `activity-icon ${check.outcome === "ALLOWED" ? "green" : "amber"}`;
  icon.textContent = check.outcome === "ALLOWED" ? "✓" : "!";
  const body = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = check.capability.replaceAll(".", " ").replaceAll("_", " ");
  const detail = document.createElement("p");
  detail.textContent = t(check.reason);
  body.append(title, detail);
  row.append(icon, body);
  return row;
}

function agentRefusalRow(refusal) {
  const row = document.createElement("div");
  row.className = "activity-row";
  const icon = document.createElement("span");
  icon.className = "activity-icon amber";
  icon.textContent = "✗";
  const body = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = refusal.code.replaceAll("_", " ").toLowerCase();
  const detail = document.createElement("p");
  detail.textContent = t(refusal.reason);
  body.append(title, detail);
  row.append(icon, body);
  return row;
}

function renderPlan(data) {
  planState = data;
  document.querySelector("#plan-name").textContent = t(data.plan.name);
  document.querySelector("#plan-state").textContent = t(data.stateWords);
  document.querySelector("#plan-pill").textContent = data.state.replaceAll("_", " ").toLowerCase();
  document.querySelector("#plan-promise").textContent = t(data.promise);
  document.querySelector("#plan-usage").replaceChildren(...data.usage.map(planUsageRow));
  // Essential first: the point of the list is what cannot be taken away.
  document.querySelector("#plan-checks").replaceChildren(
    ...[...data.checks].sort((a, b) => Number(b.essential) - Number(a.essential)).map(planCheckRow),
  );

  document.querySelector("#plan-options").replaceChildren(...data.plans.map((plan) => {
    const row = document.createElement("div");
    row.className = "activity-row";
    const icon = document.createElement("span");
    icon.className = `activity-icon ${plan.id === data.plan.id ? "green" : "blue"}`;
    icon.textContent = plan.id === data.plan.id ? "✓" : "·";
    const body = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = `${t(plan.name)} — ${money(plan.monthlyPrice)} a month`;
    const detail = document.createElement("p");
    detail.textContent = t(plan.description);
    body.append(title, detail);
    row.append(icon, body);
    if (plan.id !== data.plan.id) {
      const choose = document.createElement("button");
      choose.type = "button";
      choose.className = "secondary-button";
      choose.textContent = t(plan.name);
      choose.addEventListener("click", async () => {
        try {
          const result = await api("/api/subscription/plan", { method: "POST", body: JSON.stringify({ planId: plan.id, reason: "Chosen on the plan screen" }) });
          showDialog({ title: result.title, message: result.message }, "recorded");
        } catch (error) { showDialog({ title: "Nothing was changed", message: error.message }, "failed"); }
        loadPlan();
      });
      row.append(choose);
    }
    return row;
  }));

  document.querySelector("#plan-invoices").replaceChildren(...(data.invoices.length === 0
    ? [simpleRow("Nothing yet.", "We have not invoiced you for this month.")]
    : data.invoices.map((invoice) => simpleRow(
        `${invoice.period} · ${money(invoice.total)} · ${invoice.state}`,
        invoice.failureReason ?? `Net ${money(invoice.net)} + GST ${money(invoice.gst)}`,
      ))));
}

// ------------------------------------------------ issue #343: the people in this business

const ROLE_WORD = { owner: "roleOwner", admin: "roleAdmin", accountant: "roleAccountant", staff: "roleStaff", viewer: "roleViewer", custom: "roleCustom" };

async function teamAct(path, body) {
  const error = document.querySelector("#team-error");
  error.textContent = "";
  try { renderTeam(await api(path, { method: "POST", body: JSON.stringify(body) })); }
  catch (failure) { error.textContent = failure.message; }
}

function renderTeam(data) {
  const list = document.querySelector("#team-members");
  const words = copy[state.locale];
  list.replaceChildren(...data.members.map((member) => {
    const row = document.createElement("li");
    const name = document.createElement("strong");
    name.textContent = member.you ? `${member.name} (${words.teamYou})` : member.name;
    row.append(name);
    if (member.you || member.role === "owner") {
      const role = document.createElement("span");
      role.textContent = ` · ${words[ROLE_WORD[member.role]]}`;
      row.append(role);
      return row;
    }
    const role = document.createElement("select");
    role.setAttribute("aria-label", `${words.teamRole}: ${member.name}`);
    for (const value of ["admin", "accountant", "staff", "viewer"]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = words[ROLE_WORD[value]];
      option.selected = value === member.role;
      role.append(option);
    }
    role.addEventListener("change", () => teamAct("/api/team/role", { userId: member.userId, role: role.value }));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "text-button";
    remove.textContent = words.teamRemove;
    remove.addEventListener("click", () => { if (confirm(words.teamConfirmRemove.replace("{name}", member.name))) teamAct("/api/team/remove", { userId: member.userId }); });
    const handOver = document.createElement("button");
    handOver.type = "button";
    handOver.className = "text-button";
    handOver.textContent = words.teamHandOver;
    handOver.addEventListener("click", () => { if (confirm(words.teamConfirmHandOver.replace("{name}", member.name))) teamAct("/api/team/transfer", { userId: member.userId }); });
    row.append(" ", role, " ", remove, " ", handOver);
    return row;
  }));
}

async function loadTeam() {
  const error = document.querySelector("#team-error");
  if (!error) return;
  error.textContent = "";
  try { renderTeam(await api("/api/team")); } catch (failure) { error.textContent = failure.message; }
}

document.querySelector("#team-invite")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const shown = document.querySelector("#team-link");
  try {
    const result = await api("/api/team/invite", { method: "POST", body: JSON.stringify(formValues(form)) });
    shown.textContent = copy[state.locale].teamLinkMade.replace("{address}", result.invitation.address).replace("{link}", `${location.origin}${result.link}`);
    shown.hidden = false;
    form.reset();
  } catch (failure) { shown.textContent = failure.message; shown.hidden = false; }
});

document.querySelector("#team-leave")?.addEventListener("click", async () => {
  if (!confirm(copy[state.locale].teamConfirmLeave)) return;
  try {
    await api("/api/team/leave", { method: "POST" });
    state.signedIn = false;
    storage?.removeItem("karobar.signedIn");
    location.hash = "dashboard";
    location.reload();
  } catch (failure) { document.querySelector("#team-error").textContent = failure.message; }
});

async function loadPlan() {
  try {
    renderPlan(await api("/api/subscription"));
  } catch (error) {
    const state = document.querySelector("#plan-state");
    if (state) state.textContent = error.message;
  }
}

document.querySelector("#plan-pay")?.addEventListener("click", async () => {
  try {
    const result = await api("/api/subscription/pay", { method: "POST", body: JSON.stringify({}) });
    showDialog({ title: result.title, message: result.message }, "recorded");
  } catch (error) { showDialog({ title: "Nothing was paid", message: error.message }, "failed"); }
  loadPlan();
});

function renderAgentPlan(plan) {
  agentState.plan = plan;
  document.querySelector("#agent-panel").hidden = false;
  document.querySelector("#agent-summary").textContent = t(plan.summary);
  document.querySelector("#agent-intent").textContent = plan.intent.replaceAll("_", " ").toLowerCase();
  const flag = document.querySelector("#agent-flag");
  flag.hidden = !plan.instructionFlag;
  if (plan.instructionFlag) {
    document.querySelector("#agent-flag-text").textContent =
      `That request tried to give me instructions ("${plan.instructionFlag}"). It is on the record, and it changed nothing.`;
  }
  document.querySelector("#agent-steps").replaceChildren(...plan.steps.map(agentStepRow));
  document.querySelector("#agent-refusals").replaceChildren(...plan.refusals.map(agentRefusalRow));
  document.querySelector("#agent-report").replaceChildren();
  // The button exists only when there is something to carry out.
  document.querySelector("#agent-actions").hidden = plan.steps.length === 0;
}

function renderAgentReport(report) {
  document.querySelector("#agent-actions").hidden = true;
  document.querySelector("#agent-report").replaceChildren(
    ...report.steps.map((step) => {
      const row = document.createElement("div");
      row.className = "activity-row";
      const icon = document.createElement("span");
      icon.className = `activity-icon ${step.state === "DONE" ? "green" : step.state === "FAILED" ? "amber" : "blue"}`;
      icon.textContent = step.state === "DONE" ? "✓" : step.state === "FAILED" ? "!" : "·";
      const body = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = `${step.state} · ${step.tool}`;
      const detail = document.createElement("p");
      detail.textContent = t(step.statement ?? step.failure ?? step.describe);
      body.append(title, detail);
      row.append(icon, body);
      return row;
    }),
    ...report.handedBack.map((line) => {
      const row = document.createElement("div");
      row.className = "activity-row";
      const icon = document.createElement("span");
      icon.className = "activity-icon amber";
      icon.textContent = "→";
      const body = document.createElement("div");
      const detail = document.createElement("p");
      detail.textContent = t(line);
      body.append(detail);
      row.append(icon, body);
      return row;
    }),
  );
}

async function loadAgentCapabilities() {
  const list = document.querySelector("#agent-capabilities");
  if (!list) return;
  try {
    const { tools } = await api("/api/agent/capabilities");
    list.replaceChildren(...tools.map((tool) => {
      const row = document.createElement("div");
      row.className = "activity-row";
      const icon = document.createElement("span");
      icon.className = `activity-icon ${tool.executability === "PREPARE_ONLY" ? "amber" : tool.kind === "WRITE" ? "green" : "blue"}`;
      icon.textContent = tool.kind === "WRITE" ? "✎" : "👁";
      const body = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = t(tool.summary);
      const detail = document.createElement("p");
      detail.textContent = tool.executability === "PREPARE_ONLY"
        ? "I can only prepare this one; you finish it."
        : tool.kind === "WRITE" ? "I ask you first, every time." : "Reading only — this changes nothing.";
      body.append(title, detail);
      row.append(icon, body);
      return row;
    }));
  } catch { /* the list is a convenience; the form works without it */ }

  const examples = document.querySelector("#agent-examples");
  if (examples && examples.childElementCount === 0) {
    examples.replaceChildren(...AGENT_EXAMPLES.map((example) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary-button";
      button.textContent = example;
      button.addEventListener("click", () => { document.querySelector("#agent-request").value = example; });
      return button;
    }));
  }
}

submitStep("#agent-form", async () => {
  const request = document.querySelector("#agent-request").value.trim();
  if (request === "") return;
  try {
    renderAgentPlan(await api("/api/agent/plan", { method: "POST", body: JSON.stringify({ request }) }));
  } catch (error) {
    showDialog({ title: "Nothing was planned", message: error.message }, "failed");
  }
});

document.querySelector("#agent-do-it")?.addEventListener("click", async () => {
  const plan = agentState.plan;
  if (plan === null) return;
  try {
    // Approving and carrying out are two calls, because they are two decisions: the first pins
    // exactly what was on the screen, and the second is refused if the books moved since.
    if (plan.needsApproval) {
      await api("/api/agent/approve", { method: "POST", body: JSON.stringify({ planId: plan.id, fingerprint: plan.fingerprint }) });
    }
    const result = await api("/api/agent/execute", {
      method: "POST",
      body: JSON.stringify({ planId: plan.id, fingerprint: plan.fingerprint, idempotencyKey: plan.id }),
    });
    renderAgentReport(result.report);
    showDialog({ title: result.title, message: result.message }, "recorded");
  } catch (error) {
    showDialog({ title: "Nothing was done", message: error.message }, "failed");
  }
});


// ------------------------------------------------------ issue #23: reminders and collections
//
// The screen leads with the decision for every open bill, not with a "send reminders" button. A
// bill left alone is shown as prominently as one being chased, with the sentence that explains it,
// because the owner's next question is always about the customer who was *not* reminded.

function reminderRow(candidate) {
  const row = document.createElement("div");
  row.className = "activity-row";
  const icon = document.createElement("span");
  icon.className = `activity-icon ${candidate.decision === "SEND" ? "green" : candidate.decision === "ESCALATE" ? "amber" : "blue"}`;
  icon.textContent = candidate.decision === "SEND" ? "→" : candidate.decision === "ESCALATE" ? "!" : "·";
  const body = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = `${candidate.partyName} · ${candidate.bill} · ${money(candidate.outstanding)}`;
  const detail = document.createElement("p");
  detail.textContent = t(candidate.explanation);
  body.append(title, detail);
  row.append(icon, body);
  if (candidate.decision !== "SKIP") {
    const send = document.createElement("button");
    send.type = "button";
    send.className = "secondary-button";
    send.textContent = copy[state.locale].remindersSend;
    send.addEventListener("click", () => sendOneReminder(candidate.documentId));
    row.append(send);
  }
  return row;
}

function sentRow(reminder) {
  const row = document.createElement("div");
  row.className = "activity-row";
  const icon = document.createElement("span");
  icon.className = `activity-icon ${reminder.state === "SENT" ? "green" : reminder.state === "FAILED" ? "amber" : "blue"}`;
  icon.textContent = reminder.state === "SENT" ? "✓" : reminder.state === "FAILED" ? "!" : "·";
  const body = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = `${reminder.bill} · ${reminder.party} · ${reminder.level} · ${reminder.channel} · ${reminder.state}`;
  const detail = document.createElement("p");
  detail.textContent = reminder.failureReason ?? t(reminder.message);
  body.append(title, detail);
  row.append(icon, body);
  if (reminder.state === "FAILED") {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "secondary-button";
    retry.textContent = copy[state.locale].remindersRetry;
    retry.addEventListener("click", async () => {
      try {
        await api("/api/reminders/retry", { method: "POST", body: JSON.stringify({ reminderId: reminder.id }) });
      } catch (error) { showDialog({ title: "Nothing was sent", message: error.message }, "failed"); }
      loadReminders();
    });
    row.append(retry);
  }
  return row;
}

function simpleRow(title, detail) {
  const row = document.createElement("div");
  row.className = "activity-row";
  const icon = document.createElement("span");
  icon.className = "activity-icon blue";
  icon.textContent = "·";
  const body = document.createElement("div");
  const strong = document.createElement("strong");
  strong.textContent = title;
  const paragraph = document.createElement("p");
  paragraph.textContent = detail;
  body.append(strong, paragraph);
  row.append(icon, body);
  return row;
}

function renderReminders(data) {
  state.reminders = data;
  document.querySelector("#reminders-summary").textContent = t(data.summary);
  document.querySelector("#reminders-plan").replaceChildren(...data.candidates.map(reminderRow));

  // Issue #237 — every bill is shown with the customer it belongs to; a promise or a dispute is
  // recorded against that customer, whoever it is.
  const choices = document.querySelector("#reminders-bill-choices");
  if (choices) {
    const chosen = choices.value;
    const open = data.candidates.filter((candidate) => candidate.reason !== "SETTLED");
    choices.replaceChildren(...open.map((candidate) => {
      const option = document.createElement("option");
      option.value = candidate.documentId;
      option.textContent = `${candidate.bill} · ${candidate.partyName} · ${money(candidate.outstanding)}`;
      return option;
    }));
    if ([...choices.options].some((option) => option.value === chosen)) choices.value = chosen;
  }
  renderReminderCustomers();

  document.querySelector("#reminders-promises").replaceChildren(
    ...data.promises.map((promise) => simpleRow(`${promise.party} · ${promise.outcome} · ${money(promise.amount)}`, t(promise.explanation))),
  );
  const history = document.querySelector("#reminders-history");
  history.replaceChildren(...(data.history.length === 0
    ? [simpleRow(copy[state.locale].remindersNothing, "")]
    : data.history.map(sentRow)));
  const outbox = document.querySelector("#reminders-outbox");
  outbox.replaceChildren(...(data.outbox.length === 0
    ? [simpleRow(copy[state.locale].remindersNothing, "")]
    : data.outbox.map((message) => simpleRow(`${message.channel} → ${message.to}`, message.body))));
}

/** Issue #237 — stopping or restarting reminders is for one chosen customer, from the customer list. */
function renderReminderCustomers() {
  const select = document.querySelector("#reminders-party-choices");
  if (!select) return;
  const chosen = select.value;
  select.replaceChildren(...catalogue.customers.map((customer) => {
    const option = document.createElement("option");
    option.value = customer.id;
    option.textContent = customer.name;
    return option;
  }));
  if ([...select.options].some((option) => option.value === chosen)) select.value = chosen;
}

async function loadReminders() {
  try {
    renderReminders(await api("/api/reminders"));
  } catch (error) {
    const summary = document.querySelector("#reminders-summary");
    if (summary) summary.textContent = error.message;
  }
}

async function sendOneReminder(documentId) {
  try {
    const result = await api("/api/reminders/send", { method: "POST", body: JSON.stringify({ documentId }) });
    showDialog({ title: result.title, message: result.message }, "recorded");
  } catch (error) {
    showDialog({ title: "Nothing was sent", message: error.message }, "failed");
  }
  loadReminders();
}

document.querySelector("#reminders-send-all")?.addEventListener("click", async () => {
  try {
    const result = await api("/api/reminders/send-all", { method: "POST", body: JSON.stringify({}) });
    showDialog({ title: result.title, message: result.message }, "recorded");
  } catch (error) { showDialog({ title: "Nothing was sent", message: error.message }, "failed"); }
  loadReminders();
});

submitStep("#reminders-note-form", async (form) => {
  const values = formValues(form);
  try {
    const result = values.kind === "dispute"
      ? await api("/api/reminders/dispute", { method: "POST", body: JSON.stringify({ documentId: values.documentId, reason: values.note || "The customer says something on this bill is wrong." }) })
      : await api("/api/reminders/promise", { method: "POST", body: JSON.stringify({ documentId: values.documentId, amount: values.amount, promisedOn: values.promisedOn, note: values.note }) });
    showDialog({ title: result.title, message: result.message }, "recorded");
  } catch (error) { showDialog({ title: "Nothing was recorded", message: error.message }, "failed"); }
  loadReminders();
});

submitStep("#reminders-stop-form", async (form) => {
  try {
    const result = await api("/api/reminders/stop", { method: "POST", body: JSON.stringify(formValues(form)) });
    showDialog({ title: result.title, message: result.message }, "recorded");
  } catch (error) { showDialog({ title: "Nothing was changed", message: error.message }, "failed"); }
  loadReminders();
});

document.querySelector("#reminders-resume")?.addEventListener("click", async () => {
  try {
    const partyId = document.querySelector("#reminders-party-choices")?.value ?? "";
    const result = await api("/api/reminders/resume", { method: "POST", body: JSON.stringify({ partyId }) });
    showDialog({ title: result.title, message: result.message }, "recorded");
  } catch (error) { showDialog({ title: "Nothing was changed", message: error.message }, "failed"); }
  loadReminders();
});


// ------------------------------------------------ issue #26: e-invoice applicability and the IRN
//
// The screen leads with the decision, not with a send button: most bills need no IRN, and the
// product's job is to say so with the rule that decided it. Sending is offered only once the
// answer is "yes", and a registered e-invoice is shown as a different thing from the bill itself.

function detailRow(label, value, note) {
  const row = document.createElement("div");
  row.className = "activity-row";
  const icon = document.createElement("span");
  icon.className = "activity-icon blue";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "·";
  const body = document.createElement("div");
  const strong = document.createElement("strong");
  strong.textContent = `${label}: ${value}`;
  body.append(strong);
  if (note) {
    const small = document.createElement("small");
    small.textContent = note;
    body.append(small);
  }
  row.append(icon, body);
  return row;
}

function renderEInvoice(result, mode) {
  const panel = document.querySelector("#einvoice-panel");
  panel.hidden = false;
  document.querySelector("#einvoice-result-title").textContent = result.title;
  document.querySelector("#einvoice-result-message").textContent = result.message;

  const badge = document.querySelector("#einvoice-status");
  const status = mode === "preview" ? result.outcome : result.status;
  badge.textContent = String(status).replace(/_/g, " ").toLowerCase();
  badge.className = `pill ${status === "REGISTERED" ? "done" : status === "FAILED" || status === "CANNOT_DECIDE" ? "hold" : status === "APPLICABLE" ? "warn" : "done"}`;

  const detail = document.querySelector("#einvoice-detail");
  detail.replaceChildren();

  if (mode === "preview") {
    detail.append(detailRow("The rule that decided it", result.ruleId, result.sourceRef || undefined));
    detail.append(detailRow("Why", result.reason));
    if (result.expectedIrn) detail.append(detailRow("The number this bill will get", `${result.expectedIrn.slice(0, 24)}…`, "Worked out before sending, and checked against what comes back."));
    // Issue #236 — a date only when the 30-day limit applies to this business; otherwise the sentence.
    if (result.reportableUntil) detail.append(detailRow("Must be reported by", result.reportableUntilLabel ?? result.reportableUntil));
    else if (result.deadline) detail.append(detailRow("Deadline", result.deadline.message));
    result.problems.forEach((problem) => detail.append(detailRow("Needs fixing", problem.message, problem.field)));
  } else {
    detail.append(detailRow("The rule that decided it", result.applicability.ruleId, result.applicability.sourceRef || undefined));
    if (result.irn) {
      detail.append(detailRow("E-invoice number (IRN)", result.irn));
      detail.append(detailRow("Government acknowledgement", `${result.ackNumber} on ${result.ackDate}`));
      detail.append(detailRow("Signed QR code", `${String(result.signedQrCode).slice(0, 32)}…`, "Kept exactly as the government sent it. This goes on the customer's copy."));
    }
    if (result.cancellableUntil) detail.append(detailRow("Can be cancelled until", result.cancellableUntilLabel ?? result.cancellableUntil, "The portal allows 24 hours, and not a minute more."));
    if (result.failure) detail.append(detailRow("What went wrong", result.failure.message, result.failure.retryable ? "Worth trying again." : "Trying again unchanged will not help."));
  }

  // Only offer what makes sense for where this bill actually is.
  const applicable = mode === "preview" ? result.outcome === "APPLICABLE" : result.applicability.outcome === "APPLICABLE";
  const registered = mode !== "preview" && result.status === "REGISTERED";
  document.querySelector("#einvoice-send").hidden = !(applicable && !registered && (mode === "preview" ? result.ready : result.status === "FAILED"));
  document.querySelector("#einvoice-offline").hidden = !applicable;
  document.querySelector("#einvoice-reconcile").hidden = !(mode !== "preview" && result.status === "FAILED");
  document.querySelector("#einvoice-cancel-form").hidden = !registered;
}

// Issue #239 — the bill the detail panel is showing, chosen from the list. Nothing is typed here.
const einvoiceState = { selected: "" };
const eInvoiceInput = () => ({ invoice: einvoiceState.selected });

async function openEInvoice(invoiceId, focusCancel = false) {
  einvoiceState.selected = invoiceId;
  try {
    const result = await api("/api/einvoices/preview", { method: "POST", body: JSON.stringify(eInvoiceInput()) });
    // A bill already sent is shown as it stands with the government, not as "Ready to send".
    if (result.record) renderEInvoice(result.record, "record"); else renderEInvoice(result, "preview");
    document.querySelector("#einvoice-panel").scrollIntoView?.({ block: "start" });
    if (focusCancel) document.querySelector('#einvoice-cancel-form [name="reason"]')?.focus();
  } catch (error) {
    showDialog({ title: "Nothing was checked", message: error.message }, "failed");
  }
}

const eInvoiceAction = (selector, path, extra = () => ({})) => {
  const button = document.querySelector(selector);
  if (!button) return;
  button.addEventListener("click", async () => {
    try {
      renderEInvoice(await api(path, { method: "POST", body: JSON.stringify({ ...eInvoiceInput(), ...extra() }) }), "record");
      await refreshDocumentLists();
    } catch (error) {
      showDialog({ title: "Nothing was sent", message: error.message }, "failed");
    }
  });
};

eInvoiceAction("#einvoice-send", "/api/einvoices/register");
eInvoiceAction("#einvoice-reconcile", "/api/einvoices/reconcile");

submitStep("#einvoice-cancel-form", async (form) => {
  try {
    renderEInvoice(await api("/api/einvoices/cancel", {
      method: "POST", body: JSON.stringify({ ...eInvoiceInput(), ...formValues(form) }),
    }), "record");
    await refreshDocumentLists();
  } catch (error) {
    showDialog({ title: "Nothing was cancelled", message: error.message }, "failed");
  }
});

// The offline file matters most when the portal is down and a bill still has to go out.
document.querySelector("#einvoice-offline")?.addEventListener("click", async () => {
  try {
    const result = await api("/api/einvoices/offline", { method: "POST", body: JSON.stringify(eInvoiceInput()) });
    showDialog({
      title: "File ready",
      message: `${result.fileName} — this is what would be sent. It is not an e-invoice until the government gives it a number.`,
      effects: String(result.json).split("\n").slice(0, 12),
    }, "recorded");
  } catch (error) {
    showDialog({ title: "Nothing to export", message: error.message }, "failed");
  }
});

/**
 * Issue #239 — every issued bill, whether it needs an e-invoice number (decided by the app, with
 * the reason), and where it stands with the government, with Try again and Cancel where they apply.
 */
function renderEInvoiceList(invoices) {
  const list = document.querySelector("#einvoice-list");
  if (!list) return;
  const text = copy[state.locale];
  document.querySelector("#einvoice-ask").hidden = !invoices.some((invoice) => invoice.askTurnover);
  if (invoices.length === 0) {
    const empty = document.createElement("p");
    empty.className = "bill-choice-empty";
    empty.textContent = text.einvoiceNoBills;
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...invoices.map((invoice) => {
    const row = document.createElement("div");
    row.className = "activity-row";
    row.dataset.einvoiceRow = invoice.id;
    const icon = document.createElement("span");
    icon.className = "activity-icon blue";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "✦";
    const badge = document.createElement("span");
    badge.className = `pill ${invoice.needed === "YES" ? (invoice.eInvoiceStatus === "REGISTERED" ? "done" : invoice.eInvoiceStatus === "FAILED" ? "hold" : "warn") : invoice.needed === "NO" ? "done" : "hold"}`;
    badge.textContent = text[invoice.needed === "YES" ? "einvoiceNeedsYes" : invoice.needed === "NO" ? "einvoiceNeedsNo" : "einvoiceNeedsUnknown"];
    const body = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = [invoice.number, invoice.customer, money(invoice.amount)].filter(Boolean).join(" · ");
    const decision = document.createElement("small");
    decision.textContent = invoice.decision;
    const status = document.createElement("small");
    status.textContent = invoice.statusText;
    body.append(strong, badge, decision, status);
    const actions = document.createElement("div");
    actions.className = "row-actions";
    actions.style.margin = ".4rem 0 0";
    const button = (label, handler) => {
      const element = document.createElement("button");
      element.type = "button";
      element.className = "text-button";
      element.textContent = label;
      element.addEventListener("click", handler);
      actions.append(element);
    };
    if (invoice.canRetry) button(text.einvoiceRetry, async () => {
      einvoiceState.selected = invoice.id;
      try {
        renderEInvoice(await api("/api/einvoices/register", { method: "POST", body: JSON.stringify(eInvoiceInput()) }), "record");
        await refreshDocumentLists();
      } catch (error) { showDialog({ title: "Nothing was sent", message: error.message }, "failed"); }
    });
    if (invoice.canCancel) button(text.einvoiceCancelOpen, () => openEInvoice(invoice.id, true));
    if (invoice.needed !== "NO" || invoice.eInvoiceStatus !== "NOT_SENT") button(text.einvoiceOpen, () => openEInvoice(invoice.id));
    if (actions.childElementCount > 0) body.append(actions);
    row.append(icon, body);
    return row;
  }));
}

async function loadIssuedInvoices() {
  try {
    const { invoices } = await apiList("/api/einvoices/invoices", "invoices");
    renderEInvoiceList(invoices);
  } catch { /* the list is a convenience; the rest of the page still works */ }
}

// Issue #239 — "Answer once in Business details": opens that one question, and brings the person
// back to where they were (the sale they were reviewing) once it is saved.
function openTurnoverQuestion() {
  state.returnAfterTurnover = state.view;
  const dialog = document.querySelector("#review-dialog");
  if (dialog.open) dialog.close("cancel");
  openView("business");
  const fieldset = document.querySelector("#business-turnover");
  fieldset?.scrollIntoView?.({ block: "center" });
  fieldset?.querySelector('[name="turnoverBand"]')?.focus();
}
document.querySelectorAll("[data-open-turnover]").forEach((button) => button.addEventListener("click", openTurnoverQuestion));


// ------------------------------------------------ issue #142: quotations and proforma invoices
//
// Which paper comes first, because it decides which questions are asked: a proforma must say what it
// is for and may carry bank details; a quotation asks for neither. Checking uses no number; issuing
// does. A quotation becomes a sale in two steps — the bill is shown with every check a typed sale
// gets, and only then issued — so accepting an old offer never skips the credit or stock checks.

const presaleState = { open: null, list: [], reference: null, saleToken: null };
const PROFORMA_ONLY = ["purpose", "buyerOrderNumber", "paymentTerms", "bankDetails"];

function showPresaleKind() {
  const select = document.querySelector("#presale-kind");
  if (!select) return;
  const proforma = select.value === "PROFORMA";
  document.querySelectorAll("#presale-form [data-proforma-only]").forEach((field) => { field.hidden = !proforma; });
  const purpose = document.querySelector('#presale-form input[name="purpose"]');
  if (purpose) purpose.required = proforma;
  document.querySelector("#presale-kind-rule").textContent = copy[state.locale][proforma ? "presaleProformaRule" : "presaleQuotationRule"];
}

document.querySelector("#presale-kind")?.addEventListener("change", showPresaleKind);

async function openPresale() {
  const form = document.querySelector("#presale-form");
  if (!form) return;
  if (!form.elements.namedItem("date").value) form.elements.namedItem("date").value = dateInput();
  showPresaleKind();
  try {
    await loadPresale();
  } catch (error) {
    showDialog({ title: "This screen could not load", message: error.message }, "failed");
  }
}

const presaleInput = () => {
  const values = formValues(document.querySelector("#presale-form"));
  // A proforma's fields are not sent with a quotation, so nothing typed there earlier leaks onto it.
  if (values.kind !== "PROFORMA") PROFORMA_ONLY.forEach((name) => delete values[name]);
  return { ...values, reference: presaleState.reference };
};

submitStep("#presale-form", async () => {
  // A fresh key per check, reused by the issue that follows it, so a double press issues one document.
  presaleState.reference = crypto.randomUUID();
  try {
    renderPresaleCheck(await api("/api/presale/preview", { method: "POST", body: JSON.stringify(presaleInput()) }));
  } catch (error) {
    showDialog({ title: "Nothing was checked", message: error.message }, "failed");
  }
});

function renderPresaleCheck(result) {
  document.querySelector("#presale-panel").hidden = false;
  document.querySelector("#presale-result-title").textContent = result.title;
  document.querySelector("#presale-result-message").textContent = result.message;
  const badge = document.querySelector("#presale-status");
  badge.textContent = result.state === "problems" ? "needs attention" : "not a tax invoice";
  badge.className = `pill ${result.state === "problems" ? "hold" : "done"}`;
  const detail = document.querySelector("#presale-detail");
  detail.replaceChildren();
  if (result.state === "problems") {
    result.problems.forEach((problem) => detail.append(detailRow("Missing", t(problem.message))));
  } else {
    result.lines.forEach((line) => detail.append(detailRow(line.item, `${line.quantity} · ${money(line.value)}`, `HSN ${line.hsn}${line.rate === null ? "" : ` · GST ${line.rate}%`}`)));
    detail.append(detailRow("Before GST", money(result.value)));
    detail.append(detailRow("GST shown to the customer", money(result.tax), "Worked out the same way as on your bill. It is charged on the bill, not on this paper."));
    detail.append(detailRow("Total", money(result.total)));
    detail.append(detailRow("Place of supply", result.placeOfSupply));
    if (result.validUntil) detail.append(detailRow("Price holds until", result.validUntil));
  }
  document.querySelector("#presale-issue").hidden = result.state === "problems";
}

document.querySelector("#presale-issue")?.addEventListener("click", async () => {
  try {
    const result = await api("/api/presale/issue", { method: "POST", body: JSON.stringify(presaleInput()) });
    document.querySelector("#presale-panel").hidden = true;
    showDialog({ title: result.title, message: result.message }, "recorded");
    await loadPresale();
    await openPresaleDocument(result.document.id);
  } catch (error) {
    showDialog({ title: "Nothing was issued", message: error.message }, "failed");
  }
});

function presaleStatus(entry) {
  if (entry.state === "CONVERTED") return "Turned into a bill";
  if (entry.state === "INVOICED") return `Billed on ${entry.invoice.number}${entry.invoice.differences.length ? ` · ${entry.invoice.differences.length} difference(s) noted` : ""}`;
  if (entry.state === "CANCELLED") return `Cancelled: ${entry.cancelReason}`;
  if (entry.lapsed) return `Validity ended on ${entry.validUntil}`;
  // Not "Open": that is the word on the button beside it.
  const waiting = entry.kind === "QUOTATION" ? "Waiting for the customer" : "Waiting for the bill";
  return entry.validUntil ? `${waiting} · valid until ${entry.validUntil}` : waiting;
}

async function loadPresale() {
  const list = document.querySelector("#presale-list");
  if (!list) return;
  const { documents } = await apiList("/api/presale", "documents");
  presaleState.list = documents;
  list.replaceChildren(...(documents.length === 0 ? [simpleRow(copy[state.locale].presaleNone, "")] : documents.map((entry) => {
    const row = detailRow(
      `${entry.number} · ${t(entry.label)}`,
      money(entry.total),
      [presaleStatus(entry), entry.purpose ? `For: ${entry.purpose}` : ""].filter(Boolean).join(" · "),
    );
    const open = document.createElement("button");
    open.type = "button";
    open.className = "secondary-button";
    open.textContent = copy[state.locale].presaleOpen;
    open.addEventListener("click", () => openPresaleDocument(entry.id));
    row.append(open);
    return row;
  })));
}

async function openPresaleDocument(id) {
  const entry = (presaleState.list ?? []).find((row) => row.id === id);
  if (!entry) return;
  presaleState.open = entry;
  const printed = await api("/api/presale/print", { method: "POST", body: JSON.stringify({ document: id, locale: state.locale }) });
  document.querySelector("#presale-print-panel").hidden = false;
  document.querySelector("#presale-print-title").textContent = `${entry.number} · ${t(entry.label)}`;
  document.querySelector("#presale-frame").srcdoc = printed.html;
  const quotation = entry.kind === "QUOTATION";
  const open = entry.state === "ISSUED";
  document.querySelector("#presale-convert").hidden = !(quotation && (open || entry.state === "CONVERTED"));
  document.querySelector("#presale-convert-button").textContent = copy[state.locale][entry.state === "CONVERTED" ? "presaleOpenBill" : "presaleConvert"];
  document.querySelector("#presale-sale").hidden = true;
  document.querySelector("#presale-link-form").hidden = !(open && !quotation);
  document.querySelector("#presale-cancel-form").hidden = !open;
  document.querySelector("#presale-advances").hidden = quotation;
  document.querySelector("#presale-advance-form").hidden = !(open && !quotation);
  document.querySelector("#presale-refund-form").hidden = true;
  // A fresh key each time the forms are shown, so a double press records the money once.
  ["#presale-advance-form", "#presale-refund-form"].forEach((selector) => {
    const form = document.querySelector(selector);
    form.elements.namedItem("reference").value = crypto.randomUUID();
    if (!form.elements.namedItem("date").value) form.elements.namedItem("date").value = dateInput();
  });
  if (!quotation) await loadAdvances(entry);
  if (open && !quotation) {
    const { invoices } = await apiList("/api/einvoices/invoices", "invoices");
    document.querySelector("#presale-invoices").replaceChildren(...invoices.map((invoice) => Object.assign(document.createElement("option"), {
      value: invoice.id,
      textContent: `${invoice.number} · ${invoice.date} · ${money(invoice.amount)}`,
    })));
  }
  document.querySelector("#presale-print-panel").scrollIntoView({ behavior: "smooth", block: "start" });
}

document.querySelector("#presale-print")?.addEventListener("click", () => {
  document.querySelector("#presale-frame").contentWindow?.print();
});

document.querySelector("#presale-convert-button")?.addEventListener("click", async () => {
  if (!presaleState.open) return;
  try {
    const result = await api("/api/presale/convert", { method: "POST", body: JSON.stringify({ document: presaleState.open.id }) });
    presaleState.saleToken = result.token;
    document.querySelector("#presale-convert").hidden = true;
    document.querySelector("#presale-cancel-form").hidden = true;
    document.querySelector("#presale-sale").hidden = false;
    document.querySelector("#presale-sale-title").textContent = result.title;
    document.querySelector("#presale-sale-message").textContent = result.message;
    const detail = document.querySelector("#presale-sale-detail");
    detail.replaceChildren(detailRow("The bill comes to", money(result.amount)), ...(result.effects ?? []).map((effect) => simpleRow(effect, "")));
    await loadPresale();
  } catch (error) {
    showDialog({ title: "The quotation did not become a bill", message: error.message }, "failed");
  }
});

document.querySelector("#presale-sale-issue")?.addEventListener("click", async () => {
  if (!presaleState.saleToken) return;
  try {
    const result = await api("/api/presale/issue-sale", { method: "POST", body: JSON.stringify({ token: presaleState.saleToken }) });
    document.querySelector("#presale-sale").hidden = true;
    showDialog({ title: result.title, message: result.message }, "recorded");
    await Promise.all([loadPresale(), refreshDocumentLists()]);
  } catch (error) {
    showDialog({ title: "The bill was not issued", message: error.message }, "failed");
  }
});

const presaleAction = (selector, path, failureTitle) => submitStep(selector, async (form) => {
  if (!presaleState.open) return;
  try {
    const result = await api(path, { method: "POST", body: JSON.stringify({ ...formValues(form), document: presaleState.open.id }) });
    showDialog({ title: result.title, message: result.message, effects: result.effects }, "recorded");
    form.reset();
    await loadPresale();
    await openPresaleDocument(presaleState.open.id);
  } catch (error) {
    showDialog({ title: failureTitle, message: error.message }, "failed");
  }
});

presaleAction("#presale-link-form", "/api/presale/link-invoice", "The invoice was not linked");
presaleAction("#presale-advance-form", "/api/presale/advance", "The money was not recorded");
presaleAction("#presale-refund-form", "/api/presale/refund-advance", "Nothing was paid back");

// Issue #165 — every advance on the open proforma, with the particulars its voucher carries.
async function loadAdvances(entry) {
  const { advances } = await api("/api/presale/advances", { method: "POST", body: JSON.stringify({ document: entry.id }) });
  const list = document.querySelector("#presale-advance-list");
  list.replaceChildren(...advances.flatMap((advance) => {
    const tax = advance.tax
      ? advance.tax.lines.map((line) => `GST ${line.rate}${line.reverseCharge ? " (reverse charge)" : ""}: ${money(line.taxableValue)} + CGST ${money(line.cgst)} + SGST ${money(line.sgst)} + IGST ${money(line.igst)}`).join(" · ")
      : t(advance.noTax);
    const rows = [detailRow(`${advance.number} · ${advance.date}`, money(advance.amount), `${advance.description} · Place of supply ${advance.placeOfSupply} · ${tax}`)];
    if (advance.application) rows.push(simpleRow(`Applied to invoice ${advance.application.invoiceNumber}: ${money(advance.application.amount)}`, advance.tax ? `GST of ${money(advance.application.taxSetOff)} already paid on it was set off, so the invoice's GST is not paid twice.` : ""));
    if (advance.refund) rows.push(simpleRow(`Refund voucher ${advance.refund.number} · ${advance.refund.date}: ${money(advance.refund.amount)}`, `${advance.refund.reason}${advance.tax ? ` · GST taken back ${money(advance.refund.taxRefunded)}` : ""}`));
    const actions = document.createElement("div");
    actions.className = "dialog-actions";
    const printButton = (label, which) => Object.assign(document.createElement("button"), { type: "button", className: "secondary-button", textContent: label, onclick: () => printVoucher(entry, advance, which) });
    actions.append(printButton("Print receipt voucher", "RECEIPT"));
    if (advance.refund) actions.append(printButton("Print refund voucher", "REFUND"));
    if (!advance.refund && advance.unused > 0) {
      actions.append(Object.assign(document.createElement("button"), {
        type: "button", className: "secondary-button", textContent: `Pay back ${money(advance.unused)}`,
        onclick: () => {
          const form = document.querySelector("#presale-refund-form");
          form.hidden = false;
          form.elements.namedItem("advance").value = advance.id;
          document.querySelector("#presale-refund-title").textContent = `Pay back ${money(advance.unused)} of ${advance.number}`;
        },
      }));
    }
    rows.push(actions);
    return rows;
  }));
}

async function printVoucher(entry, advance, which) {
  try {
    const printed = await api("/api/presale/voucher", { method: "POST", body: JSON.stringify({ document: entry.id, advance: advance.id, which }) });
    document.querySelector("#presale-frame").srcdoc = printed.html;
    document.querySelector("#presale-print-title").textContent = `${which === "REFUND" ? advance.refund.number : advance.number} · ${which === "REFUND" ? "Refund voucher" : "Receipt voucher"}`;
    document.querySelector("#presale-frame").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    showDialog({ title: "The voucher could not be shown", message: error.message }, "failed");
  }
}
presaleAction("#presale-cancel-form", "/api/presale/cancel", "It was not cancelled");


// ------------------------------------------------ issue #141: delivery challans
//
// The screen follows the law's order: why the goods are moving decides whether tax prints at all,
// so the reason comes first and says what it means before anything is checked. Checking uses no
// number; issuing does. Everything that happens to a challan afterwards — its printout, its e-way
// bill, the invoice that followed, a cancellation — is done from the one challan that is open.

const challanState = { reasons: [], open: null, list: [], reference: null };

async function openChallans() {
  const form = document.querySelector("#challan-form");
  if (!form) return;
  if (!form.elements.namedItem("date").value) form.elements.namedItem("date").value = dateInput();
  try {
    if (challanState.reasons.length === 0) {
      challanState.reasons = (await api("/api/challans/reasons")).reasons;
      const select = document.querySelector("#challan-reasons");
      select.replaceChildren(...challanState.reasons.map((reason) => {
        const option = document.createElement("option");
        option.value = reason.reason;
        option.textContent = `${t(reason.label)} · ${reason.legalBasis}`;
        return option;
      }));
      select.addEventListener("change", showChallanReason);
      const states = document.querySelector("#challan-states");
      const { states: rows } = await api("/api/eway/states");
      const own = document.createElement("option");
      own.value = "";
      own.textContent = copy[state.locale].buyerOwnState;
      states.replaceChildren(own, ...rows.filter((row) => row.kind !== "RETIRED").map((row) => {
        const option = document.createElement("option");
        option.value = row.code;
        option.textContent = `${row.name} (${row.code})`;
        return option;
      }));
    }
    showChallanReason();
    await loadChallans();
  } catch (error) {
    showDialog({ title: "The challan screen could not load", message: error.message }, "failed");
  }
}

function showChallanReason() {
  const chosen = challanState.reasons.find((reason) => reason.reason === document.querySelector("#challan-reasons").value);
  if (!chosen) return;
  document.querySelector("#challan-reason-rule").textContent = chosen.showsTax
    ? `Allowed by ${chosen.legalBasis}. These goods move as a sale, so the tax rate and amount print on the challan (Rule 55(1)(vii)), and the tax invoice follows later.`
    : `Allowed by ${chosen.legalBasis}. These goods are not being sold, so the challan shows their value and no tax (Rule 55(1)(vii)). No invoice follows it.`;
  document.querySelector("#challan-note-field").hidden = !chosen.needsNote;
}

const challanInput = () => ({ ...formValues(document.querySelector("#challan-form")), reference: challanState.reference });

submitStep("#challan-form", async () => {
  // A fresh key per check, reused by the issue that follows it, so a double press issues one challan.
  challanState.reference = crypto.randomUUID();
  try {
    renderChallanCheck(await api("/api/challans/preview", { method: "POST", body: JSON.stringify(challanInput()) }));
  } catch (error) {
    showDialog({ title: "Nothing was checked", message: error.message }, "failed");
  }
});

function renderChallanCheck(result) {
  document.querySelector("#challan-panel").hidden = false;
  document.querySelector("#challan-result-title").textContent = result.title;
  document.querySelector("#challan-result-message").textContent = result.message;
  const badge = document.querySelector("#challan-status");
  badge.textContent = result.state === "problems" ? "needs attention" : result.showsTax ? "tax shown" : "value only";
  badge.className = `pill ${result.state === "problems" ? "hold" : "done"}`;
  const detail = document.querySelector("#challan-detail");
  detail.replaceChildren();
  if (result.state === "problems") {
    result.problems.forEach((problem) => detail.append(detailRow("Missing", t(problem.message))));
  } else {
    result.lines.forEach((line) => detail.append(detailRow(line.item, `${line.quantity} · ${money(line.value)}`, `HSN ${line.hsn}${line.rate === null ? "" : ` · GST ${line.rate}%`}`)));
    detail.append(detailRow("Value of the goods", money(result.value)));
    if (result.showsTax) detail.append(detailRow("Tax shown on the challan", money(result.tax), "Shown because the law asks for it on a sale challan. It is charged on the invoice, not on this paper."));
    if (result.placeOfSupply) detail.append(detailRow("Place of supply", result.placeOfSupply, result.interState ? "The goods cross a state border, so the challan must show it." : undefined));
    // Issue #290 — the same e-way bill answer a sale review gives.
    if (result.ewayBill) detail.append(detailRow("E-way bill", result.ewayBill.message, result.ewayBill.reason));
  }
  document.querySelector("#challan-issue").hidden = result.state === "problems";
}

document.querySelector("#challan-issue")?.addEventListener("click", async () => {
  try {
    const result = await api("/api/challans/issue", { method: "POST", body: JSON.stringify(challanInput()) });
    document.querySelector("#challan-panel").hidden = true;
    showDialog({ title: result.title, message: result.message, effects: result.ewayBill ? [`${result.ewayBill.message} Raise it on the E-way bill screen, or type its number below.`] : undefined }, "recorded");
    await refreshDocumentLists();
    await openChallan(result.challan.id);
  } catch (error) {
    showDialog({ title: "No challan was issued", message: error.message }, "failed");
  }
});

async function loadChallans() {
  const list = document.querySelector("#challan-list");
  if (!list) return;
  const { challans } = await apiList("/api/challans", "challans");
  challanState.list = challans;
  list.replaceChildren(...(challans.length === 0 ? [simpleRow(copy[state.locale].noChallans, "")] : challans.map((challan) => {
    const row = detailRow(
      `${challan.number} · ${t(challan.reason)}`,
      `${money(challan.value)}${challan.showsTax ? ` + tax ${money(challan.tax)}` : ""}`,
      [
        challan.state === "INVOICED" ? `Billed on ${challan.invoice.number}` : challan.state === "CANCELLED" ? `Cancelled: ${challan.cancelReason}` : "Goods may move on it",
        challan.ewayBill ? `e-way bill ${challan.ewayBill.number}${challan.ewayBill.source === "TYPED" ? " (typed in)" : ""}` : "",
      ].filter(Boolean).join(" · "),
    );
    const open = document.createElement("button");
    open.type = "button";
    open.className = "secondary-button";
    open.textContent = copy[state.locale].openChallan;
    open.addEventListener("click", () => openChallan(challan.id));
    row.append(open);
    return row;
  })));
}

async function openChallan(id) {
  const challan = (challanState.list ?? []).find((row) => row.id === id);
  if (!challan) return;
  challanState.open = challan;
  const printed = await api("/api/challans/print", { method: "POST", body: JSON.stringify({ challan: id, locale: state.locale }) });
  document.querySelector("#challan-print-panel").hidden = false;
  document.querySelector("#challan-print-title").textContent = `${challan.number} · ${t(challan.reason)}`;
  document.querySelector("#challan-frame").srcdoc = printed.html;
  const open = challan.state === "ISSUED";
  document.querySelector("#challan-link-form").hidden = !(open && challan.invoiceFollows);
  // Issue #290 — billing from the challan, with the six-month date for goods on approval.
  document.querySelector("#challan-bill-panel").hidden = !(open && challan.invoiceFollows);
  document.querySelector("#challan-bill-help").textContent = challan.billBy
    ? `${copy[state.locale].billChallanHelp} ${text("billChallanBy", { date: longDate(challan.billBy) })}`
    : copy[state.locale].billChallanHelp;
  document.querySelector("#challan-eway-form").hidden = !open;
  document.querySelector("#challan-cancel-form").hidden = !open;
  if (open && challan.invoiceFollows) {
    const { invoices } = await apiList("/api/einvoices/invoices", "invoices");
    document.querySelector("#challan-invoices").replaceChildren(...invoices.map((invoice) => {
      const option = document.createElement("option");
      option.value = invoice.id;
      option.textContent = `${invoice.number} · ${invoice.date} · ${money(invoice.amount)}`;
      return option;
    }));
  }
  document.querySelector("#challan-print-panel").scrollIntoView({ behavior: "smooth", block: "start" });
}

document.querySelector("#challan-print")?.addEventListener("click", () => {
  document.querySelector("#challan-frame").contentWindow?.print();
});

const challanAction = (selector, path, failureTitle) => submitStep(selector, async (form) => {
  if (!challanState.open) return;
  try {
    const values = formValues(form);
    const checkbox = form.querySelector('input[type="checkbox"]');
    const result = await api(path, { method: "POST", body: JSON.stringify({ ...values, ...(checkbox ? { [checkbox.name]: checkbox.checked } : {}), challan: challanState.open.id }) });
    showDialog({ title: result.title, message: result.message, effects: result.effects }, "recorded");
    form.reset();
    await refreshDocumentLists();
    await openChallan(challanState.open.id);
  } catch (error) {
    showDialog({ title: failureTitle, message: error.message }, "failed");
  }
});

challanAction("#challan-link-form", "/api/challans/link-invoice", "The invoice was not linked");

document.querySelector("#challan-bill")?.addEventListener("click", async (event) => {
  if (!challanState.open) return;
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const result = await api("/api/challans/bill", { method: "POST", body: JSON.stringify({ challan: challanState.open.id }) });
    showDialog({ title: `Bill made: ${result.invoice.number}`, message: result.message, effects: result.effects }, "recorded");
    await refreshDocumentLists();
    await openChallan(challanState.open.id);
  } catch (error) {
    showSaleFailure(error);
  } finally {
    button.disabled = false;
  }
});
challanAction("#challan-eway-form", "/api/challans/eway", "The e-way bill was not recorded");
challanAction("#challan-cancel-form", "/api/challans/cancel", "The challan was not cancelled");


// ------------------------------------------------ issue #27: e-way bills for goods on the road
//
// The screen leads with the decision and the facts behind it, because most consignments a small
// business moves need no e-way bill at all. Raising one is offered only after the answer is yes,
// and a bill with no vehicle on it is never shown as permission to move: Part A and Part B are two
// different states here exactly as they are on the portal.

function renderEway(result, mode) {
  const panel = document.querySelector("#eway-panel");
  panel.hidden = false;
  document.querySelector("#eway-result-title").textContent = result.title;
  document.querySelector("#eway-result-message").textContent = result.message;

  const badge = document.querySelector("#eway-status");
  const status = mode === "preview" ? result.outcome : result.status;
  badge.textContent = String(status).replace(/_/g, " ").toLowerCase();
  badge.className = `pill ${status === "ACTIVE" ? "done" : status === "FAILED" || status === "EXPIRED" || status === "CANNOT_DECIDE" ? "hold" : status === "REQUIRED" || status === "PART_A_ONLY" ? "warn" : "done"}`;

  const detail = document.querySelector("#eway-detail");
  detail.replaceChildren();

  const applicability = mode === "preview" ? result : result.applicability;
  detail.append(detailRow("The rule that decided it", applicability.ruleId, applicability.sourceRef || undefined));
  detail.append(detailRow("Why", applicability.reason));
  // The facts the rules actually used, listed as they were applied rather than summarised after.
  (applicability.facts ?? []).forEach((fact) => detail.append(detailRow(fact.label, fact.value)));

  if (mode === "preview") {
    if (result.threshold) detail.append(detailRow("Limit compared against", money(result.threshold.amount), result.threshold.note || undefined));
    // Issue #240 — what the e-way bill will carry, all of it from the bill, for the person to confirm.
    const filled = result.filled;
    if (filled && result.outcome === "REQUIRED") {
      const place = (who) => `${who.name}${who.gstin && who.gstin !== "URP" ? ` · GSTIN ${who.gstin}` : ""}`;
      const where = (who) => `${who.address}, ${who.place} ${who.pincode}, ${who.state} (${who.stateCode})`;
      if (filled.document) detail.append(detailRow("Bill", `${filled.document.number} · ${filled.document.date}`));
      detail.append(detailRow("From", place(filled.from), where(filled.from)));
      detail.append(detailRow("To", place(filled.billTo), where(filled.to)));
      filled.lines.forEach((line) => detail.append(detailRow(line.description, `${line.quantity} ${line.unit} · ${money(line.value)}`, `HSN ${line.hsn} · tax ${money(line.tax)}`)));
      detail.append(detailRow("Value and tax", `${money(filled.taxable)} + tax ${money(filled.cgst + filled.sgst + filled.igst)}`, [filled.igst ? `IGST ${money(filled.igst)}` : "", filled.cgst ? `CGST ${money(filled.cgst)} · SGST ${money(filled.sgst)}` : ""].filter(Boolean).join(" · ") || undefined));
      detail.append(detailRow("Transport", `${filled.transportMode}${filled.vehicle ? ` · vehicle ${filled.vehicle}` : " · no vehicle yet"}`, filled.transporter ? `${filled.transporter.name} · ${filled.transporter.transporterId}${filled.transporter.documentNumber ? ` · LR ${filled.transporter.documentNumber}` : ""}` : undefined));
    }
    if (result.distance && result.outcome === "REQUIRED") {
      detail.append(detailRow("Distance", result.distance.refusalKind === "NEEDED" ? "Type it: same PIN code at both ends" : result.distance.sentKm === 0 ? "Worked out by the portal (0 is sent)" : `${result.distance.sentKm} km, typed`, result.distance.refusal ?? result.distance.message));
    }
    if (result.validityDays) detail.append(detailRow("Days it would be valid for", String(result.validityDays), `${result.validitySum ? `${result.validitySum}. ` : ""}Each day ends at midnight. The clock starts when a vehicle goes on.`));
    else if (result.outcome === "REQUIRED" && result.distance?.sentKm === 0 && !result.distance.samePin) detail.append(detailRow("Days it would be valid for", "Shown once the portal answers", "The portal works the distance out when the e-way bill is raised: one day for every 200 km, or part of it."));
    result.problems.forEach((problem) => detail.append(detailRow("Needs fixing", problem.message, problem.field)));
  } else {
    if (result.ewayBillNumber) detail.append(detailRow("E-way bill number", result.ewayBillNumber, "Keep this number with the driver."));
    if (result.validUntil) detail.append(detailRow("Valid until", result.validUntilLabel ?? result.validUntil, result.timeLeft || undefined));
    if (result.vehicles.length) detail.append(detailRow("Vehicles", result.vehicles.map((vehicle) => vehicle.number).join(" → ")));
    if (result.consolidatedTripNumber) detail.append(detailRow("On trip sheet", result.consolidatedTripNumber));
    if (result.cancellableUntil) detail.append(detailRow("Can be cancelled until", result.cancellableUntilLabel ?? result.cancellableUntil, "The portal allows 24 hours, and not a minute more."));
    if (result.failure) detail.append(detailRow("What went wrong", result.failure.message, result.failure.retryable ? "Worth trying again." : "Trying again unchanged will not help."));
  }

  // Only offer what makes sense for where this consignment actually is.
  const required = mode === "preview" ? result.outcome === "REQUIRED" : result.applicability.outcome === "REQUIRED";
  const raised = mode !== "preview" && ["PART_A_ONLY", "ACTIVE", "EXPIRED"].includes(result.status);
  document.querySelector("#eway-raise").hidden = !(required && (mode === "preview" ? result.ready : result.status === "FAILED"));
  document.querySelector("#eway-offline").hidden = !required;
  document.querySelector("#eway-reconcile").hidden = !(mode !== "preview" && (result.status === "FAILED" || result.status === "PENDING"));
  // Printable the moment the portal has answered with a number — including a cancelled or expired
  // one, because that paper exists and a person may still have to produce it.
  document.querySelector("#eway-print").hidden = !(mode !== "preview" && Boolean(result.ewayBillNumber));
  if (mode === "preview" || !result.ewayBillNumber) document.querySelector("#eway-print-panel").hidden = true;
  // A vehicle can go on while the bill is live, and only then.
  document.querySelector("#eway-vehicle-form").hidden = !(raised && result.status !== "EXPIRED");
  document.querySelector("#eway-extend-form").hidden = !(mode !== "preview" && (result.status === "ACTIVE" || result.status === "EXPIRED"));
  document.querySelector("#eway-cancel-form").hidden = !(raised && result.status !== "EXPIRED");
}

const ewayInput = () => formValues(document.querySelector("#eway-form"));

submitStep("#eway-form", async () => {
  try {
    renderEway(await api("/api/eway/preview", { method: "POST", body: JSON.stringify(ewayInput()) }), "preview");
  } catch (error) {
    showDialog({ title: "Nothing was checked", message: error.message }, "failed");
  }
});

const ewayAction = (selector, path) => {
  const button = document.querySelector(selector);
  if (!button) return;
  button.addEventListener("click", async () => {
    try {
      renderEway(await api(path, { method: "POST", body: JSON.stringify(ewayInput()) }), "record");
      await refreshDocumentLists();
    } catch (error) {
      showDialog({ title: "Nothing was raised", message: error.message }, "failed");
    }
  });
};

ewayAction("#eway-raise", "/api/eway/generate");
ewayAction("#eway-reconcile", "/api/eway/reconcile");

const ewayForm = (selector, path, failureTitle) => submitStep(selector, async (form) => {
  try {
    renderEway(await api(path, {
      method: "POST", body: JSON.stringify({ ...ewayInput(), ...formValues(form) }),
    }), "record");
    await refreshDocumentLists();
  } catch (error) {
    showDialog({ title: failureTitle, message: error.message }, "failed");
  }
});

ewayForm("#eway-vehicle-form", "/api/eway/vehicle", "The vehicle was not added");
ewayForm("#eway-extend-form", "/api/eway/extend", "Nothing was extended");
ewayForm("#eway-cancel-form", "/api/eway/cancel", "Nothing was cancelled");

// Issue #191 — the driver's page. It is the portal's own sheet, so it is fetched and shown as it
// will be printed, rather than assembled again on the screen.
document.querySelector("#eway-print")?.addEventListener("click", async () => {
  try {
    const printed = await api("/api/eway/print", { method: "POST", body: JSON.stringify(ewayInput()) });
    const panel = document.querySelector("#eway-print-panel");
    document.querySelector("#eway-print-note").textContent = printed.notice
      ?? `E-way bill ${printed.ewayBillNumber}. Hand this to the driver with the bill.`;
    document.querySelector("#eway-print-frame").srcdoc = printed.html;
    document.querySelector("#eway-print-pdf").href = `/api/eway/${encodeURIComponent(ewayInput().invoice ?? "")}/pdf`;
    panel.hidden = false;
    panel.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    showDialog({ title: "Nothing to print", message: error.message }, "failed");
  }
});

document.querySelector("#eway-print-send")?.addEventListener("click", () => {
  document.querySelector("#eway-print-frame").contentWindow?.print();
});

// The offline file matters most when the portal is down and the lorry still has to leave.
document.querySelector("#eway-offline")?.addEventListener("click", async () => {
  try {
    const result = await api("/api/eway/offline", { method: "POST", body: JSON.stringify(ewayInput()) });
    showDialog({
      title: "File ready",
      message: `${result.fileName} — this is what would be sent. It is not an e-way bill, and goods must not move on it.`,
      effects: String(result.json).split("\n").slice(0, 12),
    }, "recorded");
  } catch (error) {
    showDialog({ title: "Nothing to export", message: error.message }, "failed");
  }
});

// Every state, with its own limit, straight from the rule table the decision uses — so what the
// picker shows and what decides the movement can never drift apart.
async function loadEwayStates() {
  const select = document.querySelector("#eway-states");
  if (!select) return;
  try {
    const { states } = await api("/api/eway/states");
    // What exists today first; codes that are no longer issued at the end, said plainly, because
    // an old document can still carry one and somebody may have to pick it.
    const order = { STATE: 0, UNION_TERRITORY: 0, OTHER_TERRITORY: 1, RETIRED: 2 };
    states.sort((left, right) => (order[left.kind] ?? 0) - (order[right.kind] ?? 0));
    select.replaceChildren();
    const anywhere = document.createElement("option");
    anywhere.value = "";
    anywhere.textContent = copy[state.locale].buyerOwnState;
    select.append(anywhere);
    states.forEach((row) => {
      const option = document.createElement("option");
      option.value = row.code;
      // A territory that asks for no e-way bill has no limit to show, and showing one would lie.
      const limit = row.exemptAnyValue ? "no e-way bill needed inside it" : money(row.limit);
      option.textContent = `${row.name} · ${limit}${row.kind === "RETIRED" ? " · code no longer issued" : row.kind === "OTHER_TERRITORY" ? " · not a state" : ""}`;
      option.dataset.limit = row.exemptAnyValue ? "" : String(row.limit);
      option.dataset.cityLimit = row.intraCityLimit === null ? "" : String(row.intraCityLimit);
      option.dataset.cityExempt = String(row.intraCityExempt);
      option.dataset.sourceKind = row.sourceKind;
      option.dataset.from = row.effectiveFrom;
      option.dataset.source = row.sourceRef;
      option.dataset.confirmed = String(row.sourceConfirmed);
      option.dataset.note = row.note ?? "";
      select.append(option);
    });
    select.addEventListener("change", showEwayStateRule);
    showEwayStateRule();
  } catch { /* the picker is a convenience; the check still works without it */ }
}

// The chosen state's own rule, shown before anything is checked, so the limit is never a surprise.
function showEwayStateRule() {
  const select = document.querySelector("#eway-states");
  const line = document.querySelector("#eway-state-rule");
  if (!select || !line) return;
  const option = select.selectedOptions[0];
  if (!option?.value) { line.textContent = ""; return; }
  const name = option.textContent.split(" · ")[0];
  const parts = [option.dataset.limit
    ? `Inside ${name} the limit is ${money(Number(option.dataset.limit))}, from ${option.dataset.from}.`
    : `${name} asks for no e-way bill at all inside its own borders, from ${option.dataset.from}.`];
  if (option.dataset.cityLimit) parts.push(`Inside one city the limit is ${money(Number(option.dataset.cityLimit))}.`);
  if (option.dataset.cityExempt === "true") parts.push("Inside one city no e-way bill is needed at all.");
  if (option.dataset.note) parts.push(option.dataset.note);
  parts.push(option.dataset.source);
  line.textContent = parts.join(" ");
}

// Issue #240 — which bill the e-way bill screen is on, and which bill the form was last filled from.
const ewayChoice = { wanted: null, filledFor: null };

/** Opens the e-way bill screen on one bill, everything filled in from it and the check already run. */
async function openEwayForBill(invoiceId) {
  ewayChoice.wanted = invoiceId;
  ewayChoice.filledFor = null;
  openView("eway");
  await loadEwayRoad();
}

/** Fills the e-way bill form from the bill, and shows the check (or the e-way bill already raised). */
async function fillEwayFromBill(invoiceId) {
  const form = document.querySelector("#eway-form");
  if (!form || !invoiceId) return;
  try {
    const found = await api("/api/eway/for-bill", { method: "POST", body: JSON.stringify({ invoice: invoiceId }) });
    Object.entries(found.form).forEach(([name, value]) => {
      const field = form.elements.namedItem(name);
      if (field && name !== "invoice") field.value = value;
    });
    ewayChoice.filledFor = invoiceId;
    const note = document.querySelector("#eway-filled-note");
    note.hidden = false;
    document.querySelector("#eway-filled-text").textContent = text("ewayFilledFrom", { number: found.check.documentNumber });
    showEwayStateRule();
    if (found.raised) renderEway(found.raised, "record"); else renderEway(found.check, "preview");
  } catch (error) {
    showDialog({ title: "The bill could not be filled in", message: error.message }, "failed");
  }
}

document.querySelector("#eway-invoices")?.addEventListener("change", (event) => {
  const select = event.currentTarget;
  ewayChoice.wanted = select.value;
  if (select.selectedOptions[0]?.dataset.kind === "invoice") { fillEwayFromBill(select.value); return; }
  // A delivery challan brings its own details; the bill's are cleared so none of them carry over.
  ewayChoice.filledFor = null;
  ["shipToState", "shipToAddress", "shipToPlace", "shipToPincode", "distanceKm", "vehicle"].forEach((name) => {
    const field = document.querySelector("#eway-form").elements.namedItem(name);
    if (field) field.value = "";
  });
  document.querySelector("#eway-filled-note").hidden = true;
  document.querySelector("#eway-panel").hidden = true;
});

async function loadEwayRoad() {
  const list = document.querySelector("#eway-road");
  const select = document.querySelector("#eway-invoices");
  if (!list || !select) return;
  try {
    // Issue #141 — a delivery challan can be the document on the lorry, in place of an invoice. Both
    // lists are fetched before the picker is touched, so two loads racing cannot interleave rows.
    // Issue #240 — each bill with its customer, its total and whether it needs an e-way bill; the ones
    // that need one and have none come first.
    const [{ invoices }, { challans }] = await Promise.all([apiList("/api/eway/bills", "invoices"), apiList("/api/challans/movable", "challans")]);
    const chosen = select.value;
    const make = (value, label, kind) => { const entry = document.createElement("option"); entry.value = value; entry.textContent = label; entry.dataset.kind = kind; return entry; };
    select.replaceChildren(
      ...invoices.map((invoice) => make(invoice.id, [invoice.number, invoice.customer, money(invoice.amount), invoice.label].filter(Boolean).join(" · "), "invoice")),
      ...challans.map((challan) => make(challan.id, `${copy[state.locale].navChallan} ${challan.number} · ${money(challan.value)}`, "challan")),
    );
    const wanted = ewayChoice.wanted ?? chosen;
    if ([...select.options].some((entry) => entry.value === wanted)) select.value = wanted;
    // Issue #240 — the chosen bill fills the form by itself; nobody retypes what the bill says.
    if (select.selectedOptions[0]?.dataset.kind === "invoice" && ewayChoice.filledFor !== select.value) await fillEwayFromBill(select.value);

    const { consignments } = await apiList("/api/eway/on-the-road", "consignments");
    list.replaceChildren();
    if (consignments.length === 0) {
      list.append(detailRow("Nothing is on the road", "No consignment has a running e-way bill right now."));
      return;
    }
    consignments.forEach((row) => {
      list.append(detailRow(
        `${row.documentNumber} · ${row.ewayBillNumber ?? "no number yet"}`,
        row.vehicle ?? "no vehicle yet — the goods may not move",
        row.timeLeft,
      ));
    });
  } catch { /* the picker and the list are conveniences; the rest of the page still works */ }
}

async function loadOperations() {
  const health = document.querySelector("#operations-health");
  const failures = document.querySelector("#operations-failures");
  const jobs = document.querySelector("#operations-jobs");
  const recurring = document.querySelector("#operations-recurring");
  const incidents = document.querySelector("#operations-incidents");
  if (!health || !failures || !jobs || !recurring || !incidents) return;
  try {
    const data = await api("/api/operations");
    health.replaceChildren(simpleRow(data.health.state === "healthy" ? copy[state.locale].operationsHealthy : copy[state.locale].operationsDegraded, Object.entries(data.health.checks).map(([name, value]) => `${name}: ${value}`).join(" · ")));
    failures.replaceChildren(...(data.failures.length ? data.failures.map((failure) => simpleRow(`${failure.connector} · ${failure.errorCode}`, `${failure.operation} · ${failure.correlationId}`)) : [simpleRow(copy[state.locale].operationsNoFailures, "")]));
    jobs.replaceChildren(...(data.jobs.length ? data.jobs.map((job) => {
      const row = simpleRow(`${job.kind} · ${job.state}`, `${job.correlationId} · ${job.attempts}/${job.maxAttempts}`);
      if (job.state === "failure" && job.idempotent) {
        const button = document.createElement("button");
        button.type = "button"; button.className = "secondary-button"; button.dataset.replayJob = job.id; button.textContent = copy[state.locale].operationsReplay;
        row.append(button);
      }
      return row;
    }) : [simpleRow(copy[state.locale].operationsNoJobs, "")]));
    const recurringState = {
      never: copy[state.locale].operationsNeverRun,
      running: copy[state.locale].operationsRunning,
      success: copy[state.locale].operationsSucceeded,
      failure: copy[state.locale].operationsFailed,
      dead_lettered: copy[state.locale].operationsDeadLettered,
    };
    recurring.replaceChildren(...(data.recurring.length ? data.recurring.map((item) => {
      const last = item.lastCompletedAt ?? item.lastStartedAt;
      const detail = [
        recurringState[item.outcome],
        `${copy[state.locale].operationsNextRun}: ${new Intl.DateTimeFormat(state.locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(item.nextRunAt))}`,
        last ? `${copy[state.locale].operationsLastRun}: ${new Intl.DateTimeFormat(state.locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(last))}` : null,
        item.durationMs === undefined ? null : `${item.durationMs} ms`,
        item.summary ?? item.lastErrorCode ?? null,
      ].filter(Boolean).join(" · ");
      return simpleRow(item.name, detail);
    }) : [simpleRow(copy[state.locale].operationsNoRecurring, "")]));
    incidents.replaceChildren(...(data.incidents.length ? data.incidents.map((incident) => simpleRow(`${incident.title} · ${incident.state}`, incident.timeline.map((update) => update.message).join(" → "))) : [simpleRow(copy[state.locale].operationsNoIncidents, "")]));
  } catch (error) { health.textContent = error.message; }
}

document.querySelector("#operations-jobs")?.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-replay-job]");
  if (!button) return;
  button.disabled = true;
  try { await api("/api/operations/jobs/replay", { method: "POST", body: JSON.stringify({ jobId: button.dataset.replayJob }) }); await loadOperations(); }
  catch (error) { announce(error.message); button.disabled = false; }
});

// ------------------------------------ issue #28: can this lorry actually carry this load
//
// The screen is built around one distinction people get wrong: a check that found nothing and a
// check that could not be made are not the same thing. So a CANNOT_DECIDE is amber and says "not a
// pass", the evidence is listed with the source on each line, and the override form only ever
// offers the findings a person is allowed to answer for — the physically impossible ones are shown
// with no button at all.

// ------------------------------------------------------------ issue #29: the government record
//
// One number plate, typed in by a person at the gate, and what the registering authority says about
// it. The three answers stay three: facts, "no such vehicle", and "we could not ask" — the last one
// says which reason it was and never reads as "nothing wrong".

function renderVehicleRecord(result) {
  const words = copy[state.locale];
  document.querySelector("#vehicle-record-heading").hidden = false;
  document.querySelector("#vehicle-record-title").textContent = result.title;
  document.querySelector("#vehicle-record-message").textContent = result.message;

  const badge = document.querySelector("#vehicle-record-status");
  badge.textContent = result.kind === "FOUND"
    ? (result.freshness === "STALE" ? "on record, but old" : "on record")
    : result.kind === "NOT_FOUND" ? "not on record" : "not checked";
  badge.className = `pill ${result.kind === "FOUND" ? (result.freshness === "STALE" ? "warn" : "done") : result.kind === "NOT_FOUND" ? "warn" : "hold"}`;

  const list = document.querySelector("#vehicle-record-facts");
  list.replaceChildren();
  result.facts.forEach((fact) => list.append(detailRow(fact.label, fact.value)));
  // Where the answer came from and when, always, because a reading nobody can trace is not proof.
  if (result.provider) list.append(detailRow(words.recordProvider, result.provider));
  if (result.providerReference) list.append(detailRow(words.recordReference, result.providerReference));
  if (result.retrievedAt) {
    list.append(detailRow(words.recordAsked, new Date(result.retrievedAt).toLocaleString(), result.fromCache ? words.recordReused : undefined));
  }
  if (result.consent) list.append(detailRow(words.recordAgreed, result.consent.fields.join(", ")));
}

submitStep("#vehicle-record-form", async (form) => {
  try {
    renderVehicleRecord(await api("/api/vehicles/record", { method: "POST", body: JSON.stringify(formValues(form)) }));
  } catch (error) {
    document.querySelector("#vehicle-record-heading").hidden = false;
    document.querySelector("#vehicle-record-title").textContent = "That could not be looked up";
    document.querySelector("#vehicle-record-message").textContent = error.message;
    document.querySelector("#vehicle-record-facts").replaceChildren();
  }
});

let lastVehicleCheck = null;

function renderVehicleCheck(result) {
  lastVehicleCheck = result;
  const panel = document.querySelector("#vehicle-panel");
  panel.hidden = false;
  document.querySelector("#vehicle-result-title").textContent = result.title;
  document.querySelector("#vehicle-result-message").textContent = result.message;

  // An overridden check keeps its outcome — the finding stands — so the badge says "overridden"
  // rather than pretending the check came back clean.
  const badge = document.querySelector("#vehicle-status");
  const overridden = result.clearedToMove && result.overrides.length > 0;
  badge.textContent = overridden ? "overridden" : String(result.outcome).replace(/_/g, " ").toLowerCase();
  badge.className = `pill ${overridden ? "warn" : result.outcome === "OK" ? "done" : result.outcome === "WARN" ? "warn" : "hold"}`;

  const findings = document.querySelector("#vehicle-findings");
  findings.replaceChildren();
  if (result.findings.length === 0) {
    findings.append(detailRow("Nothing found", result.message));
  }
  result.findings.forEach((finding) => {
    const severity = finding.severity === "BLOCK" ? "Stops the movement" : finding.severity === "WARN" ? "Worth a look" : "Cannot be decided";
    findings.append(detailRow(
      `${severity} · ${finding.title}`,
      finding.reason,
      // The rule and its source travel with the finding, as they do everywhere else in this app.
      `${finding.ruleId}${finding.sourceRef ? ` · ${finding.sourceRef}` : ""}${finding.overridable ? "" : " · cannot be overridden"}`,
    ));
    finding.facts.forEach((fact) => findings.append(detailRow(fact.label, fact.value)));
  });
  if (result.plate) {
    // Whether a camera or a person read the plate changes what the line means, so it says which.
    findings.append(detailRow(
      result.plate.readBy === "PERSON" ? "Number plate, read off the lorry" : "Number plate photograph",
      result.plate.explanation,
      result.plate.readNumber ? `Read as ${result.plate.readNumber}` : undefined,
    ));
  }

  const evidence = document.querySelector("#vehicle-evidence");
  evidence.replaceChildren();
  if (result.evidence.length === 0) {
    evidence.append(detailRow("Nothing on record", "Neither the registering authority nor your own vehicle list holds anything about this vehicle."));
  }
  result.evidence.forEach((item) => {
    const where = item.source === "GOVERNMENT_RECORD" ? "The registering authority's record" : item.source === "COMPANY_MASTER" ? "Your own vehicle list" : "Typed in for this movement";
    const parts = [
      item.vehicleClass ? `class ${item.vehicleClass}` : null,
      item.bodyType ? `${item.bodyType} body` : null,
      item.ratedPayloadKg ? `may carry ${item.ratedPayloadKg} kg` : null,
      item.permitType ? `${item.permitType.toLowerCase()} permit` : null,
      item.fitnessValidUpto ? `fitness to ${item.fitnessValidUpto}` : null,
    ].filter(Boolean);
    evidence.append(detailRow(where, parts.join(" · ") || "nothing held", item.reference ? `Reference ${item.reference} · read at ${item.retrievedAt}` : `Read at ${item.retrievedAt}`));
  });
  if (result.capacity) {
    evidence.append(detailRow("Capacity used for the comparison", `${result.capacity.capacityKg} kg`, result.capacity.basis));
  }
  result.overrides.forEach((entry) => {
    evidence.append(detailRow(`Sent out anyway by ${entry.by}`, entry.reason, `${entry.findingCodes.join(", ")} · ${entry.at}`));
  });

  // Only what is still standing and is allowed to be answered for.
  const answerable = result.findings.filter((finding) => finding.outstanding && finding.overridable);
  const codes = document.querySelector("#vehicle-override-codes");
  codes.replaceChildren();
  answerable.forEach((finding) => {
    const option = document.createElement("option");
    option.value = finding.code;
    option.textContent = finding.title;
    option.selected = true;
    codes.append(option);
  });
  document.querySelector("#vehicle-override-form").hidden = answerable.length === 0;
}

submitStep("#vehicle-form", async (form) => {
  try {
    renderVehicleCheck(await api("/api/vehicles/check", { method: "POST", body: JSON.stringify(formValues(form)) }));
    await loadVehiclesHeld();
  } catch (error) {
    showDialog({ title: "Nothing was checked", message: error.message }, "failed");
  }
});

submitStep("#vehicle-override-form", async (form) => {
  if (!lastVehicleCheck) return;
  const chosen = [...document.querySelector("#vehicle-override-codes").selectedOptions].map((option) => option.value);
  try {
    renderVehicleCheck(await api("/api/vehicles/check/override", {
      method: "POST",
      body: JSON.stringify({ checkId: lastVehicleCheck.id, findingCodes: chosen.join(","), reason: formValues(form).reason }),
    }));
    await loadVehiclesHeld();
  } catch (error) {
    showDialog({ title: "Nothing was overridden", message: error.message }, "failed");
  }
});

/** The vehicles and the photographs this screen can be tried against. */
async function loadVehicleChoices() {
  const numbers = document.querySelector("#vehicle-numbers");
  const photos = document.querySelector("#vehicle-photos");
  if (!numbers || !photos) return;
  try {
    const { vehicles, photos: pictures, classes } = await api("/api/vehicles/choices");
    numbers.replaceChildren();
    vehicles.forEach((vehicle) => {
      const option = document.createElement("option");
      option.value = vehicle.number;
      option.textContent = vehicle.label;
      numbers.append(option);
    });
    photos.replaceChildren();
    pictures.forEach((picture) => {
      const option = document.createElement("option");
      option.value = picture.value;
      option.textContent = picture.label;
      photos.append(option);
    });
    // Typed facts start blank: not saying is a real answer, and the rules ask rather than guess.
    const classSelect = document.querySelector("#vehicle-classes");
    if (classSelect) {
      classSelect.replaceChildren();
      const blank = document.createElement("option");
      blank.value = "";
      blank.textContent = copy[state.locale].classNotSaid;
      classSelect.append(blank);
      (classes ?? []).forEach((kind) => {
        const option = document.createElement("option");
        option.value = kind.value;
        option.textContent = kind.label;
        classSelect.append(option);
      });
    }
  } catch { /* the pickers are a convenience; the rest of the page still works */ }
}

async function loadVehiclesHeld() {
  const list = document.querySelector("#vehicle-held");
  const select = document.querySelector("#vehicle-invoices");
  if (!list || !select) return;
  try {
    const { invoices } = await apiList("/api/einvoices/invoices", "invoices");
    const chosen = select.value;
    select.replaceChildren();
    invoices.forEach((invoice) => {
      const option = document.createElement("option");
      option.value = invoice.id;
      option.textContent = `${invoice.number} · ${money(invoice.amount)}`;
      select.append(option);
    });
    if ([...select.options].some((option) => option.value === chosen)) select.value = chosen;

    const { held } = await apiList("/api/vehicles/held", "held");
    list.replaceChildren();
    if (held.length === 0) {
      list.append(detailRow("Nothing is held back", "No movement is waiting on a vehicle problem right now."));
      return;
    }
    held.forEach((row) => list.append(detailRow(`${row.vehicle ?? "no vehicle"} · ${row.outcome.toLowerCase().replace(/_/g, " ")}`, row.summary, row.outstanding.join("; "))));
  } catch { /* the list is a convenience; the rest of the page still works */ }
}

window.addEventListener("hashchange", () => openView(location.hash.slice(1)));

translate();
openView(state.view);
if (invitationToken !== null) { document.querySelector("#login-help").textContent = copy[state.locale].joinInvited; showLogin(); } else if (state.signedIn) { loadSession().catch(() => {}); loadDashboard(); loadSupplierChoices(); loadIssuedInvoices(); loadReturnDocuments(); loadEwayRoad(); loadEwayStates(); loadVehicleChoices(); loadVehiclesHeld(); loadReminders(); loadBankFeeds(); loadSetupStates(); finishBankReturn(); if (state.view === "operations") loadOperations(); } else showLogin();

// ------------------------------------ issue #30: the month's GST returns
//
// The screen is built around the two things a shopkeeper actually needs from a return and rarely
// gets. First, every figure opens up: each row lists the bills it was made from, so "why is this
// ₹1,25,000" is one click and not a phone call to an accountant. Second, nothing is filled in on
// their behalf — a bill the app cannot place sits on its own list with the question that would
// place it, and the return is short by exactly that bill until somebody answers.

let gstWorkspace = null;

function gstPeriodValue() {
  const field = document.querySelector("#gst-period");
  if (field.value) return field.value;
  // The month a business is actually filing is the one that has just ended.
  field.value = previousMonth();
  return field.value;
}

function openGstReturns() {
  gstPeriodValue();
  // Always re-read, never reuse what was on screen last time. Somebody who raises a bill and comes
  // back here would otherwise be shown the figures from before it, and — worse — would not be told
  // that their books have moved since the return was approved.
  loadGstReturns();
}

async function loadGstReturns() {
  try {
    renderGstWorkspace(await api("/api/gst-returns", { method: "POST", body: JSON.stringify({ period: gstPeriodValue() }) }));
  } catch (error) {
    showGstProblem(error.message);
  }
}

function showGstProblem(message) {
  document.querySelector("#gst-heading").hidden = false;
  document.querySelector("#gst-title").textContent = t({ "en-IN": "That month could not be prepared", "hi-IN": "वो महीना तैयार नहीं हो पाया" });
  document.querySelector("#gst-summary").textContent = message;
  document.querySelector("#gst-blockers").replaceChildren();
}

function renderGstWorkspace(workspace) {
  gstWorkspace = workspace;
  const words = copy[state.locale];

  document.querySelector("#gst-heading").hidden = false;
  document.querySelector("#gst-title").textContent = workspace.periodLabel;
  document.querySelector("#gst-summary").textContent = workspace.summary;
  const badge = document.querySelector("#gst-status");
  badge.textContent = workspace.statusLabel;
  // Amber for "somebody has to decide", green for approved and onwards, blue while it is a draft.
  badge.className = `pill ${workspace.status === "NEEDS_ATTENTION" ? "warn" : workspace.status === "DRAFT" ? "hold" : "done"}`;

  // What stands between this month and an approval, said before anything else on the page.
  const blockers = document.querySelector("#gst-blockers");
  blockers.replaceChildren();
  workspace.whyNotApprovable.forEach((reason) => blockers.append(simpleRow(reason, "")));
  workspace.findings
    .filter((finding) => finding.severity !== "INFORMATION")
    .forEach((finding) => blockers.append(simpleRow(finding.message, finding.whatToDo)));

  const drift = document.querySelector("#gst-drift-panel");
  drift.hidden = workspace.drift === null;
  if (workspace.drift !== null) document.querySelector("#gst-drift-message").textContent = workspace.drift.message;

  const exceptionsPanel = document.querySelector("#gst-exceptions-panel");
  exceptionsPanel.hidden = workspace.exceptions.length === 0;
  const exceptions = document.querySelector("#gst-exceptions");
  exceptions.replaceChildren();
  workspace.exceptions.forEach((exception) => {
    exception.questions.forEach((question) => {
      exceptions.append(simpleRow(`${exception.number} · ${exception.party} · ${money(exception.amount)}`, `${question.message} ${question.whatToDo}`));
    });
  });

  const sectionsPanel = document.querySelector("#gst-sections-panel");
  sectionsPanel.hidden = workspace.sections.length === 0;
  const sections = document.querySelector("#gst-sections");
  sections.replaceChildren();
  workspace.sections.forEach((section) => {
    sections.append(simpleRow(section.name, section.sentence));
    section.rows.forEach((row) => {
      // The bills behind the row, on the row. This is the drill-down the whole design turns on.
      const bills = row.sources.map((source) => `${source.number} (${money(source.amount)})`).join(", ");
      const rate = row.rate === null ? "" : ` · ${row.rate}%`;
      // Issue #232 — the state a bill or note is reported under, beside its number.
      const where = row.placeOfSupply === null || row.placeOfSupply === undefined ? "" : ` · ${row.placeOfSupply}`;
      sections.append(detailRow(`${row.label}${where}${rate}`, `${money(row.taxableValue)} + ${money(row.tax)} GST`, bills));
    });
  });

  // Issue #233 — the documents-issued table: numbers used, and how many were cancelled.
  if ((workspace.documentsIssued || []).length > 0) {
    sectionsPanel.hidden = false;
    sections.append(simpleRow(copy[state.locale].documentsIssued, ""));
    workspace.documentsIssued.forEach((row) => {
      sections.append(detailRow(copy[state.locale][`documentKind${row.kind}`] ?? row.kind, text("documentsIssuedLine", {
        from: row.from, to: row.to, total: String(row.total), cancelled: String(row.cancelled), issued: String(row.issued),
      })));
    });
  }

  const booksPanel = document.querySelector("#gst-books-panel");
  booksPanel.hidden = false;
  document.querySelector("#gst-books-sentence").textContent = workspace.reconciliation.sentence;
  const books = document.querySelector("#gst-books");
  books.replaceChildren();
  workspace.reconciliation.heads.forEach((head) => {
    books.append(detailRow(head.head, `${words.gstOnReturn} ${money(head.onTheReturn)} · ${words.gstInBooks} ${money(head.inTheBooks)}`, head.agrees ? undefined : workspace.reconciliation.sentence));
  });

  // Issue #249 — the credit side, as the sales side above.
  const purchaseBooks = document.querySelector("#gst-purchase-books");
  purchaseBooks.replaceChildren();
  const purchase = workspace.purchaseReconciliation;
  document.querySelector("#gst-purchase-books-sentence").textContent = purchase ? purchase.sentence : "";
  (purchase?.heads ?? []).filter((head) => head.onTheReturn !== 0 || head.inTheBooks !== 0 || !head.agrees).forEach((head) => {
    const explained = head.explained === 0 ? "" : ` · ${money(head.explained)} ${words.gstPurchaseExplained}`;
    purchaseBooks.append(detailRow(head.head, `${words.gstOnReturn} ${money(head.onTheReturn)} · ${words.gstInBooks} ${money(head.inTheBooks)}${explained}`, head.agrees ? undefined : purchase.sentence));
  });

  document.querySelector("#gst-3b-panel").hidden = false;
  document.querySelector("#gst-3b-summary").textContent = workspace.gstr3b.summary;
  document.querySelector("#gst-3b-caution").textContent = workspace.gstr3b.caution;
  const summary3b = document.querySelector("#gst-3b");
  summary3b.replaceChildren();
  // Issue #286 — a line that is not a box of the form shows only its label.
  workspace.gstr3b.outward.forEach((box) => summary3b.append(detailRow(/^\d/.test(box.boxId) ? `${box.boxId} ${box.label}` : box.label, `${money(box.taxableValue)} + ${money(box.tax)} GST`)));
  // Issue #289, part 3 — the credit boxes, so GST the law blocks (4(B)(1)) is visible, not just netted away.
  (workspace.gstr3b.credit ?? []).filter((box) => box.tax !== 0).forEach((box) => summary3b.append(detailRow(`${box.boxId} ${box.label}`, money(box.tax))));
  workspace.gstr3b.heads.forEach((head) => {
    // Positive means more is owed than there is credit for; negative means credit is left over.
    // Issue #289 — reverse-charge tax is paid in cash; credit pays only the rest (s.49(4)).
    const line = head.reverseChargeCash > 0
      ? [text("gstCashRcm", { cash: money(head.cashToPay), rcm: money(head.reverseChargeCash) }), ...(head.creditLeft > 0 ? [text("gstCreditLeft", { amount: money(head.creditLeft) })] : [])].join(" · ")
      : head.difference > 0
        ? `${words.gstOwe} ${money(head.difference)}`
        : head.difference < 0 ? `${money(-head.difference)} ${words.gstLeftOver}` : "—";
    summary3b.append(detailRow(head.head, line, `${words.gstOwe} ${money(head.liability)} · ${words.gstCredit} ${money(head.credit)}`));
  });

  document.querySelector("#gst-actions-panel").hidden = false;
  // Looking at what a month would say is free and stores nothing, so the screen opens on a
  // computed view with nothing prepared. There is nothing to approve until somebody has pressed
  // "Prepare this month" and a snapshot has been taken, and offering the button before then only
  // produces a refusal a person cannot act on.
  const approve = document.querySelector("#gst-approve");
  approve.disabled = !workspace.prepared || !workspace.mayApprove || workspace.approvedAt !== null;
  approve.title = workspace.prepared ? "" : t({ "en-IN": "Prepare this month first.", "hi-IN": "पहले इस महीने का तैयार कीजिए।" });
  document.querySelector("#gst-export").disabled = workspace.approvedAt === null;
}

submitStep("#gst-return-form", async (form) => {
  try {
    renderGstWorkspace(await api("/api/gst-returns/prepare", { method: "POST", body: JSON.stringify(formValues(form)) }));
    document.querySelector("#gst-action-result").textContent = "";
  } catch (error) { showGstProblem(error.message); }
});

document.querySelector("#gst-approve")?.addEventListener("click", async () => {
  try {
    renderGstWorkspace(await api("/api/gst-returns/approve", {
      method: "POST",
      body: JSON.stringify({ period: gstPeriodValue(), note: document.querySelector("#gst-note").value }),
    }));
    document.querySelector("#gst-action-result").textContent = t({ "en-IN": "Approved. These figures are now fixed against your name.", "hi-IN": "अप्रूव हो गया। अब ये फ़िगर आपके नाम से पक्के हैं।" });
  } catch (error) { document.querySelector("#gst-action-result").textContent = error.message; }
});

document.querySelector("#gst-export")?.addEventListener("click", async () => {
  try {
    const file = await api("/api/gst-returns/export", { method: "POST", body: JSON.stringify({ period: gstPeriodValue(), returnType: "GSTR1" }) });
    document.querySelector("#gst-action-result").textContent = `${file.fileName} — ${file.message}`;
    // Shown rather than downloaded: somebody about to hand a file to the government should be able
    // to look at it first.
    const preview = document.querySelector("#gst-file");
    preview.hidden = false;
    preview.textContent = JSON.stringify(file.payload, null, 2);
  } catch (error) { document.querySelector("#gst-action-result").textContent = error.message; }
});

// ---------------------------------------------------------------------------- issue #31
//
// The purchase comparison. Two lists of the same month — ours and the government's — and the
// difference between them, which is where a shop's money actually goes missing.
//
// The screen is built around one refusal: a bill the portal does not carry contributes nothing to
// what is claimed. It is shown, it is counted, and the button that would claim it anyway asks for
// a reason and keeps the person's name on the line. The other thing worth noticing is that the
// evidence is on the row itself — six fields, both sides — so "why does the app think these are
// the same bill" never needs a phone call.

let itcWorkspace = null;

function itcPeriodValue() {
  const field = document.querySelector("#itc-period");
  if (field.value) return field.value;
  field.value = previousMonth();
  return field.value;
}

function openItc() {
  itcPeriodValue();
  loadItc();
}

async function loadItc() {
  try {
    renderItc(await api("/api/itc", { method: "POST", body: JSON.stringify({ period: itcPeriodValue() }) }));
  } catch (error) {
    showItcProblem(error.message);
  }
}

function showItcProblem(message) {
  document.querySelector("#itc-heading").hidden = false;
  document.querySelector("#itc-month").textContent = t({ "en-IN": "That month could not be compared", "hi-IN": "उस महीने का मिलान नहीं हो पाया" });
  document.querySelector("#itc-summary").textContent = message;
}

function itcDecisionControls(line) {
  const words = copy[state.locale];
  const wrapper = document.createElement("div");
  wrapper.className = "row-actions";

  const reason = document.createElement("input");
  reason.placeholder = words.itcReasonPlaceholder;
  reason.id = `itc-reason-${line.key}`;
  wrapper.append(reason);

  [["ACCEPT", words.itcAccept], ["PENDING", words.itcPending], ["REJECT", words.itcReject]].forEach(([decision, label]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = decision === "ACCEPT" ? "primary-button" : "secondary-button";
    button.textContent = label;
    // A duplicate can never carry credit, so the buttons that would decide it are not offered.
    button.disabled = line.status === "DUPLICATE_IN_BOOKS" || line.status === "DUPLICATE_ON_PORTAL";
    button.addEventListener("click", async () => {
      try {
        renderItc(await api("/api/itc/decide", {
          method: "POST",
          body: JSON.stringify({ period: itcPeriodValue(), lineKey: line.key, decision, reason: reason.value, requestId: newPaymentRequestId() }),
        }));
      } catch (error) {
        document.querySelector("#itc-summary").textContent = error.message;
      }
    });
    wrapper.append(button);
  });

  return wrapper;
}

function renderItc(workspace) {
  itcWorkspace = workspace;
  const words = copy[state.locale];

  document.querySelector("#itc-heading").hidden = false;
  document.querySelector("#itc-month").textContent = workspace.periodLabel;
  document.querySelector("#itc-summary").textContent = workspace.summary;
  const badge = document.querySelector("#itc-status");
  badge.textContent = workspace.portalDataPresent
    ? `${workspace.outcomeCounts.HELD_BACK} ${t({ "en-IN": "waiting", "hi-IN": "बाक़ी" })}`
    : t({ "en-IN": "not checked yet", "hi-IN": "अभी मिला नहीं" });
  badge.className = `pill ${!workspace.portalDataPresent ? "warn" : workspace.outcomeCounts.HELD_BACK > 0 ? "hold" : "done"}`;

  const warnings = document.querySelector("#itc-warnings");
  warnings.replaceChildren();
  workspace.findings.forEach((finding) => warnings.append(simpleRow(finding.message, finding.whatToDo)));

  document.querySelector("#itc-totals-panel").hidden = false;
  document.querySelector("#itc-totals-caution").textContent = workspace.returnLinkage.caution;
  const totals = document.querySelector("#itc-totals");
  totals.replaceChildren();
  totals.append(detailRow(words.itcClaimable, money(workspace.claimable)));
  totals.append(detailRow(words.itcHeldBack, money(workspace.heldBack)));
  // Kept off the held-back line on purpose: held-back credit comes back on the month it is
  // settled, and this does not come back at all. One figure for both would say otherwise.
  if (workspace.timeBarred > 0) totals.append(detailRow(words.itcTimeBarred, money(workspace.timeBarred)));
  if (workspace.atRisk > 0) totals.append(detailRow(words.itcAtRisk, money(workspace.atRisk)));

  const linesPanel = document.querySelector("#itc-lines-panel");
  linesPanel.hidden = workspace.lines.length === 0;
  const lines = document.querySelector("#itc-lines");
  lines.replaceChildren();

  workspace.lines.forEach((line) => {
    const header = `${line.supplier} · ${line.number}`;
    lines.append(simpleRow(`${header} — ${line.statusLabel}`, `${line.outcomeLabel}. ${line.sentence}`));

    // The evidence, on the row. Only the fields that disagree are spelled out in full; the ones
    // that agree are named so it is clear what was actually compared.
    const agreed = line.evidence.filter((row) => row.verdict === "AGREES").map((row) => row.label);
    line.evidence.filter((row) => row.verdict === "DIFFERS").forEach((row) => {
      lines.append(detailRow(row.label, `${words.itcOurs} ${row.ours ?? "—"} · ${words.itcTheirs} ${row.theirs ?? "—"}`));
    });
    if (agreed.length > 0) lines.append(detailRow(t({ "en-IN": "Agrees on", "hi-IN": "ये मिलता है" }), agreed.join(", ")));
    if (line.portalSource === "TYPED") lines.append(detailRow(words.itcTheirs, words.itcTypedFlag));
    // Issue #192 — section 16(4)'s last date, shown on every bill from the day it arrives, not only
    // once it is too late. A barred line says so in the same place.
    if (line.lastClaimDateLabel) {
      lines.append(detailRow(
        t({ "en-IN": "Last date to claim this credit", "hi-IN": "ये क्रेडिट लेने की आख़िरी तारीख़" }),
        line.lastClaimDateLabel,
        line.outcome === "TIME_BARRED"
          ? t({ "en-IN": "That date has gone. The bill stays in your books; only the credit is refused.", "hi-IN": "वो तारीख़ निकल गई। बिल बुक्स में रहेगा; सिर्फ़ क्रेडिट नहीं मिलेगा।" })
          : undefined,
      ));
    }
    if (line.decision !== null) {
      lines.append(detailRow(
        t({ "en-IN": "Your answer", "hi-IN": "आपका जवाब" }),
        `${line.decision.kind}${line.decision.reason ? ` — ${line.decision.reason}` : ""}`,
        line.decision.stale ? t({ "en-IN": "The figures changed after you answered. Look again.", "hi-IN": "जवाब के बाद फ़िगर बदले हैं। दोबारा देखिए।" }) : undefined,
      ));
    }
    line.findings.forEach((finding) => lines.append(simpleRow(finding.message, finding.whatToDo)));
    lines.append(itcDecisionControls(line));
  });
}

submitStep("#itc-form", async () => {
  await loadItc();
});

document.querySelector("#itc-file")?.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  // Read on this device and shown before anything is sent, so a person can see what they are about
  // to import.
  document.querySelector("#itc-content").value = await file.text();
  document.querySelector("#itc-import-result").textContent = `${file.name} — ${t({ "en-IN": "read. Press import when you are ready.", "hi-IN": "पढ़ ली गई। तैयार हों तो इम्पोर्ट दबाइए।" })}`;
});

document.querySelector("#itc-import")?.addEventListener("click", async () => {
  const content = document.querySelector("#itc-content").value.trim();
  if (content === "") {
    document.querySelector("#itc-import-result").textContent = t({ "en-IN": "Choose the file you downloaded, or paste it in first.", "hi-IN": "पहले डाउनलोड की हुई फ़ाइल चुनिए या पेस्ट कीजिए।" });
    return;
  }
  try {
    const workspace = await api("/api/itc/import", {
      method: "POST",
      body: JSON.stringify({ period: itcPeriodValue(), content, fileName: document.querySelector("#itc-file")?.files?.[0]?.name ?? "" }),
    });
    document.querySelector("#itc-import-result").textContent = workspace.imported;
    renderItc(workspace);
  } catch (error) {
    document.querySelector("#itc-import-result").textContent = error.message;
  }
});

submitStep("#itc-typed-form", async (form) => {
  try {
    const workspace = await api("/api/itc/typed", {
      method: "POST",
      body: JSON.stringify({ period: itcPeriodValue(), ...formValues(form) }),
    });
    document.querySelector("#itc-typed-result").textContent = workspace.imported;
    form.reset();
    renderItc(workspace);
  } catch (error) {
    document.querySelector("#itc-typed-result").textContent = error.message;
  }
});

// ------------------------------------------------- issue #181: the customers and items we keep
//
// The Sale screen used to take a customer and an item as typed words, and then print one fixed
// demo customer and one fixed demo product on the bill — a bill of a different sale from the one
// that was made. Every customer and every item is now a record: the pickers below are filled from
// the business's own two lists, and a sale carries the customer and the goods that were chosen,
// on as many lines as it takes.

const catalogue = { customers: [], suppliers: [], items: [], units: [], rates: [], states: [] };
/** Follow-up to #266 — true once the lists have come from the server at least once. */
let catalogueLoaded = false;
/** Issue #182 — the chosen customer's delivery addresses and this business's transporters. */
const delivery = { transporters: [], addresses: [], customerId: null };
const saleForm = () => document.querySelector('[data-draft="sale"]');
/** Issue #311 — which supplier the Purchase screen's supplier check was last run for. */
const supplierCheck = { for: "" };

const itemById = (id) => catalogue.items.find((item) => item.id === id) ?? null;

function blankOption(key) {
  const option = document.createElement("option");
  option.value = "";
  option.textContent = copy[state.locale][key];
  return option;
}

/** Fills every customer and item picker on every screen, keeping what was already chosen. */
function renderPickers() {
  document.querySelectorAll("[data-customer-picker]").forEach((select) => {
    const chosen = select.value;
    select.replaceChildren();
    // Issue #230 — money received starts with nobody chosen, never with the first customer on the list.
    if (select.dataset.pickerBlank) select.append(blankOption(select.dataset.pickerBlank));
    if (catalogue.customers.length === 0) {
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = copy[state.locale].noCustomersYet;
      select.append(empty);
    }
    catalogue.customers.forEach((customer) => {
      const option = document.createElement("option");
      option.value = customer.id;
      option.textContent = customer.walkIn
        ? copy[state.locale].walkInCustomer
        : customer.gstin === null
          ? `${customer.name} · ${customer.stateName ?? ""}`
          : `${customer.name} · ${customer.gstin}`;
      select.append(option);
    });
    const add = document.createElement("option");
    add.value = "__add__";
    add.textContent = copy[state.locale].addCustomer;
    select.append(add);
    if (chosen !== "" && select.querySelector(`option[value="${CSS.escape(chosen)}"]`)) select.value = chosen;
    // Issue #288 — a new sale is to the walk-in customer until somebody else is chosen.
    else if (select === saleCustomerPicker()) select.value = walkInId();
  });

  document.querySelectorAll("[data-item-picker]").forEach((select) => {
    const chosen = select.value;
    select.replaceChildren();
    if (catalogue.items.length === 0) {
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = copy[state.locale].noItemsYet;
      select.append(empty);
    }
    catalogue.items.forEach((item) => {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = `${item.name} · ${item.hsnSac} · ${item.unit}`;
      select.append(option);
    });
    const add = document.createElement("option");
    add.value = "__add__";
    add.textContent = copy[state.locale].addItem;
    select.append(add);
    if (chosen !== "" && select.querySelector(`option[value="${CSS.escape(chosen)}"]`)) select.value = chosen;
  });

  // Issue #228 — the supplier picker on the Purchase screen, from the supplier list.
  document.querySelectorAll("[data-supplier-picker]").forEach((select) => {
    const chosen = select.value;
    select.replaceChildren();
    if (select.dataset.pickerBlank) select.append(blankOption(select.dataset.pickerBlank));
    if (catalogue.suppliers.length === 0) {
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = copy[state.locale].noSuppliersYet;
      select.append(empty);
    }
    catalogue.suppliers.forEach((supplier) => {
      const option = document.createElement("option");
      option.value = supplier.id;
      option.textContent = `${supplier.name} · ${supplier.gstin ?? copy[state.locale].supplierUnregistered}`;
      select.append(option);
    });
    const add = document.createElement("option");
    add.value = "__add__";
    add.textContent = copy[state.locale].addSupplier;
    select.append(add);
    if (chosen !== "" && select.querySelector(`option[value="${CSS.escape(chosen)}"]`)) select.value = chosen;
  });

  // The GST rate on a supplier's bill line, from the same slabs an item is declared at.
  document.querySelectorAll("[data-gst-picker]").forEach((select) => {
    const chosen = select.value;
    select.replaceChildren(...catalogue.rates.map((rate) => {
      const option = document.createElement("option");
      option.value = String(rate.ratePercentTimes100);
      option.textContent = rate.label;
      return option;
    }));
    if (chosen !== "" && select.querySelector(`option[value="${CSS.escape(chosen)}"]`)) select.value = chosen;
    else setLineGstFromItem(select.closest(".sale-line"));
  });

  // Follow-up to #266 — the saved customer or supplier, now that the list is here.
  applyPendingChoices(["party", "partyId", "supplierId", "shipToPartyId"], catalogueLoaded);
  showChosenCustomer();
  showChosenSupplier();
  document.querySelectorAll("#sale-lines .sale-line, #purchase-lines .sale-line").forEach(showLineUnit);
}

/** Issue #228 — the supplier's address, state and GST number, shown before the bill is recorded. */
function showChosenSupplier() {
  const detail = document.querySelector("#purchase-supplier-detail");
  const picker = document.querySelector('[data-draft="purchase"] [data-supplier-picker]');
  if (!detail || !picker) return;
  const supplier = catalogue.suppliers.find((row) => row.id === picker.value) ?? null;
  detail.textContent = supplier === null
    ? ""
    : `${[...supplier.addressLines, supplier.stateName ? `${supplier.stateName} (${supplier.stateCode})` : ""].filter(Boolean).join(", ")} · ${supplier.gstin ?? copy[state.locale].supplierUnregistered}${supplier.registration === "composition" || supplier.registration === "unregistered" ? ` · ${copy[state.locale][supplier.registration === "composition" ? "supplierCompositionHelp" : "supplierUnregisteredHelp"]}` : ""}`;
  // Issue #289 — every line follows the supplier: no GST from one who may not charge it.
  document.querySelectorAll("#purchase-lines .sale-line").forEach(setLineGstFromItem);
  checkPurchaseSupplier(supplier);
}

/**
 * Issue #311 — the supplier check (#19) the moment a supplier is chosen, as one line: "GST number
 * active, filing on time" when the GST department's light is green and nothing needs attention, else
 * the check's own first warning (its wording is kept safe by the check itself). Reads only.
 */
async function checkPurchaseSupplier(supplier) {
  const line = document.querySelector("#purchase-supplier-check");
  if (!line) return;
  if (!supplier?.gstin) { line.hidden = true; supplierCheck.for = ""; return; }
  if (supplierCheck.for === supplier.id) return;
  supplierCheck.for = supplier.id;
  let result = null;
  try { result = await api("/api/suppliers/check", { method: "POST", body: JSON.stringify({ gstin: supplier.gstin, party: supplier.name }) }); } catch { result = null; }
  if (supplierCheck.for !== supplier.id) return;
  const government = result?.lights?.find((light) => light.scope === "GOVERNMENT");
  const fine = result !== null && result.level === "INFORMATION" && government?.colour === "GREEN";
  const worst = result?.warnings?.find((warning) => warning.level === "SERIOUS") ?? result?.warnings?.find((warning) => warning.level === "CAUTION");
  line.className = fine ? "line-ok" : "line-warn";
  line.querySelector("span").textContent = fine ? "✓" : "!";
  line.querySelector("[data-line-text]").textContent = fine ? copy[state.locale].supplierCheckFine
    : result === null ? copy[state.locale].supplierCheckFailed : (worst?.message ?? result.message);
  line.hidden = false;
}

/** A purchase line starts at the rate the business declared for the item; the bill may say otherwise. */
/** Issue #289 — the chosen supplier may not charge GST: not registered (s.32(1)) or composition (s.10(4)). */
function purchaseSupplierChargesNoGst() {
  const picker = document.querySelector('[data-draft="purchase"] [data-supplier-picker]');
  const supplier = catalogue.suppliers.find((row) => row.id === picker?.value) ?? null;
  return supplier !== null && (supplier.registration === "unregistered" || supplier.registration === "composition");
}

function setLineGstFromItem(line) {
  const select = line?.querySelector("[data-gst-picker]");
  if (select && purchaseSupplierChargesNoGst() && line.closest("#purchase-lines")) {
    if (!select.querySelector('option[value="0"]')) select.prepend(new Option("No GST", "0"));
    select.value = "0";
    select.disabled = true;
    return;
  }
  if (select) select.disabled = false;
  const item = itemById(line?.querySelector("[data-line-field=item]")?.value ?? "");
  if (!select || item === null || item.ratePercent === null) return;
  const value = String(Math.round(item.ratePercent * 100));
  if (select.querySelector(`option[value="${CSS.escape(value)}"]`)) select.value = value;
}

/** The address a bill to this customer will carry, shown before it is issued rather than after. */
function showChosenCustomer() {
  const detail = document.querySelector("#sale-customer-detail");
  const picker = document.querySelector('[data-draft="sale"] [data-customer-picker]');
  if (!detail || !picker) return;
  const customer = catalogue.customers.find((row) => row.id === picker.value) ?? null;
  // Issue #288 — the walk-in customer has no address of their own to show or correct.
  const walkIn = customer?.walkIn === true;
  const correct = document.querySelector("#sale-correct-address");
  if (correct) correct.hidden = walkIn;
  const walkInButton = document.querySelector("#sale-walk-in");
  if (walkInButton) walkInButton.hidden = walkIn || walkInId() === "";
  detail.textContent = customer === null
    ? ""
    : walkIn ? text("walkInDetail", { state: customer.stateName ?? "" }) : `${[...customer.addressLines, customer.stateName ?? ""].filter(Boolean).join(", ")}${customer.gstin !== null ? ` · ${customer.gstin}` : customer.registration === "overseas" ? "" : ` · ${copy[state.locale].customerUnregistered}`}${customer.creditLimit === null || customer.creditLimit === undefined ? "" : ` · ${text("customerCreditLimitShown", { amount: money(customer.creditLimit) })}`}`;
  showExportFields(customer);
  // Issue #237 — the state this sale counts in follows the customer the moment it changes, however
  // it changed: picked from the list, just added, or cleared after a bill was issued. The other
  // customer's delivery addresses are dropped at once, so they can never decide this sale's state.
  if (delivery.customerId !== picker.value) {
    delivery.customerId = picker.value;
    delivery.addresses = [];
    if (picker.value !== "") loadDeliveryChoices();
    // Issue #308 — "last charged to them" is about this customer.
    loadSelling();
  }
  showPlaceOfSupply();
  // Issue #305 — a customer just added (or picked from the full list) is shown chosen on the slide.
  if (saleSlides?.current() === "customer") renderSaleCustomerChoices();
}

/** Issue #288 — the Sale screen's customer picker, and the company's walk-in customer on it. */
function saleCustomerPicker() {
  return document.querySelector('[data-draft="sale"] [name="party"]');
}
function walkInId() {
  return catalogue.customers.find((row) => row.walkIn)?.id ?? "";
}

/** Issue #288 — "Paid now" asks how: cash, UPI or card. Money to come later asks nothing, and sends nothing. */
function showPaidBy() {
  const field = document.querySelector("#sale-paid-by-field");
  if (!field) return;
  const terms = document.querySelector("#sale-terms")?.value ?? "now";
  // Issue #305 — the tile says how; only "Part paid" asks again, beside its amount.
  const way = salePayWay();
  field.hidden = way !== "PART";
  // Udhaar sends no paidBy and no amount at all, so nothing is received.
  field.querySelector("select").disabled = terms !== "now";
  const amount = document.querySelector('[data-draft="sale"]')?.elements.namedItem("paidAmount");
  if (amount) amount.disabled = way !== "PART";
  document.querySelector("#sale-part-paid")?.toggleAttribute("hidden", way !== "PART");
  document.querySelector("#sale-udhaar-days")?.toggleAttribute("hidden", way !== "UDHAAR");
  document.querySelectorAll("#sale-pay-tiles [data-pay]").forEach((tile) => tile.setAttribute("aria-pressed", String(tile.dataset.pay === way)));
  document.querySelectorAll("#sale-udhaar-days [data-days]").forEach((chip) => chip.setAttribute("aria-pressed", String(chip.dataset.days === terms)));
}
document.querySelector("#sale-walk-in")?.addEventListener("click", () => {
  const picker = saleCustomerPicker();
  if (!picker || walkInId() === "") return;
  picker.value = walkInId();
  showChosenCustomer();
  saveDraft(picker.form);
});

// ------------------------------------------------- issue #305: a sale in four slides
//
// Items → Customer → Payment → Done, with Transport, Export and Ship to between Payment and Done only
// when this bill needs them. It is the same form as before, field for field, so the review, the
// review key (#233), the stock refusal and its purchase hand-off (#229, #262), the e-invoice decision
// (#239) and the date rules (#266) are exactly the ones every sale already went through. The live
// total (#306) sits in the bar under every slide; the review runs on the Payment slide, and Make bill
// records that review.

/** The four main slides are always there; these three only when the bill needs them. */
const OPTIONAL_SLIDES = {
  transport: () => lastEstimate?.ewayBill?.needed === true || saleReviewState.result?.ewayBill?.outcome === "REQUIRED" || (saleForm()?.elements.namedItem("vehicleNumber")?.value ?? "") !== "",
  export: () => document.querySelector("#sale-export")?.hidden === false,
  shipto: () => saleForm()?.dataset.deliverElsewhere === "yes" || (document.querySelector("#sale-ship-to")?.value ?? "same") !== "same",
};

/** How the customer pays, as the Payment slide's tiles show it. */
function salePayWay() {
  const form = document.querySelector('[data-draft="sale"]'); // not saleForm(): runs while the page loads
  if (!form) return "CASH";
  if ((form.elements.namedItem("terms")?.value ?? "now") !== "now") return "UDHAAR";
  if (form.dataset.payWay === "PART" || (form.elements.namedItem("paidAmount")?.value ?? "") !== "") return "PART";
  return form.elements.namedItem("paidBy")?.value || "CASH";
}

/** A tile pressed: the same three fields the form always sent (terms, paidBy, paidAmount), set for it. */
function chooseSalePayWay(way) {
  const form = saleForm();
  if (!form || way === "CHEQUE") return;
  const terms = form.elements.namedItem("terms");
  const paidBy = form.elements.namedItem("paidBy");
  const amount = form.elements.namedItem("paidAmount");
  form.dataset.payWay = way;
  if (way === "UDHAAR") {
    // Thirty days unless another is tapped: the usual credit a shop gives, shown pressed.
    if (terms.value === "now") terms.value = "30";
    amount.value = "";
  } else {
    terms.value = "now";
    if (way === "PART") amount.disabled = false;
    else { paidBy.value = way; amount.value = ""; }
  }
  showPaidBy();
  saveDraft(form);
  updateCalculations();
  queueSaleReview();
  if (way === "PART") amount.focus();
}

document.querySelector("#sale-pay-tiles")?.addEventListener("click", (event) => {
  const tile = event.target.closest("[data-pay]");
  if (tile && !tile.disabled) chooseSalePayWay(tile.dataset.pay);
});
document.querySelector("#sale-udhaar-days")?.addEventListener("click", (event) => {
  const chip = event.target.closest("[data-days]");
  const form = saleForm();
  if (!chip || !form) return;
  form.elements.namedItem("terms").value = chip.dataset.days;
  showPaidBy();
  saveDraft(form);
  updateCalculations();
  queueSaleReview();
});

/** Customers to tap: Walk-in first, then the ones who owe the most, then the rest, six in all. */
function renderSaleCustomerChoices() {
  const box = document.querySelector("#sale-customer-choices");
  const picker = saleCustomerPicker();
  if (!box || !picker) return;
  const owed = new Map();
  (state.dashboard?.customer?.documents ?? []).forEach((bill) => owed.set(bill.party, (owed.get(bill.party) ?? 0) + Math.round(Number(bill.outstanding) * 100)));
  const others = catalogue.customers.filter((row) => !row.walkIn)
    .sort((a, b) => (owed.get(b.name) ?? 0) - (owed.get(a.name) ?? 0) || a.name.localeCompare(b.name));
  const chosen = catalogue.customers.find((row) => row.id === picker.value);
  // Drawn again after a choice: the keyboard stays on the customer just chosen, not lost to the page.
  const hadFocus = box.contains(document.activeElement);
  queueMicrotask(() => { if (hadFocus) box.querySelector('[aria-pressed="true"]')?.focus(); });
  const shown = [...catalogue.customers.filter((row) => row.walkIn), ...others.slice(0, 5)];
  if (chosen && !shown.includes(chosen)) shown.push(chosen);
  box.replaceChildren(...shown.map((customer) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip customer-choice";
    button.setAttribute("aria-pressed", String(customer.id === picker.value));
    const name = document.createElement("span");
    name.textContent = customer.walkIn ? copy[state.locale].walkInCustomer : customer.name;
    button.append(name);
    const owes = owed.get(customer.name) ?? 0;
    if (!customer.walkIn && owes > 0) {
      const due = document.createElement("small");
      due.textContent = text("customerOwes", { amount: money(owes / 100) });
      button.append(" ", due);
    }
    button.addEventListener("click", () => {
      picker.value = customer.id;
      showChosenCustomer();
      saveDraft(picker.form);
      updateCalculations();
      renderSaleCustomerChoices();
    });
    return button;
  }));
}

/** "+ New: type GST number or mobile": the add-customer box, with what was typed already in it. */
document.querySelector("#sale-new-customer-go")?.addEventListener("click", () => {
  const typed = document.querySelector("#sale-new-customer")?.value.trim() ?? "";
  const form = document.querySelector("#customer-form");
  if (!form) return;
  form.reset();
  const compact = typed.replace(/\s/g, "").toUpperCase();
  const gstin = /^\d{2}[A-Z0-9]{13}$/.test(compact);
  const mobile = !gstin && /^(\+?91)?[6-9]\d{9}$/.test(compact);
  form.elements.namedItem("registration").value = gstin ? "regular" : "unregistered";
  if (gstin) form.elements.namedItem("gstin").value = compact;
  else if (mobile) form.elements.namedItem("phone").value = compact.slice(-10);
  else form.elements.namedItem("legalName").value = typed;
  showCustomerRegistrationFields();
  pickerAwaitingNewRecord = saleCustomerPicker();
  document.querySelector("#customer-dialog")?.showModal();
});

document.querySelector("#sale-new-customer")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); document.querySelector("#sale-new-customer-go")?.click(); }
});

document.querySelector("#sale-deliver-elsewhere")?.addEventListener("click", (event) => {
  const form = saleForm();
  if (!form) return;
  const on = form.dataset.deliverElsewhere !== "yes";
  if (on) form.dataset.deliverElsewhere = "yes"; else delete form.dataset.deliverElsewhere;
  event.currentTarget.setAttribute("aria-pressed", String(on));
  if (!on) { document.querySelector("#sale-ship-to").value = "same"; showShipToFields(); saveDraft(form); updateCalculations(); }
  updateSaleBar();
});

/** The review on the Payment slide, asked again once the owner stops changing it (one at a time). */
function queueSaleReview(delay = 300) {
  clearTimeout(saleReviewState.timer);
  saleReviewState.timer = setTimeout(() => { saleReviewState.queue = saleReviewState.queue.then(reviewSaleOnSlide); }, delay);
}

/** What a review is for: the form as it is, with its lines. A change makes the review on screen old. */
const saleReviewKey = (form) => JSON.stringify({ ...draftData(form), lines: saleLineValues() });

/**
 * Runs the sale review (/api/sales/preview) for the Payment slide. The same request the Review button
 * used to send: the lines as typed, one key per review (#233), and the review it replaces (#256).
 * A refusal (goods short, a walk-in over ₹50,000, a date the bill cannot carry) opens the same box
 * as before, with the same way through ("Enter the purchase bill").
 */
async function reviewSaleOnSlide() {
  const form = saleForm();
  if (!form || !state.signedIn || saleLineValues().length === 0) return null;
  const key = saleReviewKey(form);
  if (saleReviewState.forInput === key && saleReviewState.result) return saleReviewState.result;
  saveDraft(form);
  const input = draftData(form);
  // Issue #181 — the lines as they are on the screen go with the request, so what was typed is
  // what is priced, what is stored and what prints.
  input.lines = JSON.stringify(saleLineValues());
  // Issue #233 — one key per review. Make bill sends this same review, so pressing it twice issues
  // one bill; the next review is a new sale with a new key.
  input.requestId = newPaymentRequestId();
  // Issue #256 — the review this one replaces. It was never issued, so the server forgets it
  // instead of keeping it as "a bill waiting".
  if (form.dataset.saleReview) input.replaces = form.dataset.saleReview;
  form.dataset.saleReview = input.requestId;
  const box = document.querySelector('[data-slide="payment"]');
  box?.setAttribute("aria-busy", "true");
  try {
    const result = await api("/api/sales/preview", { method: "POST", body: JSON.stringify(input) });
    state.pendingForm = form;
    state.pendingInput = input;
    state.pendingReturnInput = null;
    saleReviewState.result = result;
    saleReviewState.forInput = key;
    renderSaleReview();
    return result;
  } catch (error) {
    saleReviewState.result = null;
    saleReviewState.forInput = "";
    state.pendingInput = null;
    renderSaleReview();
    showSaleFailure(error);
    return null;
  } finally {
    box?.removeAttribute("aria-busy");
    updateSaleBar();
  }
}

/** The Payment slide's two lines: what the law needs, happening by itself, and at most one warning. */
function renderSaleReview() {
  const result = saleReviewState.result;
  const ok = document.querySelector("#sale-review-ok");
  const warn = document.querySelector("#sale-review-warning");
  if (!ok || !warn) return;
  const shown = result === null ? null : saleReview({ ...result, ewayNotNeeded: lastEstimate?.ewayBill?.needed === false }, localizeResult(result, "sale", "preview"));
  ok.hidden = !shown?.fine;
  ok.querySelector("[data-line-text]").textContent = shown?.fine ?? "";
  warn.hidden = !shown?.warning;
  warn.querySelector("[data-line-text]").textContent = shown?.warning ?? "";
  document.querySelector("#sale-review-turnover").hidden = !shown?.askTurnover;
  saleReviewState.warning = shown?.warning ?? null;
}

/** The bill bar: Back, what the customer pays, and Next — or Make bill on the last slide. */
function updateSaleBar() {
  if (!saleSlides) return;
  const now = saleSlides.current();
  const bar = document.querySelector("#sale-bill-bar");
  if (bar) bar.hidden = now === "done";
  const back = document.querySelector("#sale-back");
  if (back) back.hidden = now === "items" || now === "done";
  const next = document.querySelector("#sale-next");
  if (next && !next.disabled) next.textContent = copy[state.locale][saleSlides.isLast() ? "makeBill" : "slideNext"];
}

/** Make bill: the review on screen, recorded — reviewed again first if anything changed since. */
async function makeSaleBill(button) {
  const form = saleForm();
  if (!form) return;
  button.disabled = true;
  try {
    const shownWarning = saleReviewState.warning;
    clearTimeout(saleReviewState.timer);
    await saleReviewState.queue;
    const review = await (saleReviewState.queue = saleReviewState.queue.then(reviewSaleOnSlide));
    if (review === null) return;
    // A warning the owner has not seen yet is shown before any bill is made.
    if (saleReviewState.warning && saleReviewState.warning !== shownWarning) { saleSlides.show("payment"); return; }
    // Issue #301 — someone who may approve it says why first, in the review box; Record once issues it.
    if (review.approval?.required && review.approval.canApprove) { showDialog({ ...localizeResult(review, "sale", "preview"), approval: review.approval }, "preview"); return; }
  } finally { button.disabled = false; }
  await recordPending(button);
}

async function saleNext(event) {
  if (!saleSlides) return;
  if (saleSlides.isLast()) { await makeSaleBill(event.currentTarget); return; }
  // A bill needs at least one item: back to the search box, which says so.
  if (saleSlides.current() === "items" && saleLineValues().length === 0) {
    document.querySelector('#sale-lines [data-item-search]')?.focus();
    return;
  }
  saleSlides.next();
}

/** Called when the sale screen is opened again: the slide it was on is read again. */
function saleSlidesShown() {
  if (!saleSlides) return;
  if (saleSlides.current() === "payment") { saleReviewState.forInput = ""; queueSaleReview(0); }
  // + Bill after a finished bill is the next bill, not the last one's done screen.
  if (saleSlides.current() === "done") startNewSaleSlides();
}

/** New bill from the done slide: the form is already fresh (#233); back to the first slide. */
function startNewSaleSlides() {
  // The last bill's live total and review are not this bill's: no Transport slide until it needs one.
  lastEstimate = null;
  saleReviewState.result = null;
  saleReviewState.forInput = "";
  renderSaleReview();
  saleSlides?.show("items");
  document.querySelector('#sale-lines [data-item-search]')?.focus();
}

// Issue #311 — the vehicle check (#29) on the number typed in the Transport slide, as one line.
let vehicleCheckTimer = null;
async function checkSaleVehicle() {
  const line = document.querySelector("#sale-vehicle-check");
  const typed = (saleForm()?.elements.namedItem("vehicleNumber")?.value ?? "").toUpperCase().replace(/[\s-]/g, "");
  if (!line) return;
  if (!/^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{4}$/.test(typed)) { line.hidden = true; return; }
  let found = null;
  try { found = await api("/api/vehicles/record", { method: "POST", body: JSON.stringify({ vehicle: typed }) }); } catch { found = null; }
  if ((saleForm()?.elements.namedItem("vehicleNumber")?.value ?? "").toUpperCase().replace(/[\s-]/g, "") !== typed) return;
  const kind = found?.kind === "FOUND" ? "vehicleFound" : found?.kind === "NOT_FOUND" ? "vehicleNotFound" : "vehicleNotChecked";
  line.className = kind === "vehicleFound" ? "line-ok" : "line-warn";
  line.querySelector("span").textContent = kind === "vehicleFound" ? "✓" : "!";
  line.querySelector("[data-line-text]").textContent = `${text(kind, { vehicle: typed })}${kind === "vehicleFound" && state.locale === "en-IN" && found?.message ? ` ${found.message}` : ""}`;
  line.hidden = false;
}

function mountSaleSlides() {
  const frame = document.querySelector("#sale-frame");
  if (!frame || !globalThis.KarobarSlides) return;
  saleSlides = globalThis.KarobarSlides.mountSlides(frame, {
    wanted: (id) => OPTIONAL_SLIDES[id]?.() ?? false,
    words: () => copy[state.locale],
    onShow: (id) => {
      if (id === "customer") renderSaleCustomerChoices();
      if (id === "payment") { showPaidBy(); renderSaleReview(); queueSaleReview(0); }
      if (id === "transport") checkSaleVehicle();
      updateSaleBar();
    },
  });
  document.querySelector("#sale-next")?.addEventListener("click", saleNext);
  document.querySelector("#sale-back")?.addEventListener("click", () => saleSlides.back());
  const form = saleForm();
  form?.addEventListener("input", (event) => {
    if (event.target.name === "vehicleNumber") { clearTimeout(vehicleCheckTimer); vehicleCheckTimer = setTimeout(checkSaleVehicle, 500); }
    if (saleSlides.current() === "payment") queueSaleReview();
    updateSaleBar();
  });
  form?.addEventListener("change", () => { if (saleSlides.current() === "payment") queueSaleReview(); updateSaleBar(); });
  // Freight typed on a saved draft is shown, not hidden in a closed box.
  const charges = document.querySelector("#sale-charges");
  if (charges && form && (form.elements.namedItem("freight").value || form.elements.namedItem("otherCharges").value)) charges.open = true;
  saleSlides.show("items", { focus: false });
  showPaidBy();
}

document.querySelector("#sale-new-item")?.addEventListener("click", () => openNewItem({ name: "" }, null));
// Issue #305 — the − / + on a line card: one more or one less, never below one (type 0.5 into the box).
document.querySelector("#sale-lines")?.addEventListener("click", (event) => {
  const step = event.target.closest("[data-step]");
  if (!step) return;
  const quantity = step.closest(".sale-line")?.querySelector("[data-line-field=quantity]");
  if (!quantity) return;
  const next = Math.round(((Number(quantity.value) || 0) + Number(step.dataset.step)) * 1000) / 1000;
  quantity.value = String(Math.max(1, next));
  saveDraft(saleForm());
  updateCalculations();
});
mountSaleSlides();

/**
 * Issue #143 — the export or SEZ box, for the customers it applies to. Which kind of supply it is
 * comes from the customer's record; the fields that only an export abroad has are switched off for
 * an SEZ or deemed-export customer, so they are not sent at all.
 */
function showExportFields(customer) {
  const box = document.querySelector("#sale-export");
  if (!box) return;
  const kind = { overseas: "exportKindOverseas", sez_with_payment: "exportKindSez", sez_without_payment: "exportKindSez", deemed_export: "exportKindDeemed" }[customer?.registration ?? ""];
  box.hidden = kind === undefined;
  box.querySelectorAll("input, select").forEach((field) => { field.disabled = kind === undefined; });
  if (kind === undefined) return;
  document.querySelector("#sale-export-kind").textContent = copy[state.locale][kind];
  box.querySelectorAll("[data-export-abroad]").forEach((label) => {
    label.hidden = customer.registration !== "overseas";
    label.querySelectorAll("input, select").forEach((field) => { field.disabled = label.hidden; });
  });
}

/** The unit beside a quantity is the chosen item's own unit, never a hard-coded word. */
function showLineUnit(line) {
  const item = itemById(line.querySelector("[data-line-field=item]")?.value ?? "");
  const unit = line.querySelector("[data-line-unit]");
  if (unit) unit.textContent = item === null ? "—" : item.unit;
  linePickers.get(line)?.show(item);
  setLineFacts(line, item?.ratePercent ?? null);
}

/**
 * Issue #305 — the card says the line's GST and how much is left in the godown (Home's stock). The
 * rate is the one the live total charged on this line once it has answered, else the item's own.
 */
function setLineFacts(line, rate) {
  const facts = line.querySelector("[data-line-facts]");
  if (!facts) return;
  const item = itemById(line.querySelector("[data-line-field=item]")?.value ?? "");
  const stock = item === null ? undefined : state.dashboard?.stockItems?.find((row) => row.itemId === item.id);
  facts.textContent = item === null || rate === null ? ""
    : stock ? text("lineFacts", { rate, stock: `${new Intl.NumberFormat(state.locale, { maximumFractionDigits: 3 }).format(stock.quantity)} ${stock.unit}` })
      : text("lineFactsGst", { rate });
}

function addSaleLine() {
  const template = document.querySelector("#sale-line-template");
  const lines = document.querySelector("#sale-lines");
  if (!template || !lines) return null;
  const line = template.content.firstElementChild.cloneNode(true);
  lines.append(line);
  mountLinePicker(line);
  translate();
  renderPickers();
  updateCalculations();
  return line;
}

/**
 * Issue #233 — a fresh, empty sale: no customer chosen, one new line, today's date, nothing from the
 * last bill left in the delivery or reference boxes, and no saved draft to bring it back.
 */
function resetSaleForm(form) {
  storage?.removeItem(`karobar.draft.${form.dataset.draft}`);
  hideDraftDateNote(form);
  forgetPendingDraft(form);
  form.reset();
  // Issue #305 — cash again, and delivered at the counter again.
  delete form.dataset.payWay;
  delete form.dataset.deliverElsewhere;
  form.querySelectorAll('input[type="date"]:not([data-no-default])').forEach((field) => { field.value = dateInput(); });
  // Issue #288 — the next customer at the counter is a walk-in until somebody else is chosen.
  const picker = form.querySelector("[data-customer-picker]");
  if (picker) picker.value = walkInId();
  document.querySelector("#sale-lines")?.replaceChildren();
  addSaleLine();
  form.querySelectorAll("details").forEach((box) => { if (box.id !== "sale-export") box.open = false; });
  showPaidBy();
  showChosenCustomer();
  showShipToFields();
  updateCalculations();
}

/**
 * Issue #262 — after a supplier bill is recorded the Purchase form is a fresh one: one new line, today's
 * date, no bill number or amount from the bill just recorded. Otherwise the next purchase (the one
 * a stopped sale sends the person to make) opens showing the last bill's figures.
 */
function resetPurchaseForm(form) {
  form.reset();
  form.querySelectorAll('input[type="date"]:not([data-no-default])').forEach((field) => { field.value = dateInput(); });
  document.querySelector("#purchase-lines")?.replaceChildren();
  addPurchaseLine();
  clearReverseChargeQuestions(form);
  showChosenSupplier();
}

/** Issue #228 — a supplier bill carries as many lines as it has, like a sale. */
function addPurchaseLine() {
  const template = document.querySelector("#purchase-line-template");
  const lines = document.querySelector("#purchase-lines");
  if (!template || !lines) return null;
  const line = template.content.firstElementChild.cloneNode(true);
  lines.append(line);
  // Issue #308 — the same item picker as a sale line.
  mountLinePicker(line);
  translate();
  renderPickers();
  setLineGstFromItem(line);
  return line;
}

/** The supplier bill's lines as typed: item, how many, price of one, and the GST rate on the bill. */
function purchaseLineValues() {
  return [...document.querySelectorAll("#purchase-lines .sale-line")].map((line) => ({
    itemId: line.querySelector("[data-line-field=item]")?.value ?? "",
    quantity: line.querySelector("[data-line-field=quantity]")?.value ?? "",
    unit: itemById(line.querySelector("[data-line-field=item]")?.value ?? "")?.unit ?? "",
    rate: line.querySelector("[data-line-field=rate]")?.value ?? "",
    gst: line.querySelector("[data-line-field=gst]")?.value ?? "",
    // Issue #289, part 3 — blank: the credit can be claimed; otherwise the s.17(5) reason chosen.
    blocked: line.querySelector("[data-line-field=blocked]")?.value ?? "",
  }));
}

/**
 * What the person typed, line by line: the same lines that are priced, stored and printed. Issue
 * #308 — a line with no item chosen (the empty one waiting for the next scan) is left out.
 */
function saleLineValues() {
  return [...document.querySelectorAll("#sale-lines .sale-line")].filter((line) => (line.querySelector("[data-line-field=item]")?.value ?? "") !== "").map((line) => ({
    itemId: line.querySelector("[data-line-field=item]")?.value ?? "",
    quantity: line.querySelector("[data-line-field=quantity]")?.value ?? "",
    unit: itemById(line.querySelector("[data-line-field=item]")?.value ?? "")?.unit ?? "",
    rate: line.querySelector("[data-line-field=rate]")?.value ?? "",
  }));
}

// ------------------------------------------------- issue #308: find an item fast
//
// Each sale line's item box is the shared picker (item-picker.js): search by name, other name,
// code, HSN or barcode, most-sold first. A scan — into a box, or with no box focused — adds the item,
// or one more of it when it is already on the bill. The six items on most bills this week sit above
// the lines as chips. A new line starts at the price this customer was last charged, else the
// item's usual price, and the person can change it.

/** Bills per item, the week's most-sold, and this customer's last prices, from /api/items/selling. */
const selling = { sold: {}, mostSoldThisWeek: [], lastPrices: {} };
const linePickers = new WeakMap();
const pickerWords = () => ({ newItem: copy[state.locale].newItemFromSearch, newItemCode: copy[state.locale].newItemWithCode, noMatch: copy[state.locale].noItemMatch, scan: copy[state.locale].scanButton, scanTitle: copy[state.locale].scanTitle, scanHint: copy[state.locale].scanHint, scanCancel: copy[state.locale].cancel });
const cameraRefused = () => showDialog({ title: copy[state.locale].scanTitle, message: copy[state.locale].cameraRefused, effects: [] }, "failed");

async function loadSelling() {
  if (!state.signedIn) return;
  const customerId = saleForm()?.elements.namedItem("party")?.value ?? "";
  try {
    Object.assign(selling, await api("/api/items/selling", { method: "POST", body: JSON.stringify({ customerId }) }));
  } catch { return; }
  renderItemChips();
  // Issue #305 — items come first, the customer after: a price the app filled in (and nobody has
  // changed since) follows the customer to what they were last charged.
  let moved = false;
  document.querySelectorAll("#sale-lines .sale-line").forEach((line) => {
    const rate = line.querySelector("[data-line-field=rate]");
    const item = itemById(line.querySelector("[data-line-field=item]")?.value ?? "");
    if (!rate || item === null || rate.dataset.filled !== rate.value) return;
    const start = startingPrice(item);
    if (!start) return;
    rate.value = rate.dataset.filled = String(start.price);
    const note = line.querySelector("[data-line-price-note]");
    if (note) note.textContent = start.note;
    moved = true;
  });
  if (moved) { saveDraft(saleForm()); updateCalculations(); }
}

function renderItemChips() {
  const box = document.querySelector("#sale-item-chips");
  if (!box) return;
  const top = selling.mostSoldThisWeek.map(itemById).filter(Boolean);
  box.hidden = top.length === 0;
  box.replaceChildren(...top.map((item) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = `＋ ${item.name}`;
    chip.addEventListener("click", () => addItemToSale(item));
    return chip;
  }));
}

/** Which bill a line is on: "sale" or "purchase". */
const flowOf = (line) => (line.closest?.("#purchase-lines") ? "purchase" : "sale");

function mountLinePicker(line) {
  const input = line.querySelector("[data-item-search]");
  if (!input || !globalThis.KarobarItemPicker) return;
  const flow = flowOf(line);
  linePickers.set(line, globalThis.KarobarItemPicker.createItemPicker({
    input,
    items: () => catalogue.items,
    sold: () => selling.sold,
    words: pickerWords,
    onPick: (item) => putItemOnLine(line, item),
    onScan: (item) => addItemToLines(item, flow, line),
    onCreate: (typed) => openNewItem(typed, line),
    onCameraError: cameraRefused,
  }));
}

/** The price a new line starts at: last charged to this customer, else the item's usual price. */
function startingPrice(item) {
  const last = selling.lastPrices[item.id];
  // Issue #288 — for the walk-in customer, "last time" is the last counter sale.
  const counter = catalogue.customers.find((row) => row.id === saleForm()?.elements.namedItem("party")?.value)?.walkIn === true;
  if (last) return { price: last.price, note: text(counter ? "priceLastCounter" : "priceLastCharged", { amount: money(last.price), date: new Intl.DateTimeFormat(state.locale, { day: "numeric", month: "short", timeZone: "Asia/Kolkata" }).format(new Date(`${last.date}T12:00:00+05:30`)) }) };
  if (item.price !== null && item.price !== undefined) return { price: item.price, note: copy[state.locale].priceUsual };
  return null;
}

function setLineItem(line, item) {
  line.querySelector("[data-line-field=item]").value = item.id;
  const start = startingPrice(item);
  const rate = line.querySelector("[data-line-field=rate]");
  if (rate) {
    if (start) rate.value = String(start.price);
    // What the app put there, so a customer chosen later can move it (#305) until somebody types a price.
    rate.dataset.filled = rate.value;
  }
  const note = line.querySelector("[data-line-price-note]");
  if (note) note.textContent = start?.note ?? "";
  showLineUnit(line);
  const form = saleForm();
  if (form) saveDraft(form);
  updateCalculations();
}

/**
 * A supplier bill's line gets its item, the GST rate the business declared for it (the supplier's
 * bill may say otherwise, and the person changes it there) and its unit. Its price is on the
 * supplier's bill, so it is never filled in.
 */
function choosePurchaseItem(line, item) {
  line.querySelector("[data-line-field=item]").value = item.id;
  setLineGstFromItem(line);
  showLineUnit(line);
  const form = document.querySelector('[data-draft="purchase"]');
  if (form) saveDraft(form);
}

const putItemOnLine = (line, item) => (flowOf(line) === "purchase" ? choosePurchaseItem(line, item) : setLineItem(line, item));

/** A scan or a chip: one more on the line that has the item, else the first empty line, else a new line. */
function addItemToLines(item, flow, fromLine = null) {
  const lines = [...document.querySelectorAll(`#${flow}-lines .sale-line`)];
  const itemOf = (line) => line.querySelector("[data-line-field=item]")?.value ?? "";
  const same = lines.find((line) => itemOf(line) === item.id);
  if (same) {
    const quantity = same.querySelector("[data-line-field=quantity]");
    quantity.value = String(Math.round(((Number(quantity.value) || 0) + 1) * 1000) / 1000);
    const form = document.querySelector(`[data-draft="${flow}"]`);
    if (form) saveDraft(form);
    updateCalculations();
    return;
  }
  const empty = fromLine && itemOf(fromLine) === "" ? fromLine : lines.find((line) => itemOf(line) === "");
  putItemOnLine(empty ?? (flow === "purchase" ? addPurchaseLine() : addSaleLine()), item);
}

const addItemToSale = (item) => addItemToLines(item, "sale");

/** "+ New item" from the picker, or a barcode nobody has: the add-item dialog, with what was typed. */
function openNewItem(typed, line, flow = "sale") {
  const target = line ?? [...document.querySelectorAll(`#${flow}-lines .sale-line`)].find((row) => row.querySelector("[data-line-field=item]").value === "") ?? (flow === "purchase" ? addPurchaseLine() : addSaleLine());
  pickerAwaitingNewRecord = target.querySelector("[data-line-field=item]");
  const form = document.querySelector("#item-form");
  form.reset();
  form.elements.namedItem("name").value = typed.name ?? "";
  form.elements.namedItem("barcode").value = typed.barcode ?? "";
  document.querySelector("#item-other-rate").hidden = document.querySelector("#item-tax")?.value !== "other";
  document.querySelector("#item-dialog")?.showModal();
}

globalThis.KarobarItemPicker?.listenForScanner(document, (code) => {
  const flow = state.view;
  if ((flow !== "sale" && flow !== "purchase") || document.querySelector("dialog[open]")) return;
  const item = globalThis.KarobarItemPicker.findByCode(catalogue.items, code);
  if (item) addItemToLines(item, flow);
  else openNewItem({ name: "", barcode: code }, null, flow);
});

async function loadCatalogue() {
  try {
    const read = await api("/api/catalogue");
    catalogue.customers = read.customers;
    catalogue.suppliers = read.suppliers ?? [];
    catalogue.items = read.items;
    catalogue.units = read.units;
    catalogue.rates = read.rates;
    catalogue.states = read.states;
    catalogueLoaded = true;
  } catch { return; }
  for (const states of [document.querySelector("#customer-states"), document.querySelector("#supplier-states")]) {
    if (!states) continue;
    states.replaceChildren(...catalogue.states.map((row) => {
      const option = document.createElement("option");
      option.value = row.code;
      option.textContent = `${row.name} (${row.code})`;
      return option;
    }));
    // Issue #289 — a supplier's state is never assumed: it is filled from the PIN code, or chosen.
    if (states.id === "supplier-states") { states.prepend(new Option(copy[state.locale].supplierBasisChoose === undefined ? "" : "—", "")); states.value = ""; }
  }
  const units = document.querySelector("#item-units");
  if (units) {
    units.replaceChildren(...catalogue.units.map((unit) => {
      const option = document.createElement("option");
      option.value = unit.code;
      option.textContent = `${unit.name} (${unit.code})`;
      return option;
    }));
  }
  const taxes = document.querySelector("#item-tax");
  if (taxes) {
    const choices = [
      ...catalogue.rates.map((rate) => ({ value: String(rate.ratePercentTimes100), label: rate.label })),
      { value: "exempt", label: copy[state.locale].itemExempt },
      { value: "other", label: copy[state.locale].itemOtherRateChoice },
    ];
    taxes.replaceChildren(...choices.map((choice) => {
      const option = document.createElement("option");
      option.value = choice.value;
      option.textContent = choice.label;
      return option;
    }));
  }
  if (document.querySelectorAll("#sale-lines .sale-line").length === 0) addSaleLine();
  if (document.querySelectorAll("#purchase-lines .sale-line").length === 0) addPurchaseLine();
  renderPickers();
  // Follow-up to #266 — a draft's item lines come back once there are items to choose from.
  restorePendingLines();
  loadSelling();
  renderReminderCustomers();
  document.querySelectorAll('form[data-endpoint="payments"]').forEach((form) => loadPaymentBills(form));
}

/** "Add new customer" and "Add new item" are choices in the picker itself, where they are needed. */
let pickerAwaitingNewRecord = null;

document.addEventListener("change", (event) => {
  const select = event.target;
  if (!(select instanceof HTMLSelectElement)) return;
  if (select.matches("[data-customer-picker]") && select.value === "__add__") {
    pickerAwaitingNewRecord = select;
    select.value = select.dataset.pickerBlank ? "" : catalogue.customers[0]?.id ?? "";
    // Issue #237 — the sale's state hint follows the picker even while the new customer is typed in.
    showChosenCustomer();
    showCustomerRegistrationFields();
    document.querySelector("#customer-dialog")?.showModal();
    return;
  }
  if (select.matches("[data-supplier-picker]") && select.value === "__add__") {
    pickerAwaitingNewRecord = select;
    select.value = select.dataset.pickerBlank ? "" : catalogue.suppliers[0]?.id ?? "";
    document.querySelector("#new-supplier-dialog")?.showModal();
    return;
  }
  if (select.matches("[data-item-picker]") && select.value === "__add__") {
    pickerAwaitingNewRecord = select;
    select.value = catalogue.items[0]?.id ?? "";
    document.querySelector("#item-other-rate").hidden = document.querySelector("#item-tax")?.value !== "other";
    document.querySelector("#item-dialog")?.showModal();
    return;
  }
  if (select.matches("[data-customer-picker]")) showChosenCustomer();
  if (select.matches("[data-supplier-picker]")) showChosenSupplier();
  if (select.matches("[data-line-field=item]")) {
    showLineUnit(select.closest(".sale-line"));
    if (select.closest("#purchase-lines")) setLineGstFromItem(select.closest(".sale-line"));
  }
});

// Issue #305 — the new line's search box takes the next item straight away.
document.querySelector("#sale-add-line")?.addEventListener("click", () => addSaleLine()?.querySelector("[data-item-search]")?.focus());
document.querySelector("#sale-lines")?.addEventListener("click", (event) => {
  if (!event.target.closest("[data-remove-line]")) return;
  // One line is the least a bill can carry, so the last one stays.
  if (document.querySelectorAll("#sale-lines .sale-line").length <= 1) return;
  event.target.closest(".sale-line").remove();
  updateCalculations();
});

document.querySelector("#purchase-add-line")?.addEventListener("click", () => addPurchaseLine());
document.querySelector("#purchase-lines")?.addEventListener("click", (event) => {
  if (!event.target.closest("[data-remove-line]")) return;
  if (document.querySelectorAll("#purchase-lines .sale-line").length <= 1) return;
  event.target.closest(".sale-line").remove();
});

document.querySelectorAll("[data-close-dialog]").forEach((button) => {
  button.addEventListener("click", () => button.closest("dialog")?.close());
});

/**
 * A customer with no GST number has no GST number to ask for, and their state becomes a choice.
 * For everybody else the state is the first two digits of the GST number, so the form does not
 * offer a second answer that could disagree with it.
 */
function showCustomerRegistrationFields() {
  const registration = document.querySelector('#customer-form [name="registration"]')?.value;
  const unregistered = registration === "unregistered";
  // Issue #143 — a customer abroad has no GST number, no Indian state and no PIN code.
  const overseas = registration === "overseas";
  document.querySelector("#customer-gstin-field").hidden = unregistered || overseas;
  document.querySelector("#customer-state-field").hidden = !unregistered;
  const pincode = document.querySelector("#customer-pincode-field");
  pincode.hidden = overseas;
  pincode.querySelector("input").required = !overseas;
}
document.querySelector('#customer-form [name="registration"]')?.addEventListener("change", showCustomerRegistrationFields);
// Issue #288 — the state is filled in from the PIN code. A PIN two states share is left for the person.
document.querySelector('#customer-form [name="pincode"]')?.addEventListener("input", async (event) => {
  const pincode = event.target.value.trim();
  if (!/^[1-9]\d{5}$/.test(pincode)) return;
  try {
    const found = await api("/api/pincode/state", { method: "POST", body: JSON.stringify({ pincode }) });
    const states = document.querySelector("#customer-states");
    if (found.stateCode && states && event.target.value.trim() === pincode) states.value = found.stateCode;
  } catch { /* the person can still choose the state */ }
});

document.querySelector("#customer-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const error = document.querySelector("#customer-error");
  error.textContent = "";
  const values = Object.fromEntries(new FormData(form));
  if (values.registration !== "unregistered") delete values.stateCode;
  if (values.registration === "overseas") { delete values.pincode; delete values.gstin; }
  try {
    const created = await api("/api/customers", { method: "POST", body: JSON.stringify(values) });
    await loadCatalogue();
    if (pickerAwaitingNewRecord) {
      pickerAwaitingNewRecord.value = created.customer.id;
      showChosenCustomer();
      if (pickerAwaitingNewRecord.matches("[data-payment-party]")) loadPaymentBills(pickerAwaitingNewRecord.form);
    }
    form.reset();
    showCustomerRegistrationFields();
    document.querySelector("#customer-dialog").close();
  } catch (requestError) { error.textContent = requestError.message; }
});

// Issue #289 — what each kind of supplier means, and the fields each needs.
function showSupplierRegistrationFields() {
  const registration = document.querySelector("#supplier-registration")?.value ?? "regular";
  const unregistered = registration === "unregistered";
  document.querySelector("#supplier-gstin-field").hidden = unregistered;
  document.querySelector('#new-supplier-form [name="gstin"]').required = !unregistered;
  document.querySelector("#supplier-basis-field").hidden = !unregistered;
  document.querySelector('#new-supplier-form [name="unregisteredBasis"]').required = unregistered;
  document.querySelector("#supplier-state-field").hidden = !unregistered;
  document.querySelector("#supplier-registration-help").textContent = copy[state.locale][registration === "composition" ? "supplierCompositionHelp" : unregistered ? "supplierUnregisteredHelp" : "supplierRegularHelp"];
}
document.querySelector("#supplier-registration")?.addEventListener("change", showSupplierRegistrationFields);
document.querySelector('#new-supplier-form [name="pincode"]')?.addEventListener("input", async (event) => {
  const pincode = event.target.value.trim();
  if (!/^[1-9]\d{5}$/.test(pincode) || document.querySelector("#supplier-registration")?.value !== "unregistered") return;
  try {
    const found = await api("/api/pincode/state", { method: "POST", body: JSON.stringify({ pincode }) });
    const states = document.querySelector("#supplier-states");
    if (found.stateCode && states && event.target.value.trim() === pincode) states.value = found.stateCode;
  } catch { /* the person can still choose the state */ }
});
document.querySelector("#new-supplier-dialog")?.addEventListener("toggle", showSupplierRegistrationFields);

// Issue #228 — a new supplier, with the GST number that decides the kind of GST on their bills.
document.querySelector("#new-supplier-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const error = document.querySelector("#new-supplier-error");
  error.textContent = "";
  try {
    const created = await api("/api/suppliers", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    await loadCatalogue();
    if (pickerAwaitingNewRecord?.matches("[data-supplier-picker]")) {
      pickerAwaitingNewRecord.value = created.supplier.id;
      showChosenSupplier();
      if (pickerAwaitingNewRecord.matches("[data-payment-party]")) loadPaymentBills(pickerAwaitingNewRecord.form);
    }
    form.reset();
    document.querySelector("#new-supplier-dialog").close();
  } catch (requestError) { error.textContent = requestError.message; }
});

document.querySelector("#item-tax")?.addEventListener("change", (event) => {
  document.querySelector("#item-other-rate").hidden = event.target.value !== "other";
});

// Issue #187, moved by #308 — an item's HSN code (and its barcode, usual price and other name) is
// changed in the item's own dialog, not on the sale line. A bill held up by a code opens it from
// the live total's note. `openItemEditor(itemId)` is for any screen that lists items.
function openItemEditor(itemId) {
  const item = itemById(itemId);
  if (!item) return;
  const form = document.querySelector("#item-edit-form");
  form.elements.namedItem("itemId").value = item.id;
  form.elements.namedItem("hsnSac").value = item.hsnSac;
  form.elements.namedItem("barcode").value = item.barcodes?.[0] ?? "";
  form.elements.namedItem("price").value = item.price ?? "";
  form.elements.namedItem("otherName").value = item.aliases?.[0] ?? "";
  document.querySelector("#item-edit-error").textContent = "";
  document.querySelector("#item-edit-current").textContent = copy[state.locale].itemCodeCurrent
    .replace("{item}", item.name).replace("{code}", item.hsnSac).replace("{digits}", String(item.hsnSac.length));
  document.querySelector("#item-edit-dialog").showModal();
}

document.querySelector("#item-edit-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const error = document.querySelector("#item-edit-error");
  error.textContent = "";
  try {
    const changed = await api("/api/items/edit", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    await loadCatalogue();
    document.querySelector("#item-edit-dialog").close();
    updateCalculations();
    if (changed.warnings?.length) showDialog({ title: changed.title, message: changed.message, effects: [] }, "recorded");
  } catch (requestError) { error.textContent = requestError.message; }
});

document.querySelector("#item-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const error = document.querySelector("#item-error");
  error.textContent = "";
  const values = Object.fromEntries(new FormData(form));
  const choice = String(values.taxChoice ?? "");
  const body = {
    name: values.name,
    kind: values.kind,
    hsnSac: values.hsnSac,
    unit: values.unit,
    basis: values.basis,
    // Issue #281 — the day the rate starts; empty means the day it is saved.
    effectiveFrom: values.effectiveFrom,
    // Issue #308 — optional: found by scanning, starts at its usual price, found by another name.
    barcode: values.barcode, price: values.price, otherName: values.otherName,
    ...(choice === "exempt"
      ? { taxKind: "exempt" }
      : choice === "other"
        ? { taxKind: "taxable", ratePercent: values.otherRate }
        : { taxKind: "taxable", ratePercentTimes100: choice }),
  };
  try {
    const created = await api("/api/items", { method: "POST", body: JSON.stringify(body) });
    await loadCatalogue();
    if (pickerAwaitingNewRecord) {
      const line = pickerAwaitingNewRecord.closest(".sale-line");
      if (line?.closest("#sale-lines")) setLineItem(line, itemById(created.item.id) ?? created.item);
      else {
        pickerAwaitingNewRecord.value = created.item.id;
        if (line) { showLineUnit(line); setLineGstFromItem(line); }
      }
    }
    form.reset();
    document.querySelector("#item-dialog").close();
    // Issue #187 — a code too short for some bills is saved, and the person is told so at once.
    if (created.warnings?.length) showDialog({ title: created.title, message: created.message, effects: [] }, "recorded");
  } catch (requestError) { error.textContent = requestError.message; }
});

if (state.signedIn) loadCatalogue();

// ------------------------------------------- issue #182: where the goods go and who carries them
//
// Every one of these boxes prints on the bill and was empty on every bill the app issued, because
// the Sale screen had nowhere to put them. Two of them are not decoration: the delivery address is
// required when it differs from the place of supply, and the vehicle number and e-way bill number
// are what the person driving the lorry has to be able to show.



/** Shows only the ship-to question that was asked for, and reloads that customer's addresses. */
function showShipToFields() {
  const kind = document.querySelector("#sale-ship-to")?.value ?? "same";
  const address = document.querySelector("#sale-ship-address-field");
  const party = document.querySelector("#sale-ship-party-field");
  if (address) address.hidden = kind !== "address";
  if (party) party.hidden = kind !== "party";
  showPlaceOfSupply();
}

/**
 * The state this sale will count in, said before the bill is made rather than after.
 *
 * The two cases differ in law: goods sent to the customer's own other address end their journey
 * there and the sale counts in that state, while goods handed to somebody else on the customer's
 * instructions count where the customer is.
 */
function showPlaceOfSupply() {
  const line = document.querySelector("#sale-place-of-supply span:last-child");
  if (!line) return;
  const form = saleForm();
  const billed = catalogue.customers.find((row) => row.id === form?.elements.namedItem("party")?.value) ?? null;
  if (billed === null) { line.textContent = copy[state.locale].placeOfSupplyPending; return; }
  const kind = document.querySelector("#sale-ship-to")?.value ?? "same";
  if (kind === "address") {
    const chosen = delivery.addresses.find((row) => row.id === document.querySelector("#sale-ship-address")?.value);
    line.textContent = chosen === undefined
      ? copy[state.locale].placeOfSupplyPending
      : `${copy[state.locale].placeOfSupplyIs} ${chosen.stateName} (${chosen.stateCode}) — ${copy[state.locale].placeOfSupplyMovementEnds}`;
    return;
  }
  if (kind === "party") {
    line.textContent = `${copy[state.locale].placeOfSupplyIs} ${billed.stateName ?? ""} (${billed.stateCode ?? ""}) — ${copy[state.locale].placeOfSupplyThirdParty}`;
    return;
  }
  line.textContent = `${copy[state.locale].placeOfSupplyIs} ${billed.stateName ?? ""} (${billed.stateCode ?? ""}) — ${copy[state.locale][billed.walkIn ? "placeOfSupplyCounter" : "placeOfSupplyBilling"]}`;
}

async function loadDeliveryChoices() {
  const form = saleForm();
  const customerId = form?.elements.namedItem("party")?.value ?? "";
  try {
    const read = await api("/api/delivery/choices", { method: "POST", body: JSON.stringify({ customerId }) });
    // A slower answer for a customer who is no longer chosen must not replace the new one's addresses.
    if ((form?.elements.namedItem("party")?.value ?? "") !== customerId) return;
    delivery.transporters = read.transporters;
    delivery.addresses = read.addresses.filter((row) => row.use !== "billing");
  } catch { return; }

  const carriers = document.querySelector("#sale-transporters");
  if (carriers) {
    const chosen = carriers.value;
    carriers.replaceChildren();
    const none = document.createElement("option");
    none.value = "";
    none.textContent = copy[state.locale].noTransporter;
    carriers.append(none);
    delivery.transporters.forEach((carrier) => {
      const option = document.createElement("option");
      option.value = carrier.id;
      option.textContent = `${carrier.name} · ${carrier.transporterId}`;
      carriers.append(option);
    });
    if (chosen !== "" && carriers.querySelector(`option[value="${CSS.escape(chosen)}"]`)) carriers.value = chosen;
  }

  const addresses = document.querySelector("#sale-ship-address");
  if (addresses) {
    const chosen = addresses.value;
    addresses.replaceChildren(...delivery.addresses.map((row) => {
      const option = document.createElement("option");
      option.value = row.id;
      option.textContent = `${row.label} · ${row.lines.join(", ")} · ${row.stateName}`;
      return option;
    }));
    if (chosen !== "" && addresses.querySelector(`option[value="${CSS.escape(chosen)}"]`)) addresses.value = chosen;
  }
  // Follow-up to #266 — the saved delivery address and transporter, now that this customer's are here.
  // Only for a real customer: the first load, before any customer is chosen, has nothing to offer.
  if (customerId !== "") applyPendingChoices(["shipToAddressId", "transporterId"], true);
  showShipToFields();
}

document.querySelector("#sale-ship-to")?.addEventListener("change", showShipToFields);
document.querySelector("#sale-ship-address")?.addEventListener("change", showPlaceOfSupply);

document.querySelector("#sale-add-transporter")?.addEventListener("click", () => {
  document.querySelector("#transporter-dialog")?.showModal();
});

document.querySelector("#transporter-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const error = document.querySelector("#transporter-error");
  error.textContent = "";
  try {
    const created = await api("/api/transporters", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    await loadDeliveryChoices();
    const carriers = document.querySelector("#sale-transporters");
    if (carriers) carriers.value = created.transporter.id;
    form.reset();
    document.querySelector("#transporter-dialog").close();
  } catch (requestError) { error.textContent = requestError.message; }
});

document.querySelector("#sale-add-address")?.addEventListener("click", () => {
  const states = document.querySelector("#address-states");
  if (states && states.childElementCount === 0) {
    states.replaceChildren(...catalogue.states.map((row) => {
      const option = document.createElement("option");
      option.value = row.code;
      option.textContent = `${row.name} (${row.code})`;
      return option;
    }));
  }
  document.querySelector("#address-dialog")?.showModal();
});

// Issue #224 — a customer's saved address can be corrected where it is used, without retyping them.
document.querySelector("#sale-correct-address")?.addEventListener("click", async () => {
  const customerId = saleForm()?.elements.namedItem("party")?.value ?? "";
  if (!customerId) return;
  const form = document.querySelector("#correct-address-form");
  const error = document.querySelector("#correct-address-error");
  error.textContent = "";
  try {
    const found = await api("/api/customer-address", { method: "POST", body: JSON.stringify({ customerId }) });
    form.elements.namedItem("line1").value = found.address.lines[0] ?? "";
    form.elements.namedItem("line2").value = found.address.lines.length > 2 ? found.address.lines[1] : "";
    form.elements.namedItem("city").value = found.address.city;
    form.elements.namedItem("pincode").value = found.address.pincode;
    // Issue #235 — the credit limit is corrected here too; empty means none.
    form.elements.namedItem("creditLimit").value = found.creditLimit === null || found.creditLimit === undefined ? "" : String(found.creditLimit);
    form.dataset.customerId = found.customerId;
    document.querySelector("#correct-address-state").textContent = `${found.address.stateName} (${found.address.stateCode})`;
    document.querySelector("#correct-address-dialog")?.showModal();
  } catch (requestError) {
    showDialog({ title: copy[state.locale].correctAddress, message: requestError.message }, "failed");
  }
});

document.querySelector("#correct-address-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const error = document.querySelector("#correct-address-error");
  error.textContent = "";
  try {
    const corrected = await api("/api/customer-address/correct", {
      method: "POST",
      body: JSON.stringify({ ...Object.fromEntries(new FormData(form)), customerId: form.dataset.customerId }),
    });
    await loadCatalogue();
    showChosenCustomer();
    document.querySelector("#correct-address-dialog").close();
    showDialog({ title: corrected.title, message: corrected.message }, "recorded");
  } catch (requestError) { error.textContent = requestError.message; }
});

document.querySelector("#address-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const error = document.querySelector("#address-error");
  error.textContent = "";
  const customerId = saleForm()?.elements.namedItem("party")?.value ?? "";
  try {
    const created = await api("/api/shipping-addresses", {
      method: "POST",
      body: JSON.stringify({ ...Object.fromEntries(new FormData(form)), customerId }),
    });
    await loadDeliveryChoices();
    const addresses = document.querySelector("#sale-ship-address");
    if (addresses) addresses.value = created.address.id;
    form.reset();
    document.querySelector("#address-dialog").close();
    showPlaceOfSupply();
  } catch (requestError) { error.textContent = requestError.message; }
});

if (state.signedIn) loadDeliveryChoices();
