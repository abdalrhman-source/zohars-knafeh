// Runs the order server's logic in Node with an in-memory SQLite, the same SQL the Durable Object uses.
import assert from "node:assert/strict";
import { handle, migrate } from "../src/app.js";
import { MENU, GROUPS } from "../src/menu.js";
import { memorySql } from "./run-helpers.mjs";

const env = { STAFF_PIN: "482913", PAY_METHODS: "bit" };
let now = Date.parse("2026-11-17T10:00:00Z");
const sql = memorySql();
migrate(sql);
const call = async (method, path, body, headers = {}) => {
  const r = await handle(new Request("https://shop" + path, {
    method, headers: { "Content-Type": "application/json", "X-Client-IP": headers.ip || "1.1.1.1", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  }), sql, env, now);
  return { status: r.status, body: await r.json() };
};

const byName = he => Object.entries(MENU).find(([, it]) => it.n[0] === he);
const [knafehId, knafeh] = byName("כנאפה זוגי");
const [drinkId, drink] = Object.entries(MENU).find(([, it]) => !it.o.length && !it.off);
const [offId] = Object.entries(MENU).find(([, it]) => it.off);
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };

await test("ordering is closed until the shop screen opens it", async () => {
  assert.equal((await call("GET", "/api/config")).body.open, false);
  const shut = await call("POST", "/api/orders", { items: [{ id: drinkId, q: 1 }], name: "רנא", pay: "bit" });
  assert.equal(shut.status, 403);
  assert.equal(shut.body.error, "closed");
  assert.equal((await call("POST", "/api/staff/open", { open: true })).status, 401);
  const { token } = (await call("POST", "/api/staff/login", { pin: "482913" })).body;
  const auth = { Authorization: "Bearer " + token };
  assert.equal((await call("POST", "/api/staff/open", { open: "yes" }, auth)).status, 400);
  assert.equal((await call("POST", "/api/staff/open", { open: true }, auth)).body.open, true);
  assert.equal((await call("GET", "/api/config")).body.open, true);
  assert.equal((await call("GET", "/api/staff/orders", undefined, auth)).body.open, true);
});

