import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson, clientContext, contextBlock } from "@/lib/ai";
import { assetsBlock, loadAssets } from "@/lib/client-assets";

// The shot list for a client's next billing cycle: the photos and clips to ask them for so the creative we plan can
// be made, from what's planned and winning, minus what's already on Drive. Each shot carries a reference or two from
// what's working in their market (Motion), and asks again for a new angle of a subject whose ads flopped. For clients
// on a creative package it's written on its own a week before each cycle, shows in their portal (with an upload per
// shot) and in the monthly recap, and each shot is marked delivered as their files come in, so nothing is asked twice.

export type ShotRef = { url: string; thumb: string | null; brand: string; days: number | null; video: boolean };
export type Shot = {
  id: string;
  what: string;
  format: "photo" | "video";
  specs: string;
  why: string;
  subject: string; // the thing in it ("colossal shrimp", "the owner", "a finished roof"), to match files and flops
  again?: string | null; // asked again from a new angle: what flopped last time
  refs?: ShotRef[];
  delivered?: { at: string; files: string[]; by: string } | null;
};
export type ShotList = {
  month: string; // "November 2026"
  intro: string; // the opening lines of the message to the client
  shots: Shot[];
  have: string[]; // what we already have and will use, so we don't ask for it
  closing: string;
};

const S = { type: "string" };
const SCHEMA = {
  type: "object",
  properties: {
    intro: S,
    shots: {
      type: "array",
      items: {
        type: "object",
        properties: { what: S, format: { type: "string", enum: ["photo", "video"] }, specs: S, why: S, subject: S, again: S, refs: { type: "array", items: { type: "integer" } } },
        required: ["what", "format", "specs", "why", "subject", "again", "refs"],
        additionalProperties: false,
      },
    },
    have: { type: "array", items: S },
    closing: S,
  },
  required: ["intro", "shots", "have", "closing"],
  additionalProperties: false,
};

const SYSTEM = `You write a client's monthly shot list for Kaizen Marketing, a paid social agency: the photos and short clips to ask the client for so next month's ads can be made. You get everything known about the client (offers, what's winning, the strategy, upcoming events and promotions, open work), their kind of business, what's already on their Drive, what they were asked for before, and ads from their market that are working.
Ask only for what we don't have and will actually use: the angles, offers and marketing moments coming up, fresh versions of what's winning (ads wear out, so new footage of the same thing counts), and anything their briefs keep needing. Skip what Drive already covers well and recently, and never ask again for a shot they already sent (list those in have, a few words each).
Fit the kind of business: a restaurant films dishes, the room, the kitchen and guests; a home service films the crew, before and after, the finished job and the owner; a store films the product in hand, unboxing, in use and customers; a clinic or studio films the space, the team and the experience (never anything that shows a patient without consent).
A shot whose ads flopped: if a subject was shot and the ads made from it lost (the playbook says so), ask for it again from a new angle, setting, light or moment, and say what's different in again ("last time: on the counter; now: on the grill, outdoors"). Otherwise again is "".
6 to 12 shots. Each: what (specific and filmable by someone with a phone: who, what, where, e.g. "Owner pulling a fresh pizza from the oven, close up, steam visible"), format (photo or video), specs (orientation and length, e.g. "vertical 9:16, 5–10s"; photos "vertical 4:5, natural light"), why (a few words for the client on what it's for, e.g. "for the Black Friday bundle ads"), subject (2 to 4 words: the thing in it), refs (the numbers of 1 or 2 market ads below that show the look or idea, only when one truly fits; [] otherwise).
intro: 2 sentences to the client, warm and plain, in Kaizen's voice: what this is and why it helps their ads. closing: one line on how to send it (upload each shot right on the list, or their shared Drive folder) and by when (the first week of the cycle). No emojis, no jargon, no internal details (no allotments, KPIs, team names), never another brand's name.`;

const monthName = (d: Date) => d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const shotId = () => crypto.randomUUID().slice(0, 8);

