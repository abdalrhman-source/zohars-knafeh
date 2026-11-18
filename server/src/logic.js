// Pure order logic: prices and add-on rules are always computed here, never trusted from the browser.
import { MENU, GROUPS, RULES, SILENT } from "./menu.js";

export const MAX_LINES = 30;
export const MAX_QTY = 20;

export function visible(group, sel) {
  const r = RULES[group];
  if (!r || !r.show) return true;
  return (sel[r.show.g] || []).some(v => r.show.any.includes(v));
}

function optText(item, sel, lang) {
  return item.o
    .filter(g => visible(g, sel) && (sel[g] || []).length)
    .flatMap(g => sel[g]
      .filter(v => SILENT[g] !== v)
      .map(v => GROUPS[g].v[v][lang] + (GROUPS[g].v[v][3] ? ` (+${GROUPS[g].v[v][3]}₪)` : "")));
}

/** Validates the cart and returns {lines, total} or {error, detail}. */
export function priceOrder(items) {
  if (!Array.isArray(items) || items.length === 0) return { error: "empty_order" };
  if (items.length > MAX_LINES) return { error: "too_many_lines" };
  const lines = [];
  let total = 0;
  for (const raw of items) {
    if (!raw || typeof raw !== "object") return { error: "bad_item" };
    const item = MENU[raw.id];
    if (!item) return { error: "unknown_item", detail: String(raw.id).slice(0, 40) };
    if (item.off) return { error: "item_unavailable", detail: raw.id };
    const q = raw.q;
    if (!Number.isInteger(q) || q < 1 || q > MAX_QTY) return { error: "bad_quantity", detail: raw.id };
    const given = raw.s && typeof raw.s === "object" && !Array.isArray(raw.s) ? raw.s : {};
    for (const g of Object.keys(given)) if (!item.o.includes(g)) return { error: "bad_option_group", detail: g };
    const sel = {};
    for (const g of item.o) {
      const v = given[g];
      if (v === undefined) continue;
      if (!Array.isArray(v) || v.some(x => !Number.isInteger(x) || x < 0 || x >= GROUPS[g].v.length)) return { error: "bad_option", detail: g };
      sel[g] = [...new Set(v)].sort((a, b) => a - b);
    }
    const clean = {};
    let unit = item.p;
    for (const g of item.o) {
      const r = RULES[g] || {};
      const chosen = visible(g, sel) ? (sel[g] || []) : [];
      if (chosen.length > GROUPS[g].max) return { error: "too_many_options", detail: g };
      if ((r.min || 0) > chosen.length && visible(g, sel)) return { error: "missing_option", detail: g };
      if (chosen.length) clean[g] = chosen;
      unit += chosen.reduce((a, v) => a + (GROUPS[g].v[v][3] || 0), 0);
    }
    const p = unit * q;
    total += p;
    lines.push({ id: raw.id, q, s: clean, n: item.n, o: [0, 1, 2].map(l => optText(item, clean, l)), p });
  }
  return { lines, total };
}

const CTRL = /[\u0000-\u001f\u007f]/g;
/** Name is required (the shop matches Bit transfers by name); phone is optional. */
export function cleanCustomer(body) {
  const name = String(body.name || "").replace(CTRL, " ").trim().slice(0, 40);
  if (name.length < 2) return { error: "missing_name" };
  let phone = String(body.phone || "").replace(/[\s-]/g, "");
  if (phone) {
    if (phone.startsWith("+972")) phone = "0" + phone.slice(4);
    if (!/^0\d{8,9}$/.test(phone)) return { error: "bad_phone" };
  }
  const note = String(body.note || "").replace(CTRL, " ").trim().slice(0, 200);
  const lang = ["he", "ar", "en"].includes(body.lang) ? body.lang : "he";
  return { name, phone, note, lang };
}
