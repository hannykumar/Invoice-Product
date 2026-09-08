# Support request to WhiteBooks — sandbox test data and documentation

Send to `sales@whitebooks.in` (or raise a ticket from the Developer Hub). Copy the body below.

---

**Subject:** Sandbox GSTINs do not follow the published GSTIN format — request for conforming test accounts

Hello,

We are integrating the GST, e-Invoice and e-Way Bill APIs against your sandbox
(`https://apisandbox.whitebooks.in`) and have three things to raise. The integration itself is
working — we have generated IRNs and an e-way bill successfully — so these are about test data and
documentation rather than faults in the APIs.

**1. The sandbox GSTINs are not structurally valid, and this is blocking us.**

The sandbox taxpayers issued to us are of the form `33AAGCB1286Q003` and `27AAGCB1286Q005`. In a
GSTIN the fourteenth character is always `Z` for a normal taxpayer; these carry `0`. Our software
validates every GST number against the published format before sending anything to the government,
because a mistyped GSTIN is one of the commonest errors a small business makes, and we would rather
catch it than pass it on.

The result is that our own validation refuses your test data, and we cannot exercise our full
invoice path end to end against your sandbox. We can only bypass our validation to test, which
defeats the purpose of testing.

**Could you issue sandbox taxpayers whose GSTINs follow the published format**, including the `Z`
in the fourteenth position and a correct check digit? If GSTN rather than WhiteBooks controls this,
we would be grateful if you could pass the request on, or tell us who to ask.

**2. The e-Way Bill authenticate endpoint returns placeholder text.**

`GET /ewaybillapi/v1.03/authenticate` answers:

```json
{"irp":"NIC1","status_cd":"1","status_desc":"If authentication succeeds"}
```

There is no token and no `data` object. Generation works regardless — we successfully created
e-way bill `501009126912` by sending `password` as a header directly to
`/ewaybillapi/v1.03/ewayapi/genewaybill` — so we assume no token is required on this lane and the
endpoint is vestigial. **Could you confirm that is correct**, so we are not relying on behaviour
you intend to change?

**3. The GST returns token endpoint returns placeholder text, which blocks that lane entirely.**

`GET /authentication/otprequest` works and returns a transaction id. Passing that transaction and
the documented sandbox OTP `575757` to `GET /authentication/authtoken` gives:

```json
{"status_cd":"1","status_desc":"If authentication succeeds"}
```

There is no token. Without one we cannot call any GSTR endpoint, so we cannot test return filing at
all. This is the same placeholder string the e-Way Bill authenticate route returns — harmless
there, since that lane needs no token, but not here. **Could you either enable this endpoint on the
sandbox or tell us the correct way to obtain a session token for the GST returns APIs?**

**4. Your published API documentation does not resolve.**

`https://whitebooks.in/llms.txt` advertises OpenAPI specifications at `/openapi/eway.json` and
`/openapi/gst.json`, API references at `/docs/eway` and `/docs/einvoice`, developer guides at
`/developer/e-way-bill`, and around a dozen e-way-bill endpoint pages. Every one of these
redirects to your marketing home page.

That file also names endpoints — `POST /v1/ewaybill/create`, `POST /v1/einvoice/create`,
`GET /v1/gstin/validate` — which return `WB_ERR_9404` on both `apisandbox.whitebooks.in` and
`api.whitebooks.in`.

The real documentation inside the Developer Hub is good and we are using it. But anyone evaluating
you from outside will find only dead links, and we lost time probing for endpoints that were
documented all along. You may want to know.

Thank you,

---

## Why this was the chosen route

The alternative was a flag-guarded exception in our own GSTIN validation, off in production. That
would have worked, but it puts a hole in the one check that stops a mistyped GST number reaching
the government, and the hole would exist to accommodate somebody else's malformed test data.
Asking them costs a few days and leaves our validation intact.

**While we wait:** the e-invoice connector is proven at the connector level against the live
sandbox, and the service layer continues to be tested against `SyntheticIrp`, which computes real
IRNs with the published formula. Nothing is idle.
