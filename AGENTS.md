# Repository agent rules

## Rule 0 — the law decides, before anything else

This comes before ease of use, speed or design, and it binds every agent on this project.

1. Before planning or building anything that touches tax, invoicing, GST returns, e-invoice,
   e-way bill, credit/debit notes, purchases, stock valuation or any other compliance matter,
   **check the current law first**, from primary sources: the CGST/IGST Acts and CGST Rules
   (`taxinformation.cbic.gov.in`), notifications and circulars (`gstcouncil.gov.in`,
   `cbic-gst.gov.in`), GST Council press releases and official FAQs, and the e-invoice and
   e-way bill portals' own documents.
2. **Use the latest version**: check amendments, later notifications and Finance Act changes, and
   record each effective date.
3. **Never assume.** When unsure or stuck — while planning or mid-code — stop and check the law.
   Not a person's opinion, not memory, not what another product does.
4. If the law allows it, build it. If it does not, do not support it. If there is a lawful way
   around, build that. List every case: what works, what does not, and why.
5. Quote the section, rule or notification (number and date) in the issue or pull request, and in
   a code comment where the rule is applied. Say plainly what was not verified.
6. Only after that: how it works for the shopkeeper, and how to make it easy.

## Database migrations

- Never invent or reuse a numeric migration ID. `0001` through `0008` are frozen identifiers already applied to databases.
- Before adding any new migration, run `npm run db:migration:id -- <module> <description>` and use the generated ID exactly.
- Keep the migration in its owning module's migration array. Do not rename or reorder an applied migration.
- Run `npm run verify` before pushing. The migration registry check must pass; do not bypass duplicate, format or ordering failures.
