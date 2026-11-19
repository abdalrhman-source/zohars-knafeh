// Request handling for one shop. Runs inside the Shop Durable Object, which gives it SQLite storage.
import { priceOrder, cleanCustomer } from "./logic.js";
import { SHOP } from "./menu.js";

const DAY_MS = 86400000;
const UNPAID_EXPIRES_MS = 30 * 60000;      // an unpaid Bit order is cancelled after 30 minutes
const KEEP_MS = 30 * DAY_MS;               // orders (with names and phones) are deleted after 30 days
const TOKEN_MS = 30 * DAY_MS;              // the shop screen stays signed in for 30 days

export function migrate(sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS orders(
    id TEXT PRIMARY KEY, no INTEGER, day TEXT, created INTEGER, updated INTEGER,
    status TEXT, paid INTEGER, pay TEXT, name TEXT, phone TEXT, note TEXT,
    total INTEGER, lines TEXT, lang TEXT)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS orders_day ON orders(day)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS orders_status ON orders(status)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS hits(k TEXT, ts INTEGER)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS hits_k ON hits(k, ts)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT)`);
  // printed: 0 = not printed yet, 1 = printed in the kitchen, 2 = print again (asked from any shop screen)
  try { sql.exec(`ALTER TABLE orders ADD COLUMN printed INTEGER NOT NULL DEFAULT 0`); } catch { /* column already there */ }
  // a marketing list was here for a short while by mistake; it belongs to another website
  sql.exec(`DROP TABLE IF EXISTS leads`);
}

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
});
const rows = (sql, q, ...b) => sql.exec(q, ...b).toArray();
const getSetting = (sql, k) => (rows(sql, `SELECT v FROM settings WHERE k = ?`, k)[0] || {}).v;
const setSetting = (sql, k, v) => sql.exec(`INSERT INTO settings(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, k, String(v));
/** Where the kitchen printer is reached from the internet: the shop's address and the port the router forwards to it. */
const printerTarget = sql => {
  const host = getSetting(sql, "printer_host"), port = +(getSetting(sql, "printer_port") || 0);
  return host && port ? { host, port } : null;
};
const MAX_PRINT_BYTES = 300000;
/** Online ordering stays closed until someone signed in to the shop screen opens it. */
const isOpen = sql => (rows(sql, `SELECT v FROM settings WHERE k = 'open'`)[0] || {}).v === "1";
const dayKey = now => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date(now));

/** Counts a hit for key k; false when k already has `limit` hits inside the window. */
function allow(sql, k, limit, windowMs, now) {
  const [{ c }] = rows(sql, `SELECT COUNT(*) AS c FROM hits WHERE k = ? AND ts > ?`, k, now - windowMs);
  if (c >= limit) return false;
  sql.exec(`INSERT INTO hits(k, ts) VALUES (?, ?)`, k, now);
  return true;
}

function view(o, staff) {
  const out = {
    id: o.id, no: o.no, created: o.created, status: o.status, paid: !!o.paid, pay: o.pay,
    total: o.total, lines: JSON.parse(o.lines), name: o.name
  };
  if (staff) Object.assign(out, { phone: o.phone, note: o.note, updated: o.updated, printed: o.printed || 0 });
  else out.bitPhone = SHOP.bitPhone;
  return out;
}

/* ---------- staff sign-in: an HMAC-signed token with an expiry, keyed by the shop's PIN ---------- */
const enc = new TextEncoder();
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}
const tokenSecret = env => `${env.STAFF_PIN}|${env.TOKEN_SALT || "zk-staff"}`;
async function makeToken(env, now) {
  const exp = now + TOKEN_MS;
  return { token: `${exp}.${await hmac(tokenSecret(env), String(exp))}`, exp };
}
async function checkToken(env, header, now) {
  const m = /^Bearer (\d+)\.([0-9a-f]{64})$/.exec(header || "");
  if (!m || +m[1] < now) return false;
  return (await hmac(tokenSecret(env), m[1])) === m[2];
}
async function samePin(env, pin) {
  // compare HMACs, so the time taken does not depend on how much of the PIN matches
  return (await hmac("pin", String(pin))) === (await hmac("pin", String(env.STAFF_PIN)));
}

const NEXT = {   // allowed status changes from the shop screen
  paid: { from: ["awaiting_payment"], to: "new", paid: 1 },
  cancel: { from: ["awaiting_payment", "new"], to: "cancelled" },
  ready: { from: ["new"], to: "ready" },
  reopen: { from: ["ready"], to: "new" },
  done: { from: ["ready"], to: "done" }
};

/**
 * io.print(host, port, bytes) sends raw bytes to the kitchen printer (a TCP socket in the Worker);
 * tests pass their own.
 */
