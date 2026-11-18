import "server-only";
import { clientNamed as sharedClientNamed } from "@/lib/client-named";
import type { Staff } from "@/lib/auth";
import { clientPackage, packageBlock } from "@/lib/client-package";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { str, num, type AiTool } from "./types";

// What the team already knows, for every agent, on calls and in chats (registered in src/lib/kaizen-ai/extensions.ts):
//   search_looms    the Loom recordings synced into Kaizen OS (audits, walkthroughs, client calls), by topic and client
//   read_loom       one recording's transcript, or the passages about a topic
//   client_package  a client's package tier per service (basic, silver, gold) and what it includes
// Read with the person's own session first (staff read the Loom library; a client's recordings only when they can see
// that client), nothing written. Looms aren't tagged with who recorded them: search by client and topic.

const clean = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
/** Loom's page titles carry "Loom | Free Screen & Video Recording Software | Loom - <date>": the real title, or the date */
const titleOf = (t: unknown) => clean(t).replace(/&amp;/g, "&").replace(/^Loom \| Free Screen & Video Recording Software \| Loom\s*-?\s*/i, "Loom recording ") || "Loom recording";
const words = (q: string) =>
  q
    .replace(/[%_,()*\\]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 2)
    .slice(0, 6);

/** Passages of a transcript around the words asked about (each a little over a thousand characters) */
export function passages(text: string, terms: string[], max = 8, size = 1200): string[] {
  const lower = text.toLowerCase();
  const hits: number[] = [];
  for (const t of terms) {
    let at = lower.indexOf(t.toLowerCase());
    while (at >= 0 && hits.length < 60) {
      hits.push(at);
      at = lower.indexOf(t.toLowerCase(), at + t.length);
    }
  }
  hits.sort((a, b) => a - b);
  const out: string[] = [];
  let end = -1;
  for (const h of hits) {
    if (h < end) continue;
    const start = Math.max(0, h - Math.floor(size / 3));
    end = Math.min(text.length, start + size);
    out.push(`…${text.slice(start, end).trim()}…`);
    if (out.length >= max) break;
  }
  return out;
}

/** The clients this person can see (their own session), by id */
async function visibleClients(): Promise<Map<string, string>> {
  const db = await createClient();
  const { data } = await db.from("clients").select("id, name").limit(2000);
  return new Map((data ?? []).map((c) => [c.id as string, c.name as string]));
}

async function clientId(asked: string | null): Promise<{ id: string; name: string } | { error: string } | null> {
  if (!asked) return null;
  try {
    const hit = await sharedClientNamed(await createClient(), asked);
    return { id: hit.id, name: hit.name };
  } catch (e) {
    return { error: e instanceof Error ? e.message : `No client called "${asked}" that you can see.` };
  }
}

const searchLooms: AiTool = {
  name: "search_looms",
  description:
    "Searches the Loom recordings synced into Kaizen OS (account audits, Klaviyo and ad account walkthroughs, client calls, how-to recordings), newest first: by words (audit, Klaviyo, flows, deliverability, a client's name...) and optionally one client. Each result has its id, title, date, client, what it covers and a snippet. Then read_loom for the full transcript or the passages on a topic. Use it for 'what did I say in my audit Looms', 'pull the Looms on Ocean Box'. Recordings aren't tagged with who made them: search by client and topic.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Words to find in the title, summary or transcript" },
      client: { type: "string", description: "Only this client's recordings" },
      kind: { type: "string", enum: ["any", "client", "method"], description: "client: about a client's account; method: how-to and buying method" },
      limit: { type: "integer", description: "Up to 25 (default 10)" },
    },
    additionalProperties: false,
  },
  run: async (_user: Staff, input) => {
    const db = await createClient();
    const c = await clientId(str(input.client));
    if (c && "error" in c) return { ok: false, error: c.error };
    const terms = words(str(input.query) ?? "");
    let q = db.from("loom_videos").select("id, title, url, kind, platform, client_id, summary, transcript, recorded_at, created_at").neq("status", "failed").not("transcript", "is", null);
    if (c) q = q.or(`client_id.eq.${c.id},client_ids.cs.{${c.id}}`);
    if (input.kind === "client") q = q.in("kind", ["client", "both"]);
    if (input.kind === "method") q = q.in("kind", ["method", "both"]);
    for (const w of terms) q = q.or(`title.ilike.%${w}%,summary.ilike.%${w}%,transcript.ilike.%${w}%`);
    const { data, error } = await q.order("recorded_at", { ascending: false, nullsFirst: false }).limit(60);
    if (error) return { ok: false, error: "Couldn't search the Looms right now." };
    const seen = await visibleClients();
    const rows = (data ?? []).filter((r) => !r.client_id || seen.has(r.client_id as string));
    const limit = Math.max(1, Math.min(25, num(input.limit) ?? 10));
    return {
      ok: true,
      found: rows.length,
      looms: rows.slice(0, limit).map((r) => ({
        id: r.id,
        title: titleOf(r.title),
        recorded: String(r.recorded_at ?? r.created_at ?? "").slice(0, 10) || null,
        client: r.client_id ? (seen.get(r.client_id as string) ?? null) : null,
        about: clean(r.summary).slice(0, 400) || null,
        snippet: terms.length ? (passages(String(r.transcript ?? ""), terms, 1, 360)[0] ?? null) : null,
        url: r.url,
      })),
      note: rows.length ? "Read the ones that matter with read_loom (focus: the topic) before answering from them." : "Nothing matched. Try fewer or broader words, or no client.",
    };
  },
};

