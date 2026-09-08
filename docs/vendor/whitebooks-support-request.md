# Support request to WhiteBooks

Send to `sales@whitebooks.in`, or raise it from the Developer Hub. Copy the body below.

Ordered by what actually blocks us. The GSTIN question moved down because we worked around it
safely — it is still worth their fixing, but we are no longer waiting on it.

---

**Subject:** GST returns sandbox: /authentication/authtoken returns no token

Hello,

We are integrating your GST, e-Invoice and e-Way Bill APIs against the sandbox at
`https://apisandbox.whitebooks.in`. Two of the three lanes are working well — we are generating
IRNs and e-way bills successfully — so this is not a complaint about the APIs themselves. There are
four things we would like your help with, in order of how much they hold us up.

**1. The GST returns lane stops at the token step, and this blocks us completely.**

`GET /authentication/otprequest` works and returns a transaction id. Passing that transaction and
the documented sandbox OTP `575757` to `GET /authentication/authtoken` returns:

```json
{"status_cd":"1","status_desc":"If authentication succeeds"}
```

There is no token and no `data` object — the text reads like a placeholder left in by mistake.
Without a session token we cannot call any GSTR endpoint, so we cannot test return filing at all.

**Could you either enable this endpoint on the sandbox, or tell us the correct way to obtain a
session token for the GST returns APIs?** This is the one item genuinely stopping work.

**2. Please confirm the e-Way Bill lane needs no token, so we are not relying on an accident.**

`GET /ewaybillapi/v1.03/authenticate` returns the same placeholder string and no token. On this
lane it does not seem to matter: sending `password` as a header directly to
`/ewaybillapi/v1.03/ewayapi/genewaybill` works, and we have generated, fetched and cancelled real
sandbox e-way bills that way.

We would rather have that confirmed than depend on behaviour you may tighten later. **Is
header-based authentication the intended design for this lane?**

**3. The sandbox GSTINs are not structurally valid.**

The sandbox taxpayers issued to us look like `33AAGCB1286Q003`. In a GSTIN the fourteenth character
is `Z` for a normal taxpayer; these carry a digit. Our software validates every GST number before
sending anything to the government, because a mistyped GSTIN is one of the commonest mistakes a
small business makes.

We have handled this on our side with a narrow exception that accepts only numbers which could
never be real, so this is no longer blocking us. But **conforming sandbox GSTINs would let every
customer of yours test against real validation rather than working around them**, and we suspect we
are not the first to hit it. If this is GSTN's decision rather than yours, we would be grateful if
you could pass it on, or tell us who to ask.

**4. Your published API documentation does not resolve.**

`https://whitebooks.in/llms.txt` advertises OpenAPI specifications at `/openapi/eway.json` and
`/openapi/gst.json`, API references at `/docs/eway` and `/docs/einvoice`, developer guides at
`/developer/e-way-bill`, and around a dozen e-way-bill endpoint pages. **Every one of these
redirects to your marketing home page.**

That file also names endpoints — `POST /v1/ewaybill/create`, `POST /v1/einvoice/create`,
`GET /v1/gstin/validate` — which return `WB_ERR_9404` on both `apisandbox.whitebooks.in` and
`api.whitebooks.in`.

The real reference inside the Developer Hub is genuinely good, and once we found it the integration
went quickly. But from outside there is nothing but dead links, and we lost time probing for
endpoints that were documented all along. We thought you would want to know.

Thank you for your help.

---

## Notes for us, not for them

- Item 1 is the only true blocker. Items 2 and 4 are worth their knowing; item 3 is a courtesy now.
- Do not accept a workaround for item 1 that involves sending the taxpayer's **portal password**.
  Our design uses an API user with an OTP, and a provider requiring the portal password would be
  disqualified on the spot — see `ops/gsp-selection/src/scoring.ts`.
