// Cloudflare Worker: the public API for orders. One Durable Object per shop keeps its orders in SQLite.
import { DurableObject } from "cloudflare:workers";
import { connect } from "cloudflare:sockets";
import { handle, migrate } from "./app.js";
import { SHOP } from "./menu.js";

const SECURITY = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000"
};

function corsFor(env, origin) {
  const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function withHeaders(res, extra) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries({ ...SECURITY, ...(extra || {}) })) h.set(k, v);
  return new Response(res.body, { status: res.status, headers: h });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get("Origin");
    const cors = corsFor(env, origin);
    if (req.method === "OPTIONS") return new Response(null, { status: cors ? 204 : 403, headers: { ...SECURITY, ...(cors || {}) } });
    // writes are accepted only from the shop's own pages
    if (req.method === "POST" && origin && !cors) return withHeaders(new Response('{"error":"forbidden_origin"}', { status: 403, headers: { "Content-Type": "application/json" } }));
    if (url.pathname === "/api/health") return withHeaders(Response.json({ ok: true }), cors);
    if (!url.pathname.startsWith("/api/") || url.pathname.startsWith("/api/internal")) {
      return withHeaders(new Response('{"error":"not_found"}', { status: 404, headers: { "Content-Type": "application/json" } }), cors);
    }
    const stub = env.SHOP.get(env.SHOP.idFromName(SHOP.slug));
    const inner = new Request("https://shop" + url.pathname + url.search, {
      method: req.method,
      headers: {
        "Content-Type": "application/json",
        "Authorization": req.headers.get("Authorization") || "",
        "X-Client-IP": req.headers.get("CF-Connecting-IP") || "0"
      },
      body: req.method === "POST" ? await req.text() : undefined
    });
    return withHeaders(await stub.fetch(inner), cors);
  },

  // daily: delete orders older than 30 days and old rate-limit records
  async scheduled(event, env) {
    const stub = env.SHOP.get(env.SHOP.idFromName(SHOP.slug));
    await stub.fetch("https://shop/internal/cleanup", { method: "POST" });
  }
};

/** Rejects if p does not settle within ms; the timer is cleared either way. */
function within(p, ms) {
  let t;
  return Promise.race([p, new Promise((_, no) => { t = setTimeout(() => no(new Error("timeout")), ms); })]).finally(() => clearTimeout(t));
}
/** Sends raw printer bytes to the kitchen printer over TCP (port 9100 behind the shop's router). */
async function sendToPrinter(hostname, port, bytes) {
  const socket = connect({ hostname, port });
  try {
    await within(socket.opened, 7000);
    const w = socket.writable.getWriter();
    await within(w.write(bytes), 15000);
    await within(w.close(), 5000);
  } finally {
    socket.close().catch(() => {});
  }
}

export class Shop extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => migrate(this.sql));
  }
  async fetch(req) {
    return handle(req, this.sql, this.env, Date.now(), { print: sendToPrinter });
  }
}
