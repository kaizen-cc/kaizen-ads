import { aiEnabled } from "@/lib/ai";
import { toAllotment, type Allotment, type UsageRow } from "@/lib/allotment";
import { isExecOrLead, requireStaff } from "@/lib/auth";
import { can } from "@/lib/chat-permissions";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { briefCardDraft, type Draft, type Size } from "./draft";
import { stampAi } from "@/lib/brief-fingerprint";
import type { CreativeFormat } from "@/lib/creative-formats";
import { createClient } from "@/lib/supabase/server";
import { RequestForm } from "./request-form";
import { LIVE } from "@/lib/live";
import { orderSeats, type SeatRow } from "@/lib/buyer-seats";
import { startSections } from "@/lib/request-start";
import { formatsFor } from "@/lib/creative-formats";
import type { PreviewItem } from "./start-flow";

// The AI review can take a little while
// The strategist writes a whole brief and then reviews it (about two minutes on a slow day)
export const maxDuration = 300;

export default async function NewRequest({ searchParams }: PageProps<"/requests/new">) {
  const me = await requireStaff();
  // Briefs are for the creative team, the media buyers and the executives: anyone else gets a calm line, not a form
  const briefing = can(me, "brief");
  if (!briefing.ok)
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <h1 className="text-[20px] font-semibold text-fg">New creative request</h1>
        <p className="mt-3 text-[14px] leading-relaxed text-fg/60">{briefing.reason}</p>
      </div>
    );
  const { client, from, brief, asana, ai, card, audit, business, idea, draft, copyline } = await searchParams;
  const supabase = await createClient();
  const [{ data: rows }, { data: usage }, { data: angles }, { data: assignments }] = await Promise.all([
    supabase.from("clients").select("id, name, slug, status, creative_package").is("archived_at", null).in("status", LIVE).order("name"),
    supabase.from("client_allotment_usage").select("*"),
    supabase.from("angles").select("client_id, name").eq("status", "active").order("name"),
    supabase.from("client_assignments").select("client_id, role, profile_id, is_primary, created_at, profiles(full_name)"),
  ]);

  // Clients whose package is live (a sprint counts until its end date) can be picked.
  // Other current clients show greyed out, as an upsell prompt.
  const allotments: Record<string, Allotment> = {};
  for (const u of (usage ?? []) as UsageRow[]) allotments[u.client_id] = toAllotment(u);
  const clients = (rows ?? [])
    .filter((c) => c.creative_package || c.status === "active" || c.status === "onboarding")
    .map((c) => ({ id: c.id, name: c.name, slug: c.slug, creative: c.id in allotments }));

  const anglesByClient: Record<string, string[]> = {};
  for (const a of angles ?? []) (anglesByClient[a.client_id] ??= []).push(a.name);
  const teamByClient: Record<string, Record<string, string>> = {};
  // Each seat's primary (secondaries first, so the primary's name is the one kept)
  for (const a of orderSeats((assignments ?? []) as unknown as (SeatRow & { client_id: string; profiles: unknown })[]).reverse()) {
    (teamByClient[a.client_id] ??= {})[a.role] = (a.profiles as { full_name: string } | null)?.full_name ?? "";
  }

  // Starting again from a deleted ticket (Settings › Deleted): its brief, ready to send as is or to edit
  // A brief written in the background (the toast or the bell: "Your brief is ready"): it opens in Ready to send
  const allowed = formatsFor(me);
  const written = typeof draft === "string" ? await fromWritten(supabase, draft, allowed) : null;
  const restart =
    written ??
    (typeof from === "string" && isExecOrLead(me)
      ? await fromDeleted(from)
      : typeof asana === "string"
        ? await fromAsana(asana, me)
        : typeof ai === "string"
          ? await fromKaizenAi(supabase, ai, Number(card) || 0, allowed)
          : typeof copyline === "string"
            ? await fromCopyLine(supabase, copyline)
            : null);
  // An audit's creative idea: its quick preview opens first, over the client's start page
  const auditIdea = !restart && (typeof audit === "string" || typeof business === "string") ? await fromAuditIdea(supabase, typeof business === "string" ? "business" : "account", (typeof business === "string" ? business : audit) as string, Number(idea) || 0) : null;
  const initialClient = restart?.draft.clientId ?? auditIdea?.clientId ?? (typeof client === "string" ? (clients.find((c) => c.slug === client && c.creative)?.id ?? null) : null);
  // Arriving with ?client=: its start page is read here, so it's on screen with the page (stored data only, no AI)
  const initialStart = initialClient && !restart ? await startSections(supabase, initialClient, formatsFor(me), me.id).catch(() => null) : null;

  return (
    <div className="mx-auto max-w-6xl">
      <RequestForm
        key={written ? `draft-${draft}` : "new"}
        initialDraft={restart?.draft ?? null}
        startAtReview={Boolean(restart) && (brief === "same" || Boolean(written))}
        initialPromise={written?.promise ?? null}
        clients={clients}
        allotments={allotments}
        anglesByClient={anglesByClient}
        teamByClient={teamByClient}
        aiOn={aiEnabled()}
        initialClient={initialClient}
        initialStart={initialStart}
        initialPreview={auditIdea?.item ?? null}
      />
    </div>
  );
}

