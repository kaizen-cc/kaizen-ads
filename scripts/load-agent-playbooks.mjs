// Loads the agent playbooks condensed from Kaizen's Claude projects (docs/agent-sources/plans/*.json) into
// ai_agents / ai_knowledge, and the client-specific notes into client_memory. Safe to re-run: items with the
// same agent and title are updated, not duplicated.
//   node scripts/load-agent-playbooks.mjs          (dry run: prints what would change)
//   node scripts/load-agent-playbooks.mjs --go     (writes)
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const go = process.argv.includes("--go");
const dir = "docs/agent-sources/plans";
const plans = readdirSync(dir).map((f) => ({ file: f, ...JSON.parse(readFileSync(join(dir, f), "utf8")) }));
const log = (...a) => console.log(go ? "" : "[dry]", ...a);

async function must(p) {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return data;
}

// Instructions: replace first, then appends (the scripts plan appends a line to the brief strategist)
const instr = plans.flatMap((p) => (p.instructions ?? []).map((i) => ({ ...i, file: p.file })));
for (const i of [...instr.filter((x) => x.mode !== "append"), ...instr.filter((x) => x.mode === "append")]) {
  const [agent] = await must(db.from("ai_agents").select("key, instructions").eq("key", i.agent_key));
  if (!agent) throw new Error(`No agent ${i.agent_key}`);
  const text = i.mode === "append" ? `${agent.instructions.trim()}\n\n${i.text.trim()}` : i.text.trim();
  log(`instructions ${i.mode} · ${i.agent_key} · ${Math.round(text.length / 4)} tokens (${i.file})`);
  if (go) await must(db.from("ai_agents").update({ instructions: text, updated_at: new Date().toISOString() }).eq("key", i.agent_key));
}

// Items: replace an existing title, update the same title, or insert
for (const p of plans)
  for (const it of p.items ?? []) {
    const scope = (q) => (it.agent_key ? q.eq("agent_key", it.agent_key) : q.is("agent_key", null));
    const titles = [it.replaces_existing_title, it.title].filter(Boolean);
    const existing = await must(scope(db.from("ai_knowledge").select("id, title")).in("title", titles));
    const row = { agent_key: it.agent_key, kind: it.kind, title: it.title, body: it.body.trim(), active: true, updated_at: new Date().toISOString() };
    if (existing.length) {
      log(`update ${it.agent_key ?? "shared"} · ${it.kind} · ${it.title}${it.replaces_existing_title && it.replaces_existing_title !== it.title ? ` (was "${it.replaces_existing_title}")` : ""}`);
      if (go) await must(db.from("ai_knowledge").update(row).eq("id", existing[0].id));
    } else {
      log(`add ${it.agent_key ?? "shared"} · ${it.kind} · ${it.title} · ${Math.round(it.body.length / 4)} tokens`);
      if (go) await must(db.from("ai_knowledge").insert(row));
    }
  }

// "How Kaizen works": the main designer and editor, and Kyle's copy format
const [how] = await must(db.from("ai_knowledge").select("id, body").is("agent_key", null).eq("title", "How Kaizen works"));
if (how) {
  let body = how.body
    .replace(
      "Graphic designers make images and carousels; video editors make videos. Jesus is Head of Creative and approves creative internally.",
      "Graphic designers make images and carousels (Nelson is the main graphic designer); video editors make videos (Jazem is the main video editor). Jesus is Head of Creative and approves creative internally.",
    )
    .replace(
      "Copy: approved once per angle and covers all creatives on that angle. Up to 3 primary texts and 3 headlines per angle.",
      "Copy: approved once per angle and covers all creatives on that angle. Each angle gets a set of 5 ads: 3 short-form (50-125 characters) and 2 long-form (300-800 words), each with a headline (max 40 characters), link description (max 30) and an official Meta CTA button. Camille reviews every set with a character count on each field.",
    );
  log(`update shared · How Kaizen works (team and copy format)`);
  if (go) await must(db.from("ai_knowledge").update({ body, updated_at: new Date().toISOString() }).eq("id", how.id));
}

// Client memory
const clients = await must(db.from("clients").select("id, name"));
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
for (const p of plans)
  for (const c of p.client_specific ?? []) {
    const client = clients.find((x) => norm(x.name) === norm(c.client));
    if (!client) {
      console.warn(`! no client named ${c.client}`);
      continue;
    }
    const have = await must(db.from("client_memory").select("body").eq("client_id", client.id));
    for (const n of c.notes ?? []) {
      if (have.some((h) => h.body === n.body)) continue;
      log(`memory ${client.name} · ${n.kind} · ${n.body.slice(0, 70)}…`);
      if (go) await must(db.from("client_memory").insert({ client_id: client.id, kind: n.kind, body: n.body, source: "team", status: "active" }));
    }
  }
console.log(go ? "Done." : "Dry run. Add --go to write.");
