---
description: Release security review — run in a fresh session that did not write the code (#348)
---

<!--
Saved from issue #348 ("Prompt (adapts playbook 10b)"), verbatim. Named
`security-review-release.md` rather than `security-review.md` because Claude Code ships a built-in
`/security-review` command and a project command of the same name would shadow it.
Run it on the commit to be released, in a fresh session (or a reviewer agent) that did not write
that code: a slash command runs in whichever session calls it, so independence is the caller's
duty. File one issue per finding (labels `saas-readiness`, `security`) and record the review in
docs/security/reviews/, as release checklist item 5 in docs/release/gates.md requires.
-->

Act as a security reviewer in a fresh session. Audit the codebase for: routes or queries missing company scoping; unsafe raw SQL; XSS in `apps/web/app.js` (every `innerHTML` and template string built from data); CSRF on state-changing routes; open redirects; SSRF (any server-side fetch of a user-supplied URL, e.g. intake links); insecure uploads, including spreadsheet formula injection in CSV/Excel exports and zip/PDF bombs in intake; secrets or personal data in code or logs; missing security headers; verbose errors leaking internals; insecure cookie settings; prompt injection through OCR/WhatsApp/email text or the voice assistant reaching an action without approval; any code path that reaches the ledger without a permission check; any write that can change a posted record (#368). Report each finding with file, line, severity, exploit scenario and fix. Do not fix anything yet.