/** A brief written in the background from a quick preview (read through the person's own session), as the draft */
async function fromWritten(db: Awaited<ReturnType<typeof createClient>>, id: string, allowed: ReadonlySet<CreativeFormat>): Promise<{ draft: Partial<Draft> & { clientId: string }; promise: { id: string; clientId: string } | null } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { data: s } = await db.from("creative_suggestions").select("client_id, call_commitment_id").eq("id", id).maybeSingle();
  if (!s) return null;
  // Only a written brief: a summary nobody has picked yet is never sent as it is
  const { suggestionPatch } = await import("./actions");
  const r = await suggestionPatch(id, null, false, false);
  if (!r.ok) return null;
  const clientId = s.client_id as string;
  // Written entirely by the strategist: sent unchanged, it skips the AI review (src/lib/brief-fingerprint.ts)
  const fields: Partial<Draft> = { sizes: ["4x5", "9x16"], ...r.patch };
  return {
    draft: { ...fields, priority: "normal", clientId, ai: stampAi(fields, { kind: "suggestion", id }, allowed) },
    promise: s.call_commitment_id ? { id: s.call_commitment_id as string, clientId } : null,
  };
}

/** A brief written in Kaizen AI (a card on one of the person's messages, read through their own session) as the draft */
async function fromKaizenAi(db: Awaited<ReturnType<typeof createClient>>, messageId: string, index: number, allowed: ReadonlySet<CreativeFormat>): Promise<{ draft: Partial<Draft> & { clientId: string } } | null> {
  if (!/^[0-9a-f-]{36}$/.test(messageId)) return null;
  const { data } = await db.from("ai_messages").select("cards").eq("id", messageId).maybeSingle();
  const b = ((data?.cards ?? []) as import("@/lib/kaizen-ai/types").Card[])[index];
  if (!b || b.type !== "brief") return null;
  const fields = briefCardDraft(b);
  return {
    draft: {
      ...fields,
      clientId: b.client.id,
      priority: "normal",
      origin: { kind: "brief", label: `Briefed in Kaizen AI: ${b.title}`.slice(0, 200) },
      // Written entirely by Kaizen AI: sent unchanged, it skips the AI review
      ai: stampAi(fields, { kind: "kaizen-ai", messageId, card: index }, allowed),
    },
  };
}

