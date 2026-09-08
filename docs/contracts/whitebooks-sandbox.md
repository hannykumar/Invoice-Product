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

## Two lanes, two different logins

WhiteBooks' own help guide *Enable Access to Upload API* (screenshots, no text layer) settles how
the GST-returns lane authenticates. The taxpayer signs in at `gst.gov.in`, opens **View Profile →
Manage API Access**, sets **Enable API Request = Yes** with a **30-day duration**, and confirms.
The portal's own wording is the important part: *"Your API session will be active during this
duration. After this duration you have to initiate a new session by providing OTP again."*

So the returns lane has **no API password at all** — access is a switch on the portal plus an OTP,
which is why the four sandbox taxpayers arrived with usernames and none. Sandbox OTP is 575757.

The guide covers only that switch. It says nothing about e-invoice or e-way bill, which are NIC
systems rather than GSTN ones and take the other route: the taxpayer opens **API Registration →
Create API User** on the e-invoice or e-way-bill portal, picks the GSP, and **invents a username
and password there**. Nothing in a GSP dashboard can display that password, because the GSP never
had it.

## It works, and here is what only the live service could tell us

On 9 September 2026 a bill went through the sandbox end to end and came back with an IRN, an
acknowledgement number and NIC's signed QR code. Two defects survived the stubbed tests and were
found only against the real thing:

1. **Errors hide in `status_desc` as a JSON string** — `[{"errorCode":"2150",...}]` — not in the
   `error` object the shape suggested. A duplicate was being reported as an unknown rejection.
2. **Numbers arrive as numbers.** `AckNo` is `152610027961228`, not a string, and the layer above
   reads acknowledgement fields as text — so a registered e-invoice came back with a blank
   acknowledgement number.

A third thing is behaviour, not a defect: **their duplicate reply does not carry the IRN**. Since
the IRN is a hash of four fields we sent, the connector recomputes it and fetches the portal's own
record, so a retry after a timeout still ends holding the right IRN — which is what
`purchase-intake` and `einvoice-v1` both require.

**NIC's sandbox GSTINs do not carry a real checksum digit** (`33AAGCB1286Q003`), so our own payload
validator refuses them, correctly. The trial script swaps them in after the payload is built.
Nothing in the product does this, and the validator stays as it is.

## e-Way bill does not work on this sandbox

Three separate attempts, all on 9 September 2026:

- `/ewaybillapi/v1.03/authenticate` answers `status_cd: "1"` but with the placeholder text
  *"If authentication succeeds"* and **no token and no `data` object**. It is a stub.
- No generation route exists. Eight path shapes were tried — `/ewaybillapi/v1.03/ewayapi`,
  `/ewaybill/type/GENERATE/version/V1_03`, `/ewb/...` and others — and every one answers
  `WB_ERR_9404`.
- Asking for the e-way bill on the e-invoice call, which is how an invoice-linked movement is
  normally raised, registers the IRN happily and returns **no `EwbNo`** at all. `EwbDtls` is
  accepted and ignored.

So the e-way bill lane is not merely unproven, it is unavailable here. Either it lives on a host
their documentation names, or the sandbox account has to be enabled for it separately.

## What is still open

The **GST-returns route** is still not found: `/gst`, `/gstr`, `/gstapi`, `/taxpayerapi`,
`/returns` and `/gsp` all answer `WB_ERR_9404`. Returns needs no password — it is the portal switch
plus an OTP — so this is a documentation gap, not a credential one.

`SyntheticIrp` remains the default for tests and demos; nothing in CI depends on a network.

## Where it plugs in

`whitebooksIrpConnector` implements `ExternalConnector` for kind `irp`. Register it with
`ConnectorGateway` in place of the mock and `irpAdapter` is unchanged — it only ever sees the
government's own field names, which is what this connector's `unwrap` produces.

Credentials live in `.env` (gitignored). They are sandbox-only and reach no government system.
