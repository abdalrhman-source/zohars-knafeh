// Local stand-in for the Cloudflare Worker, for testing pages against the real order logic.
// usage: node server/test/dev-server.mjs <port> <allowed-origin> <staff-pin>
import http from "node:http";
import { handle, migrate } from "../src/app.js";
import { memorySql } from "./run-helpers.mjs";

const [port = "8790", origin = "http://127.0.0.1:8775", pin = "482913"] = process.argv.slice(2);
const sql = memorySql();
migrate(sql);
const env = { STAFF_PIN: pin, PAY_METHODS: "bit" };

http.createServer(async (req, res) => {
  const cors = {
    "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  let body = "";
  for await (const chunk of req) body += chunk;
  const r = await handle(new Request("https://shop" + req.url, {
    method: req.method, headers: { "Content-Type": "application/json", "Authorization": req.headers.authorization || "", "X-Client-IP": "127.0.0.1" },
    body: req.method === "POST" ? body : undefined
  }), sql, env);
  res.writeHead(r.status, { ...cors, "Content-Type": "application/json" });
  res.end(await r.text());
}).listen(+port, "127.0.0.1", () => console.log("dev order server on", port));