export async function writeShotList(admin: SupabaseClient, clientId: string, by: string, opts: { cycleStart?: string; auto?: boolean } = {}) {
  const [ctx, assets, { businessModelOf, modelBlock }, { swipeFile }, { playbookBlock }, { data: before }] = await Promise.all([
    clientContext(admin, clientId),
    loadAssets(admin, clientId),
    import("@/lib/business-model"),
    import("@/lib/market"),
    import("@/lib/ledger"),
    admin.from("shot_lists").select("list, created_at").eq("client_id", clientId).order("created_at", { ascending: false }).limit(3),
  ]);
  if (!ctx) throw new Error("Client not found");
  const [model, refs, playbook] = await Promise.all([businessModelOf(admin, clientId).catch(() => null), swipeFile(admin, clientId, 12).catch(() => []), playbookBlock(admin, clientId).catch(() => "")]);
  const now = new Date();
  // The cycle it's for: the next billing period (a list a week ahead), or the 1st of next month by hand
  const start = opts.cycleStart ? new Date(`${opts.cycleStart}T12:00:00Z`) : new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 1, 12));
  const asked = (before ?? []).flatMap((b) => ((b.list as ShotList).shots ?? []).map((s) => `- ${s.what} (${s.subject ?? "?"})${s.delivered ? " · SENT" : " · not sent"}`));
  const candidates = refs.map((a, i) => `R${i + 1}. ${a.brand}${a.detail ? ` (${a.detail})` : ""} · ${a.format ?? "ad"}${a.daysActive != null ? ` · live ${a.daysActive} days` : ""}${a.angle ? ` · ${a.angle}` : ""}${a.hook ? ` · hook: ${a.hook}` : ""}`);
  const out = await askJson<{ intro: string; shots: (Omit<Shot, "id" | "refs" | "delivered"> & { refs: number[] })[]; have: string[]; closing: string }>({
    agent: "strategist",
    label: "monthly shot list",
    system: SYSTEM,
    schema: SCHEMA,
    maxTokens: 7000,
    prompt: [
      contextBlock(ctx),
      model ? modelBlock(model) : "",
      assetsBlock(assets),
      playbook,
      asked.length ? `<asked_before>\nWhat they were asked for in the last lists (SENT = they sent it):\n${asked.slice(0, 40).join("\n")}\n</asked_before>` : "",
      candidates.length ? `<market_references>\nUS ads working in their market (refs points to these by number, without the R):\n${candidates.join("\n")}\n</market_references>` : "",
      `Write the shot list for ${monthName(start)}.`,
    ]
      .filter(Boolean)
      .join("\n\n"),
  });
  const list: ShotList = {
    month: monthName(start),
    intro: out.intro,
    have: out.have,
    closing: out.closing,
    shots: out.shots.slice(0, 14).map((s) => ({
      id: shotId(),
      what: s.what,
      format: s.format,
      specs: s.specs,
      why: s.why,
      subject: s.subject,
      again: s.again?.trim() || null,
      refs: [...new Set(s.refs)]
        .map((n) => refs[n - 1])
        .filter(Boolean)
        .slice(0, 2)
        .map((a) => ({ url: a.motionUrl ?? a.libraryUrl ?? a.media[0]?.url ?? "", thumb: a.media[0]?.thumb ?? (a.media[0]?.type === "image" ? a.media[0].url : null), brand: a.brand, days: a.daysActive, video: a.media[0]?.type === "video" }))
        .filter((r) => r.url),
      delivered: null,
    })),
  };
  const row = { client_id: clientId, month: start.toISOString().slice(0, 10), list, created_by: by, auto: Boolean(opts.auto), cycle_start: opts.cycleStart ?? null };
  const { data, error } = await admin.from("shot_lists").insert(row).select("id, created_at").single();
  if (error) throw new Error(error.message);
  return { id: data?.id as string, list, createdAt: data?.created_at as string };
}

/** The list a client is working from now: their latest, from the last two months */
export async function currentShotList(db: SupabaseClient, clientId: string) {
  const { data } = await db.from("shot_lists").select("id, list, month, created_at, sent_at, auto").eq("client_id", clientId).gte("created_at", new Date(Date.now() - 62 * 86_400_000).toISOString()).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!data) return null;
  const list = data.list as ShotList;
  // Lists written before shots had ids get them now (stable by position)
  list.shots = (list.shots ?? []).map((s, i) => ({ ...s, id: s.id ?? `s${i}`, subject: s.subject ?? s.what }));
  return { id: data.id as string, list, month: data.month as string, createdAt: data.created_at as string, sentAt: (data.sent_at as string | null) ?? null, auto: Boolean(data.auto) };
}

/** Shots marked delivered (from an upload on the list, or a Drive file the matcher placed) */
export async function markDelivered(admin: SupabaseClient, listId: string, done: { shotId: string; files: string[] }[], by: string) {
  const { data } = await admin.from("shot_lists").select("list").eq("id", listId).maybeSingle();
  if (!data) return 0;
  const list = data.list as ShotList;
  const at = new Date().toISOString();
  let n = 0;
  list.shots = (list.shots ?? []).map((s, i) => {
    const id = s.id ?? `s${i}`;
    const d = done.find((x) => x.shotId === id);
    if (!d || !d.files.length) return { ...s, id };
    n++;
    return { ...s, id, delivered: { at, by, files: [...new Set([...(s.delivered?.files ?? []), ...d.files])].slice(0, 12) } };
  });
  if (n) await admin.from("shot_lists").update({ list }).eq("id", listId);
  return n;
}

/**
 * For clients on a creative package: a week before each billing cycle starts, the list for that cycle is written on
 * its own (one client a run). It shows in their portal straight away (contacts only see a live portal); the monthly
 * recap carries it. Nothing is emailed on its own here.
 */
