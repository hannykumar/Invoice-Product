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

## All three lanes work

Their real documentation is inside the Developer Hub, behind the login, at
`developer.whitebooks.in/apis/docs/{gst-api,e-invoice-api,e-way-bill-api}`. The e-way bill
reference alone lists 27 endpoint groups. Everything below came from it and was then confirmed
against the live sandbox on 9 September 2026.

**An earlier note in this file said e-way bill was unavailable. That was wrong.** The route exists;
the path is lower case. `/ewaybillapi/v1.03/ewayapi/GENEWAYBILL` answers `WB_ERR_9404` and
`/ewaybillapi/v1.03/ewayapi/genewaybill` works. Eight probes missed it on capitalisation alone,
which is why guessing at paths was the wrong method and reading their reference was the right one.

| Lane | Route | Confirmed by |
| --- | --- | --- |
| e-Invoice login | `GET /einvoice/authenticate` | A live IRN |
| e-Invoice generate | `POST /einvoice/type/GENERATE/version/V1_03` | A live IRN |
| e-Invoice fetch | `GET /einvoice/type/GETIRN/version/V1_03` | A live fetch |
| e-Way bill generate | `POST /ewaybillapi/v1.03/ewayapi/genewaybill` | e-way bill `501009126912` |
| GST returns OTP | `GET /authentication/otprequest` | `status_cd 1`, txn returned |

Three things the reference settles that probing could not:

- **The e-way bill lane needs no token.** `/ewaybillapi/v1.03/authenticate` returns the placeholder
  *"If authentication succeeds"* and no token, because none is wanted: `password` travels as a
  header on the generate call itself.
- **The GST returns lane sits at the root**, not under a `/gst` prefix, and it wants `gst_username`
  and `state_cd` as *headers* — not the `username` header the other two lanes use. It answers an
  OTP request with a transaction id, confirming the OTP design the help guide described.
- **The e-way bill lane spells its errors differently.** e-Invoice sends `error_cd`/`message`;
  e-way bill sends `errorCode`/`errorMessage` where `errorMessage` merely repeats the code, and the
  sentence worth showing a person is in a separate `info` field. `unwrap` now reads both.

## Their public documentation does not exist

`https://whitebooks.in/llms.txt` is real and 15 KB long, and it advertises OpenAPI specs
(`/openapi/eway.json`), Redoc references (`/docs/eway`), developer guides (`/developer/e-way-bill`)
and about a dozen e-way-bill API pages. **Every one of them redirects to the marketing home page or
returns the single-page-app shell.** None is a document.

It also names an API in a shape the service does not serve — `POST /v1/ewaybill/create`,
`POST /v1/einvoice/create`, `GET /v1/gstin/validate`. All three answer `WB_ERR_9404` on both
`apisandbox.whitebooks.in` and `api.whitebooks.in`.

So the routes recorded above, found by probing, are the only ones known to exist. Treat that file
as marketing copy aimed at crawlers, not as a specification.

## The end-to-end run is blocked on their test data

Running the real `EInvoiceService` path — preview and register, not a hand-built payload — stops in
preview:

```
SellerDtls.Gstin: The your business's GST number is missing or is not a valid one.
BuyerDtls.Gstin:  The customer's GST number is missing or is not a valid one.
```

Our validator is right and their data is wrong: a GSTIN carries `Z` in the fourteenth position and
`33AAGCB1286Q003` does not. The earlier live IRN was obtained by bypassing the validator and
swapping the GSTINs into the built payload, which proves the *connection* works but not the
*product*.

The decision taken was to **ask WhiteBooks for conforming sandbox GSTINs** rather than put a
sandbox exception into GSTIN validation — see `docs/vendor/whitebooks-support-request.md`. Until
they answer, the service layer is exercised against `SyntheticIrp` and the live sandbox is
exercised at the connector level only.

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
