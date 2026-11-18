import { DatabaseSync } from "node:sqlite";

export function memorySql() {
  const db = new DatabaseSync(":memory:");
  return {
    exec(q, ...b) {
      const st = db.prepare(q);
      const isRead = /^\s*(SELECT|WITH)/i.test(q);
      const out = isRead ? st.all(...b) : (st.run(...b), []);
      return { toArray: () => out.map(r => ({ ...r })) };
    }
  };
}