export async function handle(req, sql, env, now = Date.now(), io = {}) {
  const url = new URL(req.url);
  const path = url.pathname;
  const ip = req.headers.get("X-Client-IP") || "0";
  const pays = String(env.PAY_METHODS || "bit").split(",").map(s => s.trim()).filter(Boolean);
  let body = {};
  if (req.method === "POST") {
    const text = await req.text();
    if (text.length > (path === "/api/staff/print" ? MAX_PRINT_BYTES * 1.4 + 2000 : 16000)) return json({ error: "too_large" }, 413);
    try { body = text ? JSON.parse(text) : {}; } catch { return json({ error: "bad_json" }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "bad_json" }, 400);
  }

  // unpaid orders that were never confirmed are cancelled after 30 minutes
  sql.exec(`UPDATE orders SET status = 'cancelled', updated = ? WHERE status = 'awaiting_payment' AND created < ?`, now, now - UNPAID_EXPIRES_MS);

  /* ---------- customers ---------- */
  if (path === "/api/config" && req.method === "GET") {
    return json({ pays, bitPhone: SHOP.bitPhone, open: isOpen(sql) });
  }

  if (path === "/api/orders" && req.method === "POST") {
    // at most 30 tries and 6 placed orders per device in 10 minutes
    if (!allow(sql, "try:" + ip, 30, 10 * 60000, now)) return json({ error: "rate_limited" }, 429);
    if (!isOpen(sql)) return json({ error: "closed" }, 403);
    const [{ c: placed }] = rows(sql, `SELECT COUNT(*) AS c FROM hits WHERE k = ? AND ts > ?`, "order:" + ip, now - 10 * 60000);
    if (placed >= 6) return json({ error: "rate_limited" }, 429);
    const [{ c: pending }] = rows(sql, `SELECT COUNT(*) AS c FROM orders WHERE status = 'awaiting_payment'`);
    if (pending >= 40) return json({ error: "busy" }, 503);
    if (!pays.includes(body.pay)) return json({ error: "pay_not_available" }, 400);
    const cust = cleanCustomer(body);
    if (cust.error) return json(cust, 400);
    const priced = priceOrder(body.items);
    if (priced.error) return json(priced, 400);
    const day = dayKey(now);
    const [{ n }] = rows(sql, `SELECT COALESCE(MAX(no), 0) + 1 AS n FROM orders WHERE day = ?`, day);
    const id = crypto.randomUUID();
    const status = body.pay === "bit" ? "awaiting_payment" : "new";
    // card / Apple Pay / Google Pay become "paid" only through the payment company's confirmation (not wired yet)
    const paid = 0;
    sql.exec(`INSERT INTO orders(id, no, day, created, updated, status, paid, pay, name, phone, note, total, lines, lang)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, n, day, now, now, status, paid, body.pay, cust.name, cust.phone, cust.note, priced.total, JSON.stringify(priced.lines), cust.lang);
    sql.exec(`INSERT INTO hits(k, ts) VALUES (?, ?)`, "order:" + ip, now);
    return json(view(rows(sql, `SELECT * FROM orders WHERE id = ?`, id)[0], false), 201);
  }

  let m = /^\/api\/orders\/([0-9a-f-]{36})$/.exec(path);
  if (m && req.method === "GET") {
    if (!allow(sql, "status:" + ip, 120, 60000, now)) return json({ error: "rate_limited" }, 429);
    const o = rows(sql, `SELECT * FROM orders WHERE id = ?`, m[1])[0];
    return o ? json(view(o, false)) : json({ error: "not_found" }, 404);
  }

  /* ---------- the shop screen ---------- */
  if (path.startsWith("/api/staff/")) {
    if (!env.STAFF_PIN) return json({ error: "staff_disabled" }, 503);
    if (path === "/api/staff/login" && req.method === "POST") {
      if (!allow(sql, "login:" + ip, 8, 15 * 60000, now)) return json({ error: "rate_limited" }, 429);
      if (!(await samePin(env, body.pin))) return json({ error: "wrong_pin" }, 401);
      return json(await makeToken(env, now));
    }
    if (!(await checkToken(env, req.headers.get("Authorization"), now))) return json({ error: "unauthorized" }, 401);

    if (path === "/api/staff/orders" && req.method === "GET") {
      const list = rows(sql, `SELECT * FROM orders WHERE status NOT IN ('done', 'cancelled') OR updated > ? ORDER BY no`, now - 10 * 60000);
      // the shop computer that prints through its browser says so on every refresh, so the phone can show it is there
      if (url.searchParams.get("local") === "1") setSetting(sql, "local_seen", now);
      return json({
        now, open: isOpen(sql), printer: printerTarget(sql),
        localSeen: +(getSetting(sql, "local_seen") || 0) || null,
        testAsked: +(getSetting(sql, "print_test") || 0) || null,
        orders: list.map(o => view(o, true))
      });
    }
    if (path === "/api/staff/printer" && req.method === "POST") {
      if (body.clear === true) {
        sql.exec(`DELETE FROM settings WHERE k IN ('printer_host', 'printer_port')`);
        return json({ printer: null });
      }
      const port = body.port;
      if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 25) return json({ error: "bad_port" }, 400);
      // "use this network": the address the shop screen is calling from, when it is on the shop's Wi-Fi
      const host = body.useMyIp === true ? ip : String(body.host || "").trim().toLowerCase();
      // routers forward ports on the IPv4 address; an IPv6 address would need a different router setting
      if (body.useMyIp === true && host.includes(":")) return json({ error: "ipv6" }, 400);
      if (!/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(host) && !/^[0-9a-f:]{2,39}$/.test(host)) return json({ error: "bad_host" }, 400);
      setSetting(sql, "printer_host", host);
      setSetting(sql, "printer_port", port);
      return json({ printer: printerTarget(sql) });
    }
    if (path === "/api/staff/print-test" && req.method === "POST") {
      // a test page asked from the phone; the shop computer prints it on its next refresh
      setSetting(sql, "print_test", now);
      return json({ ok: true });
    }
    if (path === "/api/staff/print-test/claim" && req.method === "POST") {
      const asked = +(getSetting(sql, "print_test") || 0);
      sql.exec(`DELETE FROM settings WHERE k = 'print_test'`);
      return json({ claimed: !!asked && now - asked < 10 * 60000 });
    }
    if (path === "/api/staff/print" && req.method === "POST") {
      // the shop screen draws the ticket (Hebrew and Arabic come out right) and sends it ready for the printer
      const target = printerTarget(sql);
      if (!target) return json({ error: "no_printer" }, 409);
      if (typeof body.data !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.data)) return json({ error: "bad_data" }, 400);
      let bytes;
      try { bytes = Uint8Array.from(atob(body.data), ch => ch.charCodeAt(0)); } catch { return json({ error: "bad_data" }, 400); }
      if (bytes.length < 4 || bytes.length > MAX_PRINT_BYTES || bytes[0] !== 0x1b || bytes[1] !== 0x40) return json({ error: "bad_data" }, 400);
      let o = null;
      if (body.id !== undefined) {
        o = rows(sql, `SELECT * FROM orders WHERE id = ?`, String(body.id))[0];
        if (!o) return json({ error: "not_found" }, 404);
        if (!["new", "ready", "done"].includes(o.status)) return json({ error: "not_paid" }, 409);
        // two shop screens may both try to print a new order; only the first one prints it
        if (o.printed === 1 && body.again !== true) return json({ skipped: true });
        sql.exec(`UPDATE orders SET printed = 1 WHERE id = ?`, o.id);
      }
      if (!io.print) return json({ error: "print_unavailable" }, 503);
      try {
        await io.print(target.host, target.port, bytes);
      } catch {
        if (o && o.printed !== 1) sql.exec(`UPDATE orders SET printed = ? WHERE id = ?`, o.printed, o.id);
        return json({ error: "printer_unreachable" }, 502);
      }
      return json({ ok: true });
    }
    if (path === "/api/staff/open" && req.method === "POST") {
      if (typeof body.open !== "boolean") return json({ error: "bad_request" }, 400);
      sql.exec(`INSERT INTO settings(k, v) VALUES ('open', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, body.open ? "1" : "0");
      return json({ open: isOpen(sql) });
    }
    m = /^\/api\/staff\/orders\/([0-9a-f-]{36})\/(reprint|claim)$/.exec(path);
    if (m && req.method === "POST") {
      const o = rows(sql, `SELECT * FROM orders WHERE id = ?`, m[1])[0];
      if (!o) return json({ error: "not_found" }, 404);
      if (!["new", "ready", "done"].includes(o.status)) return json({ error: "not_paid" }, 409);
      if (m[2] === "reprint") {
        // whichever screen prints for the kitchen picks it up and prints a copy
        sql.exec(`UPDATE orders SET printed = 2 WHERE id = ?`, o.id);
        return json({ ok: true });
      }
      // the shop computer takes an order to print with its own printer; only one screen gets it
      if (o.printed === 1) return json({ claimed: false });
      sql.exec(`UPDATE orders SET printed = 1 WHERE id = ?`, o.id);
      return json({ claimed: true, again: o.printed === 2 });
    }
    m = /^\/api\/staff\/orders\/([0-9a-f-]{36})\/(paid|cancel|ready|reopen|done)$/.exec(path);
    if (m && req.method === "POST") {
      const o = rows(sql, `SELECT * FROM orders WHERE id = ?`, m[1])[0];
      if (!o) return json({ error: "not_found" }, 404);
      const step = NEXT[m[2]];
      if (!step.from.includes(o.status)) return json({ error: "bad_transition", status: o.status }, 409);
      sql.exec(`UPDATE orders SET status = ?, paid = ?, updated = ? WHERE id = ?`, step.to, step.paid ?? o.paid, now, o.id);
      return json(view(rows(sql, `SELECT * FROM orders WHERE id = ?`, o.id)[0], true));
    }
    return json({ error: "not_found" }, 404);
  }

  if (path === "/internal/cleanup" && req.method === "POST") {
    sql.exec(`DELETE FROM orders WHERE created < ?`, now - KEEP_MS);
    sql.exec(`DELETE FROM hits WHERE ts < ?`, now - DAY_MS);
    return json({ ok: true });
  }
  return json({ error: "not_found" }, 404);
}
