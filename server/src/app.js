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
  // marketing: people to reach (influencers found on Instagram and the like); only the shop screen sees them
  sql.exec(`CREATE TABLE IF NOT EXISTS leads(
    id TEXT PRIMARY KEY, platform TEXT, handle TEXT, name TEXT, content TEXT, contact TEXT, status TEXT,
    followers INTEGER, views INTEGER, country TEXT, note TEXT, source TEXT, created INTEGER, updated INTEGER,
    UNIQUE(platform, handle))`);
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
/* ---------- marketing leads ---------- */
const LEAD_STATUS = ["new", "contacted", "replied", "deal", "no"];
const LEAD_PLATFORMS = ["instagram", "tiktok", "facebook", "snapchat", "x", "youtube", "other"];
const MAX_LEADS = 3000, MAX_LEADS_PER_IMPORT = 500;
const clip = (v, n) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
/** 12,345 / 12.3K / 1.2M -> a whole number; anything else -> null */
function count(v) {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
  const m = /^([0-9][0-9,]*(?:\.[0-9]+)?)\s*([kKmM])?$/.exec(String(v ?? "").trim());
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, "")) * (m[2] ? (/k/i.test(m[2]) ? 1e3 : 1e6) : 1);
  return Number.isFinite(n) && n < 1e11 ? Math.round(n) : null;
}
/** "@name", "instagram.com/name", "https://www.tiktok.com/@name" -> {platform, handle} */
function leadAccount(account, platform) {
  let a = clip(account, 200), p = LEAD_PLATFORMS.includes(platform) ? platform : "";
  const url = /^(?:https?:\/\/)?(?:www\.|m\.)?(instagram\.com|tiktok\.com|facebook\.com|snapchat\.com|x\.com|twitter\.com|youtube\.com)\/(?:add\/)?@?([^/?#\s]+)/i.exec(a);
  if (url) {
    const site = url[1].toLowerCase();
    p = { "instagram.com": "instagram", "tiktok.com": "tiktok", "facebook.com": "facebook", "snapchat.com": "snapchat", "x.com": "x", "twitter.com": "x", "youtube.com": "youtube" }[site];
    a = url[2];
  }
  p = p || "instagram";
  a = a.replace(/^@/, "");
  if (p === "other") return a ? { platform: p, handle: a.slice(0, 100) } : null;
  a = a.toLowerCase();
  return /^[a-z0-9._-]{1,60}$/.test(a) ? { platform: p, handle: a } : null;
}
const leadView = l => ({
  id: l.id, platform: l.platform, handle: l.handle, name: l.name, content: l.content, contact: l.contact, status: l.status,
  followers: l.followers, views: l.views, country: l.country, note: l.note, source: l.source, created: l.created, updated: l.updated
});
const allLeads = sql => rows(sql, `SELECT * FROM leads ORDER BY created DESC, followers DESC`).map(leadView);

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
    const limit = path === "/api/staff/print" ? MAX_PRINT_BYTES * 1.4 + 2000 : path === "/api/staff/leads" ? 400000 : 16000;
    if (text.length > limit) return json({ error: "too_large" }, 413);
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
    if (path === "/api/staff/leads" && req.method === "GET") return json({ leads: allLeads(sql) });
    if (path === "/api/staff/leads" && req.method === "POST") {
      // adds new leads and fills in what is known about ones already on the list (matched by platform and account)
      if (!Array.isArray(body.leads) || !body.leads.length || body.leads.length > MAX_LEADS_PER_IMPORT) return json({ error: "bad_request" }, 400);
      let added = 0, updated = 0, skipped = 0;
      let [{ c: total }] = rows(sql, `SELECT COUNT(*) AS c FROM leads`);
      for (const x of body.leads) {
        const acc = x && typeof x === "object" ? leadAccount(x.account ?? x.handle, x.platform) : null;
        if (!acc) { skipped++; continue; }
        const f = {
          name: clip(x.name, 120), content: clip(x.content, 120), contact: clip(x.contact, 120), country: clip(x.country, 80),
          note: clip(x.note, 500), source: clip(x.source, 80), followers: count(x.followers), views: count(x.views),
          status: LEAD_STATUS.includes(x.status) ? x.status : null
        };
        const old = rows(sql, `SELECT * FROM leads WHERE platform = ? AND handle = ?`, acc.platform, acc.handle)[0];
        if (old) {
          sql.exec(`UPDATE leads SET name = ?, content = ?, contact = ?, country = ?, note = ?, source = ?, followers = ?, views = ?, status = ?, updated = ? WHERE id = ?`,
            f.name || old.name, f.content || old.content, f.contact || old.contact, f.country || old.country, f.note || old.note,
            f.source || old.source, f.followers ?? old.followers, f.views ?? old.views, f.status || old.status, now, old.id);
          updated++;
        } else {
          if (total >= MAX_LEADS) { skipped++; continue; }
          sql.exec(`INSERT INTO leads(id, platform, handle, name, content, contact, status, followers, views, country, note, source, created, updated)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            crypto.randomUUID(), acc.platform, acc.handle, f.name, f.content, f.contact, f.status || "new", f.followers, f.views, f.country, f.note, f.source, now, now);
          added++; total++;
        }
      }
      return json({ added, updated, skipped, leads: allLeads(sql) });
    }
    m = /^\/api\/staff\/leads\/([0-9a-f-]{36})(\/delete)?$/.exec(path);
    if (m && req.method === "POST") {
      const l = rows(sql, `SELECT * FROM leads WHERE id = ?`, m[1])[0];
      if (!l) return json({ error: "not_found" }, 404);
      if (m[2]) { sql.exec(`DELETE FROM leads WHERE id = ?`, l.id); return json({ ok: true }); }
      if (body.status !== undefined && !LEAD_STATUS.includes(body.status)) return json({ error: "bad_request" }, 400);
      const v = k => body[k] === undefined ? l[k] : clip(body[k], k === "note" ? 500 : 120);
      sql.exec(`UPDATE leads SET status = ?, name = ?, content = ?, contact = ?, note = ?, updated = ? WHERE id = ?`,
        body.status ?? l.status, v("name"), v("content"), v("contact"), v("note"), now, l.id);
      return json(leadView(rows(sql, `SELECT * FROM leads WHERE id = ?`, l.id)[0]));
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
