// The fingerprint of the code that builds everyone's day (the Overview's blocks and the recap). Baked into the build
// (next.config.ts, DAY_LOGIC_HASH) and stamped on every saved day (src/lib/today.ts dayShape): a deploy that changes
// any of these files rebuilds each person's saved day on their next look, so nobody keeps the old shape (owner, Nov 24
// 2026: a fix reached only the people whose day happened to be rebuilt). A deploy that doesn't touch them keeps the
// saved days (no slow first load after every deploy).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The files whose changes reshape a day: what gathers it, owns it, groups it, counts it and closes it */
export const DAY_LOGIC = /^(today|exec-overview|item-owners|item-state|agent-asks|support-day|maker-day|escalation-ladder|asana-live|owed-replies|message-promises|done-check|email-drafts|youtube)[\w-]*\.ts$/;

export function dayLogicHash(root = process.cwd()) {
  const dir = join(root, "src", "lib");
  const files = readdirSync(dir).filter((f) => DAY_LOGIC.test(f)).sort();
  const h = createHash("sha1");
  for (const f of files) h.update(f).update("\0").update(readFileSync(join(dir, f)).toString("utf8").replace(/\r\n/g, "\n"));
  return { hash: h.digest("hex").slice(0, 12), files };
}