await test("price comes from the server, with add-ons", async () => {
  // whole tray toppings: Nutella (+5) and Nutella Baby (+8), on top, Turkish ice cream (+12), x2
  const items = [{ id: knafehId, q: 2, s: { split: [2], whole: [0, 5], where: [2], icecream: [1], changes: [2] } }, { id: drinkId, q: 1 }];
  const r = await call("POST", "/api/orders", { items, name: "סאמר", phone: "052-1234567", pay: "bit" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const unit = knafeh.p + 5 + 8 + 12;
  assert.equal(r.body.total, unit * 2 + drink.p);
  assert.equal(r.body.status, "awaiting_payment");
  assert.equal(r.body.no, 1);
  assert.ok(r.body.lines[0].o[0].some(t => t.includes("נוטלה בייבי")));
});

await test("a price sent by the browser is ignored", async () => {
  const r = await call("POST", "/api/orders", { items: [{ id: drinkId, q: 1, p: 1 }], total: 1, name: "רנא", pay: "bit" });
  assert.equal(r.body.total, drink.p);
});

await test("required add-on missing is refused", async () => {
  const r = await call("POST", "/api/orders", { items: [{ id: knafehId, q: 1, s: { split: [1], half: [0] } }], name: "רנא", pay: "bit" });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "missing_option");
});

await test("too many toppings refused, hidden group ignored", async () => {
  const bad = await call("POST", "/api/orders", { items: [{ id: knafehId, q: 1, s: { split: [2], where: [0], icecream: [0], whole: [0, 9] } }], name: "רנא", pay: "bit" });
  assert.equal(bad.body.error, "bad_option");
  const many = await call("POST", "/api/orders", { items: [{ id: knafehId, q: 1, s: { split: [2], where: [0], icecream: [0], whole: [0, 1, 2, 3, 4, 5] } }], name: "רנא", pay: "bit" });
  assert.equal(many.body.error, "too_many_options");
  const hidden = await call("POST", "/api/orders", { items: [{ id: knafehId, q: 1, s: { split: [0], icecream: [0], half: [0, 1] } }], name: "רנא", pay: "bit" });
  assert.equal(hidden.status, 201);
  assert.equal(hidden.body.total, knafeh.p);
});

await test("switched-off items, unknown items, bad quantities and unknown payment are refused", async () => {
  assert.equal((await call("POST", "/api/orders", { items: [{ id: offId, q: 1 }], name: "רנא", pay: "bit" })).body.error, "item_unavailable");
  assert.equal((await call("POST", "/api/orders", { items: [{ id: "nope", q: 1 }], name: "רנא", pay: "bit" })).body.error, "unknown_item");
  assert.equal((await call("POST", "/api/orders", { items: [{ id: drinkId, q: 0 }], name: "רנא", pay: "bit" })).body.error, "bad_quantity");
  assert.equal((await call("POST", "/api/orders", { items: [{ id: drinkId, q: 1 }], name: "רנא", pay: "card" })).body.error, "pay_not_available");
  assert.equal((await call("POST", "/api/orders", { items: [{ id: drinkId, q: 1 }], name: "", pay: "bit" })).body.error, "missing_name");
  assert.equal((await call("POST", "/api/orders", { items: [{ id: drinkId, q: 1 }], name: "רנא", phone: "123", pay: "bit" })).body.error, "bad_phone");
});

await test("rate limit per device", async () => {
  let last;
  for (let i = 0; i < 7; i++) last = await call("POST", "/api/orders", { items: [{ id: drinkId, q: 1 }], name: "רנא", pay: "bit" }, { ip: "9.9.9.9" });
  assert.equal(last.status, 429);
});

let token, orderId;
await test("staff sign-in needs the right PIN", async () => {
  assert.equal((await call("POST", "/api/staff/login", { pin: "000000" })).status, 401);
  assert.equal((await call("GET", "/api/staff/orders")).status, 401);
  const r = await call("POST", "/api/staff/login", { pin: "482913" });
  assert.equal(r.status, 200);
  token = r.body.token;
});

await test("unpaid Bit order waits, then goes to the kitchen when confirmed", async () => {
  const auth = { Authorization: "Bearer " + token };
  const created = await call("POST", "/api/orders", { items: [{ id: drinkId, q: 2 }], name: "מוחמד", pay: "bit" }, { ip: "2.2.2.2" });
  orderId = created.body.id;
  assert.equal((await call("POST", `/api/staff/orders/${orderId}/ready`, {}, auth)).status, 409);  // not paid yet
  const paid = await call("POST", `/api/staff/orders/${orderId}/paid`, {}, auth);
  assert.equal(paid.body.status, "new");
  assert.equal(paid.body.paid, true);
  assert.equal((await call("POST", `/api/staff/orders/${orderId}/ready`, {}, auth)).body.status, "ready");
  const cust = await call("GET", `/api/orders/${orderId}`);
  assert.equal(cust.body.status, "ready");
  assert.equal(cust.body.phone, undefined);                   // the customer view never shows other data
  assert.equal((await call("POST", `/api/staff/orders/${orderId}/done`, {}, auth)).body.status, "done");
});

await test("unpaid orders are cancelled after 30 minutes", async () => {
  const created = await call("POST", "/api/orders", { items: [{ id: drinkId, q: 1 }], name: "לינה", pay: "bit" }, { ip: "3.3.3.3" });
  now += 31 * 60000;
  const r = await call("GET", `/api/orders/${created.body.id}`);
  assert.equal(r.body.status, "cancelled");
});

await test("order numbers restart each day (Israel time)", async () => {
  now = Date.parse("2026-11-18T08:00:00Z");
  const r = await call("POST", "/api/orders", { items: [{ id: drinkId, q: 1 }], name: "רנא", pay: "bit" }, { ip: "4.4.4.4" });
  assert.equal(r.body.no, 1);
});

await test("old orders are deleted after 30 days", async () => {
  now += 31 * 86400000;
  await call("POST", "/internal/cleanup", {});
  assert.equal((await call("GET", `/api/orders/${orderId}`)).status, 404);
});

await test("every option price in the menu is a whole number", async () => {
  for (const g of Object.values(GROUPS)) for (const v of g.v) assert.ok(Number.isInteger(v[3]));
});

console.log(`\n${passed} tests passed`);