/** A proven line from the Copy library ("Use in a request"): the request starts on its angle with the line in the brief */
async function fromCopyLine(db: Awaited<ReturnType<typeof createClient>>, ref: string): Promise<{ draft: Partial<Draft> & { clientId: string } } | null> {
  const [clientId, key] = ref.split(".");
  if (!/^[0-9a-f-]{36}$/.test(clientId ?? "") || !key) return null;
  const { findCopyLine } = await import("@/lib/copy-library");
  const { KIND_LABEL, BADGE_LABEL } = await import("@/lib/copy-library-core");
  const l = await findCopyLine(db, clientId, key).catch(() => null);
  if (!l) return null;
  const kpi = l.roasKpi ? `${l.roas ?? 0}x ROAS` : l.cpa == null ? "no results yet" : `$${l.cpa} per result`;
  const label = `Built on proven copy: "${l.text.replace(/\s+/g, " ").slice(0, 80)}${l.text.length > 80 ? "…" : ""}"`;
  return {
    draft: {
      clientId,
      priority: "normal",
      angle: l.angle ?? "",
      ...(l.avatar ? { avatar: l.avatar } : {}),
      brief: [
        `Copy to build on (${BADGE_LABEL[l.badge]} in the Copy library: ${kpi}, $${Math.round(l.spend)} spent, CTR ${l.ctr ?? "?"}%, ${l.ads} ${l.ads === 1 ? "ad" : "ads"} over ${l.days} days).`,
        `${KIND_LABEL[l.kind]}:`,
        `"${l.text}"`,
        "Keep this line in the copy set (as it is, or a close variation), and make the creative carry the same promise.",
      ].join("\n"),
      origin: { kind: "brief", label: label.slice(0, 200) },
    },
  };
}

/** A creative idea from an account audit or a business audit (read through the person's own session), to preview */
async function fromAuditIdea(db: Awaited<ReturnType<typeof createClient>>, kind: "account" | "business", id: string, index: number): Promise<{ clientId: string; item: PreviewItem } | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const { data } = await db.from(kind === "business" ? "business_audits" : "account_audits").select("client_id, result").eq("id", id).maybeSingle();
  const c = ((data?.result as { creative?: { concept: string; angle: string; hook: string; format: string; why: string }[] } | null)?.creative ?? [])[index];
  if (!data || !c) return null;
  const label = `From the ${kind === "business" ? "business" : "account"} audit: ${c.concept}`.slice(0, 200);
  return {
    clientId: data.client_id as string,
    item: {
      key: `audit-${id.slice(0, 8)}-${index}`,
      source: { kind: "idea", label, text: [`Concept: ${c.concept}`, `Angle: ${c.angle}`, `Hook: "${c.hook}"`, `Format: ${c.format}`, `Why: ${c.why}`].join("\n") },
      from: { kicker: `${kind === "business" ? "Business" : "Account"} audit idea`, label: c.concept },
      progressLabel: "brief from an idea+brief self-review",
      origin: { kind: "brief", label },
    },
  };
}

/** A deleted ticket as a new request's draft. */
async function fromDeleted(id: string): Promise<{ draft: Partial<Draft> & { clientId: string } } | null> {
  if (!adminConfigured()) return null;
  const { data: r } = await createAdminClient()
    .from("requests")
    .select("number, client_id, title, format, new_count, variation_count, sizes, audience, brief, refs, landing_url, priority, origin, deleted_at, angles(name)")
    .eq("id", id)
    .maybeSingle();
  if (!r?.deleted_at) return null;
  const refs = r.refs as unknown;
  return {
    draft: {
      clientId: r.client_id,
      title: r.title,
      formats: { [r.format]: { new: r.new_count, variations: r.variation_count } },
      sizes: ((r.sizes ?? []) as Size[]).length ? (r.sizes as Size[]) : ["4x5", "9x16"],
      angle: (r.angles as unknown as { name: string } | null)?.name ?? "",
      audience: r.audience ?? "",
      priority: r.priority ?? "normal",
      brief: r.brief ?? "",
      refs: Array.isArray(refs) ? refs.join("\n") : typeof refs === "string" ? refs : "",
      landing: r.landing_url ?? "",
      origin: { kind: "brief", label: `Started again from deleted ticket #${r.number}${(r.origin as { label?: string } | null)?.label ? `, built on ${(r.origin as { label: string }).label}` : ""}`.slice(0, 200) },
    },
  };
}

