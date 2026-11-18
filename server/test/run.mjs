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
  }), sql, env, now, io);
  return { status: r.status, body: await r.json() };
};

const byName = he => Object.entries(MENU).find(([, it]) => it.n[0] === he);
const [knafehId, knafeh] = byName("כנאפה זוגי");
const [drinkId, drink] = Object.entries(MENU).find(([, it]) => !it.o.length && !it.off);
const [offId] = Object.entries(MENU).find(([, it]) => it.off);
const printed = [];
let printerUp = true;
const io = { async print(host, port, bytes) { if (!printerUp) throw new Error("down"); printed.push({ host, port, n: bytes.length }); } };
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

await test("kitchen printer: address, printing once, printing again, printer down", async () => {
  const { token } = (await call("POST", "/api/staff/login", { pin: "482913" }, { ip: "9.9.9.9" })).body;
  const auth = { Authorization: "Bearer " + token, ip: "77.125.10.20" };
  const ticket = btoa(String.fromCharCode(0x1b, 0x40, 0x1d, 0x76, 0x30, 0, 1, 0, 1, 0, 0xff));
  assert.equal((await call("POST", "/api/staff/print", { data: ticket }, auth)).body.error, "no_printer");
  assert.equal((await call("POST", "/api/staff/printer", { useMyIp: true, port: 25 }, auth)).body.error, "bad_port");
  assert.equal((await call("POST", "/api/staff/printer", { host: "bad host!", port: 9100 }, auth)).body.error, "bad_host");
  assert.equal((await call("POST", "/api/staff/printer", { useMyIp: true, port: 47913 }, { ...auth, ip: "2a02:6680::1" })).body.error, "ipv6");
  const set = await call("POST", "/api/staff/printer", { useMyIp: true, port: 47913 }, auth);
  assert.deepEqual(set.body.printer, { host: "77.125.10.20", port: 47913 });
  assert.deepEqual((await call("GET", "/api/staff/orders", undefined, auth)).body.printer, { host: "77.125.10.20", port: 47913 });
  assert.equal((await call("POST", "/api/staff/print", { data: btoa("hello") }, auth)).body.error, "bad_data");
  // a test page (no order)
  assert.equal((await call("POST", "/api/staff/print", { data: ticket }, auth)).body.ok, true);
  assert.equal(printed.at(-1).host, "77.125.10.20");
  // an unpaid order is not printed
  now += 3600000;
  const o = (await call("POST", "/api/orders", { items: [{ id: drinkId, q: 1 }], name: "רנא", pay: "bit" }, { ip: "5.5.5.5" })).body;
  assert.equal((await call("POST", "/api/staff/print", { data: ticket, id: o.id }, auth)).body.error, "not_paid");
  await call("POST", `/api/staff/orders/${o.id}/paid`, {}, auth);
  // printer down: the order stays unprinted so it is tried again
  printerUp = false;
  assert.equal((await call("POST", "/api/staff/print", { data: ticket, id: o.id }, auth)).body.error, "printer_unreachable");
  assert.equal((await call("GET", "/api/staff/orders", undefined, auth)).body.orders.find(x => x.id === o.id).printed, 0);
  printerUp = true;
  const n = printed.length;
  assert.equal((await call("POST", "/api/staff/print", { data: ticket, id: o.id }, auth)).body.ok, true);
  assert.equal((await call("POST", "/api/staff/print", { data: ticket, id: o.id }, auth)).body.skipped, true);
  assert.equal((await call("POST", "/api/staff/print", { data: ticket, id: o.id, again: true }, auth)).body.ok, true);
  assert.equal(printed.length, n + 2);
  assert.equal((await call("POST", "/api/staff/printer", { clear: true }, auth)).body.printer, null);
});

await test("printing on the shop computer: claim once, reprint asked from the phone", async () => {
  const { token } = (await call("POST", "/api/staff/login", { pin: "482913" }, { ip: "9.9.9.8" })).body;
  const auth = { Authorization: "Bearer " + token, ip: "77.125.10.20" };
  now += 3600000;
  const o = (await call("POST", "/api/orders", { items: [{ id: drinkId, q: 1 }], name: "רנא", pay: "bit" }, { ip: "5.5.5.6" })).body;
  assert.equal((await call("POST", `/api/staff/orders/${o.id}/claim`, {}, auth)).body.error, "not_paid");
  await call("POST", `/api/staff/orders/${o.id}/paid`, {}, auth);
  assert.deepEqual((await call("POST", `/api/staff/orders/${o.id}/claim`, {}, auth)).body, { claimed: true, again: false });
  assert.deepEqual((await call("POST", `/api/staff/orders/${o.id}/claim`, {}, auth)).body, { claimed: false });
  assert.equal((await call("POST", `/api/staff/orders/${o.id}/reprint`, {}, auth)).body.ok, true);
  assert.equal((await call("GET", "/api/staff/orders", undefined, auth)).body.orders.find(x => x.id === o.id).printed, 2);
  assert.deepEqual((await call("POST", `/api/staff/orders/${o.id}/claim`, {}, auth)).body, { claimed: true, again: true });
  assert.equal((await call("POST", `/api/staff/orders/${o.id}/claim`, {}, auth)).body.claimed, false);
});

console.log(`\n${passed} tests passed`);
