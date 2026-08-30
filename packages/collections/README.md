# `@invoice/collections` — payment reminders and collection tracking (issue #23)

Decides **who is reminded about which bill, how firmly, and who is deliberately left alone**. It
posts nothing, changes no invoice, and calls no provider itself. See
[`docs/contracts/collections-v1.md`](../../docs/contracts/collections-v1.md).

The rule the rest follows from: an outstanding amount is never stored and re-used. It is read from
receivables (#20) when the reminder is planned and **read again at the moment of sending**, so a
bill paid, disputed or promised in between stops the message rather than merely making it wrong.

```sh
npm run demo:reminders   # five customers, five reasons, and a provider outage
npm test                 # 35 tests over the real ledger, receivables and notification services
npm run web              # the Reminders screen in the running app
```

Built on modules that already exist and are not reimplemented here: the receivables position
(#20), the notification service and its channel/role policy (#39), and the ledger underneath both.
