# WhiteBooks sandbox — what is confirmed, and what is still missing

WhiteBooks is MasterGST under a new name: every MasterGST signup page now redirects there. It is a
licensed GSP, so it is one candidate for issue #50, not the decision.

**Nothing here is a quotation.** The endpoint shapes below were confirmed by probing
`https://apisandbox.whitebooks.in` with our own sandbox credentials on 8 September 2026; the
commercial terms are still `UNKNOWN` in `ops/gsp-selection`, and public pricing (₹5,999–₹24,999,
quote-based) is `PUBLIC_INFORMATION` at best.

## How the service answers

Failures arrive as **HTTP 200** with `status_cd: "0"`, so the HTTP status line tells you nothing.
An unknown path answers `WB_ERR_9404 : No API configured for :<path>`, and a known path answers
`WB_ERR_9104 : Missing mandatory headers : <list>` — which is how each route below was pinned down
without a document.

## Confirmed routes

| Operation | Method | Path |
| --- | --- | --- |
| Log in | GET | `/einvoice/authenticate` |
| Generate IRN | POST | `/einvoice/type/GENERATE/version/V1_03` |
| Fetch IRN | GET | `/einvoice/type/GETIRN/version/V1_03` |
| Cancel IRN | POST | `/einvoice/type/CANCEL/version/V1_03` |
| e-way bill log in | GET | `/ewaybillapi/v1.03/authenticate` |

Mandatory headers on every call: `client_id`, `client_secret`, `gstin`, `ip_address`, `username`,
plus `password` on the login and `auth-token` on everything after it. `email` is a query parameter.

The GST-returns route is **not** under any of `/gst`, `/gstr`, `/gstapi`, `/taxpayerapi`,
`/returns` or `/gsp` — all six answer `WB_ERR_9404`. It has not been found yet.

## The blocker

`/ewaybillapi/v1.03/authenticate` answers **"Invalid credentials provided or your account is not
active"**. We hold three client id/secret pairs and four GSTN sandbox taxpayers
(`33AAGCB1286Q1ZB`, `27AAGCB1286Q1Z4`, `33AAGCB1286Q2ZA`, `27AAGCB1286Q2Z3`), but **no taxpayer
password**, and the login will not proceed without one. The four accounts are also labelled for
*Returns*; e-invoice and e-way bill sandbox users are created separately on the NIC portals.

Until a password exists, `whitebooksIrpConnector` is exercised against recorded reply shapes in
`packages/gst/test/whitebooks-connector.test.ts`, and `SyntheticIrp` remains the default. No
acceptance criterion for #26 is affected: it was met against the synthetic portal, which computes
real IRNs.

## Where it plugs in

`whitebooksIrpConnector` implements `ExternalConnector` for kind `irp`. Register it with
`ConnectorGateway` in place of the mock and `irpAdapter` is unchanged — it only ever sees the
government's own field names, which is what this connector's `unwrap` produces.

Credentials live in `.env` (gitignored). They are sandbox-only and reach no government system.