/** An Asana task as a new ticket's draft, read by the AI from the form answers in it, landing in the stage it reached. */
async function fromAsana(gid: string, me: Awaited<ReturnType<typeof requireStaff>>): Promise<{ draft: Partial<Draft> & { clientId: string } } | null> {
  if (!adminConfigured()) return null;
  const admin = createAdminClient();
  const { data: t } = await admin.from("asana_tasks").select("*").eq("gid", gid).maybeSingle();
  if (!t || t.request_id || !t.stage) return null;
  if (!isExecOrLead(me) && t.profile_id !== me.id) return null;
  const { STAGES } = await import("@/lib/stages");
  const order = STAGES.map((x) => x.key as string);
  const at = order.indexOf(t.stage);
  const { askJson, aiEnabled } = await import("@/lib/ai");
  type Read = { title: string; formats: { format: "image" | "video" | "carousel"; new: number; variations: number }[]; sizes: Size[]; angle: string; audience: string; brief: string; refs: string[]; landing: string };
  let read: Read | null = null;
  if (aiEnabled())
    read = await askJson<Read>({
      agent: "suggest",
      label: "asana migration",
      clientId: (t.client_id as string | null) ?? null,
      system:
        "You turn an Asana creative request (made from Kaizen's Google Form: client, platform, format, iteration or new, audience, angle, the request, a Drive link for iterations, what to change) into the fields of a Kaizen Ads request. Use only what's in it; leave a field empty if it isn't there. formats: one entry per format asked for, with 1 net new unless it says otherwise (an iteration is 0 new and 1 variation). sizes from 4x5, 9x16 (both if unsaid; Kaizen no longer makes 1x1, so a 1x1 asked for becomes 4x5). brief: the request in full, tidied but not shortened, including what to change for an iteration. refs: every link in it. title: short and specific.",
      schema: {
        type: "object",
        properties: {
          title: { type: "string" },
          formats: { type: "array", items: { type: "object", properties: { format: { type: "string", enum: ["image", "video", "carousel"] }, new: { type: "integer" }, variations: { type: "integer" } }, required: ["format", "new", "variations"], additionalProperties: false } },
          sizes: { type: "array", items: { type: "string", enum: ["4x5", "9x16"] } },
          angle: { type: "string" },
          audience: { type: "string" },
          brief: { type: "string" },
          refs: { type: "array", items: { type: "string" } },
          landing: { type: "string" },
        },
        required: ["title", "formats", "sizes", "angle", "audience", "brief", "refs", "landing"],
        additionalProperties: false,
      },
      prompt: `Task: ${t.name}\nAsana fields: ${JSON.stringify(t.fields)}\n\n${t.notes ?? "(no description)"}`,
    }).catch(() => null);
  const fmt = (t.format as "image" | "video" | "carousel" | null) ?? "image";
  return {
    draft: {
      clientId: t.client_id,
      title: read?.title || t.name,
      formats: Object.fromEntries((read?.formats?.length ? read.formats : [{ format: fmt, new: 1, variations: 0 }]).map((f) => [f.format, { new: Math.max(0, f.new), variations: Math.max(0, f.variations) }])),
      sizes: read?.sizes?.length ? read.sizes : ["4x5", "9x16"],
      angle: read?.angle ?? "",
      audience: read?.audience ?? "",
      brief: read?.brief || t.notes || "",
      refs: (read?.refs ?? []).join("\n"),
      landing: read?.landing ?? "",
      priority: /urgent/i.test(t.priority ?? t.name) ? "urgent" : /high/i.test(t.priority ?? "") ? "high" : "normal",
      origin: { kind: "brief", label: `Migrated from Asana: ${t.name}`.slice(0, 200), link: t.url },
      migration: {
        gid: t.gid,
        name: t.name,
        url: t.url,
        stage: t.stage,
        stageLabel: STAGES.find((x) => x.key === t.stage)?.label ?? t.stage,
        needsCreative: at > order.indexOf("in_production"),
        needsCopy: at > order.indexOf("copy"),
        assigneeId: t.profile_id,
        creativeLink: "",
        copy: "",
      },
    },
  };
}