export async function keepShotLists(admin: SupabaseClient) {
  const { LIVE } = await import("@/lib/live");
  const [{ data: clients }, { data: usage }] = await Promise.all([
    admin.from("clients").select("id, name").eq("creative_package", true).is("archived_at", null).in("status", LIVE),
    admin.from("client_allotment_usage").select("client_id, period_end"),
  ]);
  const end = new Map((usage ?? []).map((u) => [u.client_id as string, u.period_end as string]));
  const soon = Date.now() + 7 * 86_400_000;
  const due = (clients ?? []).filter((c) => end.get(c.id as string) && Date.parse(`${end.get(c.id as string)}T12:00:00Z`) <= soon);
  if (!due.length) return {};
  const { data: have } = await admin.from("shot_lists").select("client_id, cycle_start").eq("auto", true).in("client_id", due.map((c) => c.id as string));
  const done = new Set((have ?? []).map((h) => `${h.client_id}:${h.cycle_start}`));
  for (const c of due) {
    const cycle = end.get(c.id as string)!;
    if (done.has(`${c.id}:${cycle}`)) continue;
    const r = await writeShotList(admin, c.id as string, "Kaizen Ads (each billing cycle)", { cycleStart: cycle, auto: true }).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
    return { [c.name as string]: "error" in r ? r.error : `${r.list.shots.length} shots for ${r.list.month}` };
  }
  return {};
}

const MATCH_SCHEMA = {
  type: "object",
  properties: { matches: { type: "array", items: { type: "object", properties: { file: { type: "integer" }, shot: { type: "string" } }, required: ["file", "shot"], additionalProperties: false } } },
  required: ["matches"],
  additionalProperties: false,
};

/**
 * Files that came in since a client's open list was last checked (their Drive folder and portal uploads), matched to
 * the shots still open by name, folder and type: each match marks the shot delivered, so it's never asked twice.
 * Hourly, a few clients a run.
 */
export async function matchShotUploads(admin: SupabaseClient, max = 6) {
  const since = new Date(Date.now() - 62 * 86_400_000).toISOString();
  const { data: lists } = await admin.from("shot_lists").select("id, client_id, list, created_at, checked_at").gte("created_at", since).order("checked_at", { ascending: true, nullsFirst: true }).limit(60);
  // The latest list per client only
  const latest = new Map<string, NonNullable<typeof lists>[number]>();
  for (const l of lists ?? []) if (!latest.has(l.client_id as string) || (latest.get(l.client_id as string)!.created_at as string) < (l.created_at as string)) latest.set(l.client_id as string, l);
  const out: Record<string, number> = {};
  let runs = 0;
  for (const l of latest.values()) {
    if (runs >= max) break;
    const list = l.list as ShotList;
    const open = (list.shots ?? []).map((s, i) => ({ ...s, id: s.id ?? `s${i}` })).filter((s) => !s.delivered);
    const from = (l.checked_at as string | null) ?? (l.created_at as string);
    const now = new Date().toISOString();
    if (!open.length) {
      await admin.from("shot_lists").update({ checked_at: now }).eq("id", l.id);
      continue;
    }
    const [{ data: drive }, { data: docs }] = await Promise.all([
      admin.from("client_assets").select("name, kind, folder, created_at").eq("client_id", l.client_id).in("kind", ["image", "video"]).gte("created_at", from).limit(80),
      admin.from("client_documents").select("name, mime, created_at").eq("client_id", l.client_id).eq("kind", "file").gte("created_at", from).limit(80),
    ]);
    const files = [
      ...(drive ?? []).map((d) => ({ name: d.name as string, line: `${d.name} (${d.kind}${d.folder ? `, folder ${d.folder}` : ""})` })),
      ...(docs ?? []).filter((d) => /^(image|video)\//.test((d.mime as string | null) ?? "")).map((d) => ({ name: d.name as string, line: `${d.name} (${d.mime}, uploaded in their portal)` })),
    ];
    await admin.from("shot_lists").update({ checked_at: now }).eq("id", l.id);
    if (!files.length) continue;
    runs++;
    const r = await askJson<{ matches: { file: number; shot: string }[] }>({
      agent: "strategist",
      label: "shot list delivered",
      system: "You match files a client sent to the shots on their shot list, from each file's name, folder and type. Match only when the file clearly is that shot (the subject and the format fit); a vague name like IMG_2041.jpg matches only if its folder names the subject. Several files can match one shot; a file matches at most one shot. Return only real matches.",
      schema: MATCH_SCHEMA,
      override: { model: "haiku", effort: "low" },
      prompt: `<open_shots>\n${open.map((s) => `${s.id}: ${s.format}, ${s.subject}: ${s.what}`).join("\n")}\n</open_shots>\n\n<files>\n${files.map((f, i) => `${i + 1}. ${f.line}`).join("\n")}\n</files>`,
    }).catch(() => ({ matches: [] }));
    const by = new Map<string, string[]>();
    for (const m of r.matches) {
      const f = files[m.file - 1];
      if (f && open.some((s) => s.id === m.shot)) by.set(m.shot, [...(by.get(m.shot) ?? []), f.name]);
    }
    if (by.size) out[l.client_id as string] = await markDelivered(admin, l.id as string, [...by].map(([shotId, f]) => ({ shotId, files: f })), "Matched from their files");
  }
  return out;
}

/** The list as lines for a recap or a brief: what's still needed, and what came in */
export function shotLines(list: ShotList) {
  const open = list.shots.filter((s) => !s.delivered);
  return { open, delivered: list.shots.length - open.length, total: list.shots.length };
}
