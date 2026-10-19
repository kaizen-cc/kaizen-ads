import { aiEnabled } from "@/lib/ai";
import { toAllotment, type Allotment, type UsageRow } from "@/lib/allotment";
import { isExecOrLead, requireStaff } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import type { Draft, Size } from "./draft";
import { createClient } from "@/lib/supabase/server";
import { RequestForm } from "./request-form";
import { LIVE } from "@/lib/live";

// The AI review can take a little while
export const maxDuration = 60;

export default async function NewRequest({ searchParams }: PageProps<"/requests/new">) {
  const me = await requireStaff();
  const { client, from, brief, asana } = await searchParams;
  const supabase = await createClient();
  const [{ data: rows }, { data: usage }, { data: angles }, { data: assignments }] = await Promise.all([
    supabase.from("clients").select("id, name, slug, status, creative_package").is("archived_at", null).in("status", LIVE).order("name"),
    supabase.from("client_allotment_usage").select("*"),
    supabase.from("angles").select("client_id, name").eq("status", "active").order("name"),
    supabase.from("client_assignments").select("client_id, role, profiles(full_name)"),
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
  for (const a of assignments ?? []) {
    (teamByClient[a.client_id] ??= {})[a.role] = (a.profiles as unknown as { full_name: string } | null)?.full_name ?? "";
  }

  // Starting again from a deleted ticket (Settings › Deleted): its brief, ready to send as is or to edit
  const restart = typeof from === "string" && isExecOrLead(me) ? await fromDeleted(from) : typeof asana === "string" ? await fromAsana(asana, me) : null;

  return (
    <div className="mx-auto max-w-5xl">
      <RequestForm
        initialDraft={restart?.draft ?? null}
        startAtReview={Boolean(restart) && brief === "same"}
        clients={clients}
        allotments={allotments}
        anglesByClient={anglesByClient}
        teamByClient={teamByClient}
        aiOn={aiEnabled()}
        initialClient={restart?.draft.clientId ?? (typeof client === "string" ? (clients.find((c) => c.slug === client && c.creative)?.id ?? null) : null)}
      />
    </div>
  );
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
      system:
        "You turn an Asana creative request (made from Kaizen's Google Form: client, platform, format, iteration or new, audience, angle, the request, a Drive link for iterations, what to change) into the fields of a Kaizen Ads request. Use only what's in it; leave a field empty if it isn't there. formats: one entry per format asked for, with 1 net new unless it says otherwise (an iteration is 0 new and 1 variation). sizes from 1x1, 4x5, 9x16 (4x5 and 9x16 if unsaid). brief: the request in full, tidied but not shortened, including what to change for an iteration. refs: every link in it. title: short and specific.",
      schema: {
        type: "object",
        properties: {
          title: { type: "string" },
          formats: { type: "array", items: { type: "object", properties: { format: { type: "string", enum: ["image", "video", "carousel"] }, new: { type: "integer" }, variations: { type: "integer" } }, required: ["format", "new", "variations"], additionalProperties: false } },
          sizes: { type: "array", items: { type: "string", enum: ["1x1", "4x5", "9x16"] } },
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