const readLoom: AiTool = {
  name: "read_loom",
  description: "One Loom recording from search_looms: what it covers and its transcript (with focus: only the passages about those words, so a long recording stays short). Quote what was said plainly and say which recording it came from.",
  input_schema: {
    type: "object",
    properties: { id: { type: "string", description: "The recording's id from search_looms" }, focus: { type: "string", description: "Words to pull the passages about (optional)" } },
    required: ["id"],
    additionalProperties: false,
  },
  run: async (_user: Staff, input) => {
    const id = str(input.id) ?? "";
    if (!/^[0-9a-f-]{36}$/i.test(id)) return { ok: false, error: "Use a recording's id from search_looms." };
    const db = await createClient();
    const { data: r } = await db.from("loom_videos").select("id, title, url, client_id, summary, transcript, recorded_at, created_at").eq("id", id).maybeSingle();
    if (!r) return { ok: false, error: "That recording isn't there." };
    const seen = await visibleClients();
    if (r.client_id && !seen.has(r.client_id as string)) return { ok: false, error: "That recording is about a client you can't see." };
    const text = String(r.transcript ?? "");
    const terms = words(str(input.focus) ?? "");
    const parts = terms.length ? passages(text, terms) : [];
    return {
      ok: true,
      title: titleOf(r.title),
      recorded: String(r.recorded_at ?? r.created_at ?? "").slice(0, 10) || null,
      client: r.client_id ? (seen.get(r.client_id as string) ?? null) : null,
      about: clean(r.summary).slice(0, 1200) || null,
      url: r.url,
      ...(parts.length ? { passages: parts } : { transcript: text.slice(0, 24_000), cut: text.length > 24_000 ? "Only the first part: ask with focus for a topic further in." : undefined }),
    };
  },
};

const clientPackageTool: AiTool = {
  name: "client_package",
  description: "A client's package: the tier it's on for each service it buys (for example basic, silver or gold) and what that tier includes (campaigns a month, flows, deliverables). Use it to plan volume and scope (how many campaigns after the first three months) instead of guessing; also in get_client_context. all: true lists every tier Kaizen offers.",
  input_schema: { type: "object", properties: { client: { type: "string" }, all: { type: "boolean" } }, additionalProperties: false },
  run: async (_user: Staff, input) => {
    const admin = createAdminClient();
    if (input.all === true) {
      const { data } = await admin.from("service_tiers").select("service, label, includes").order("service").order("sort_order");
      return { ok: true, tiers: (data ?? []).map((t) => ({ service: t.service, tier: t.label, includes: t.includes })), note: data?.length ? undefined : "No package tiers are set up in Kaizen OS yet (they're added on a client's page)." };
    }
    const c = await clientId(str(input.client));
    if (!c) return { ok: false, error: "Which client?" };
    if ("error" in c) return { ok: false, error: c.error };
    const lines = await clientPackage(admin, c.id);
    return { ok: true, client: c.name, package: lines, text: packageBlock(lines) };
  },
};

export const tools: AiTool[] = [searchLooms, readLoom, clientPackageTool];
