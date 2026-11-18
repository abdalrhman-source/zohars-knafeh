# Order server – הכנאפה של זוהר

A Cloudflare Worker with one Durable Object per shop (SQLite storage). It receives orders from `/order/`, recomputes every price and add-on rule from the menu (`src/menu.js`, generated from the Wolt data), and serves the shop screen at `/order/staff/`.

## Flow
- Customer sends an order → status `awaiting_payment` (Bit) → staff confirms the Bit transfer → `new` (kitchen) → `ready` → `done`.
- Unpaid orders are cancelled after 30 minutes; orders are deleted after 30 days.
- Card / Apple Pay / Google Pay will be enabled once a payment company confirms payments to the server.

## Deploy
Pushing to `main` runs the tests and deploys with GitHub Actions once these repository secrets exist:
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `STAFF_PIN`.

## Test locally
```
node --no-warnings server/test/run.mjs
node --no-warnings server/test/dev-server.mjs 8790 http://127.0.0.1:8775 123456
```
