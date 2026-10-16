import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AiUnavailable,
  askJson,
  CLIENT_LESSONS_SYSTEM,
  CLIENT_SUMMARY_SCHEMA,
  CLIENT_SUMMARY_SYSTEM,
  type ClientSummary,
  clientContext,
  COPY_AMEND_SCHEMA,
  COPY_AMEND_SYSTEM,
  COPY_LESSONS_SCHEMA,
  REVISION_SUMMARY_SCHEMA,
  REVISION_SUMMARY_SYSTEM,
  type CopyAmend,
  type CopyLesson,
  type CreativeNotes,
} from "@/lib/ai";
import { CTA_BUTTONS, type Ad } from "@/lib/copy";

// The client revision loop. A client's copy notes go to the AI, which amends the set (or rewrites it only when they
// reject it), then to copy review. Their notes also teach the AI about the client. When the ad goes back to them, it's
// tagged revised with what they asked and what we changed.

const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms / 1000) % 60)).padStart(2, "0")}`;

/** The client's copy notes, applied to the approved set. Moves Copy → Copy review (assigning the copywriter) when done. */
export async function amendCopy(admin: SupabaseClient, requestId: string, notes: string) {
  const [{ data: r }, { data: set }] = await Promise.all([
    admin.from("board_requests").select("id, number, client_id, title, brief, angle_name, stage").eq("id", requestId).maybeSingle(),
    admin.from("copy_sets").select("ads, version, client_status").eq("request_id", requestId).maybeSingle(),
  ]);
  if (!r || !set) throw new AiUnavailable("No copy to revise.");
  const ads = (set.ads ?? []) as Ad[];
  const status = (set.client_status ?? []) as { status: string | null; note?: string | null }[];
  const locked = new Set(ads.map((_, i) => i).filter((i) => status[i]?.status === "approved"));
  const ctx = await clientContext(admin, r.client_id);

  let shown = -1;
  let last = 0;
  const onText = (soFar: string) => {
    const started = (soFar.match(/"primaryText"/g) ?? []).length;
    if (started === shown || Date.now() - last < 800) return;
    shown = started;
    last = Date.now();
    const label = started === 0 ? "Working out what to change" : `Going through ad ${started} of 5`;
    // A query builder only runs when awaited or then-ed: fire it without holding up the stream
    admin.from("copy_sets").update({ progress: { written: Math.max(0, started - 1), total: 5, label } }).eq("request_id", requestId).then(() => undefined, () => undefined);
  };

  try {
    const out = await askJson<CopyAmend>({
      agent: "copy",
      label: `copy revision #${r.number}`,
      system: COPY_AMEND_SYSTEM,
      schema: COPY_AMEND_SCHEMA,
      onText,
      prompt: `<client>${ctx?.name ?? "the client"}</client>
${ctx?.brandBible ? `<brand_bible>\n${ctx.brandBible.slice(0, 5000)}\n</brand_bible>\n` : ""}<client_memory>
${(ctx?.memory ?? []).map((m) => `- [${m.kind}] ${m.body}`).join("\n") || "(none)"}
</client_memory>

<ticket>#${r.number} · ${r.title} · angle: ${r.angle_name ?? "not set"}</ticket>

<approved_copy>
${ads.map((a, i) => `Ad ${i + 1} [${a.kind} · ${a.formula}]${locked.has(i) ? " · APPROVED BY THE CLIENT: return it exactly as it is" : status[i]?.status === "changes" ? " · the client wants changes" : ""}\nprimaryText: ${a.primaryText}\nheadline: ${a.headline}\nlinkDescription: ${a.linkDescription}\ncta: ${a.cta}`).join("\n\n")}
</approved_copy>

<client_asked>
${notes}
</client_asked>`,
    });
    // Approved ads are locked: whatever the AI returned for them, they stay exactly as approved
    const next =
      out.ads.length === ads.length
        ? out.ads.map((a, i) => (locked.has(i) ? ads[i] : { ...a, cta: CTA_BUTTONS.includes(a.cta as (typeof CTA_BUTTONS)[number]) ? a.cta : "Learn More" }))
        : ads;
    out.changes = out.changes.filter((c) => !locked.has(c.ad - 1));
    const now = new Date().toISOString();
    await admin
      .from("copy_sets")
      .update({ status: "review", ads: next, ai_ads: next, previous_ads: ads, notes: out.notes, changes: out.changes, scope: out.scope, progress: {}, version: (set.version ?? 1) + 1, updated_at: now, approved_at: null, approved_by: null })
      .eq("request_id", requestId);

    // Copy only: on to copy review, now that there's something to review
    if (r.stage === "copy") {
      const { data: writer } = await admin.from("profiles").select("id").eq("role", "copywriter").eq("is_active", true).order("created_at").limit(1).maybeSingle();
      const { data: due } = await admin.rpc("end_of_business_day", { p_ts: now });
      await admin.from("requests").update({ stage: "copy_review", stage_entered_at: now, stage_due_at: due ?? null, assignee_id: writer?.id ?? null }).eq("id", requestId);
      await admin.from("request_events").insert({ request_id: requestId, kind: "copy", from_stage: "copy", to_stage: "copy_review", data: { action: "revised_for_client", scope: out.scope } });
    } else {
      await admin.from("request_events").insert({ request_id: requestId, kind: "copy", data: { action: "revised_for_client", scope: out.scope } });
    }
    return out;
  } catch (e) {
    await admin.from("copy_sets").update({ status: "failed", progress: {}, error: e instanceof AiUnavailable ? e.message : "The copy revision didn't finish." }).eq("request_id", requestId);
    throw e;
  }
}

/** What a client's notes say about how their ads should be made, kept as client memory (source "client"). */
export async function learnFromClient(admin: SupabaseClient, clientId: string, notes: string[], by: string | null) {
  const text = notes.map((n) => n.trim()).filter(Boolean);
  if (!text.length) return [];
  const { data: memory } = await admin.from("client_memory").select("kind, body").eq("client_id", clientId).eq("status", "active").limit(80);
  const out = await askJson<{ lessons: CopyLesson[] }>({
    agent: "review",
    label: "client lessons",
    system: CLIENT_LESSONS_SYSTEM,
    schema: COPY_LESSONS_SCHEMA,
    prompt: `<client_memory>\n${(memory ?? []).map((m) => `- [${m.kind}] ${m.body}`).join("\n") || "(none yet)"}\n</client_memory>\n\n<client_revision_notes>\n${text.map((t) => `- ${t}`).join("\n")}\n</client_revision_notes>`,
  });
  const lessons = out.lessons.filter((l) => l.body.trim()).slice(0, 3);
  if (lessons.length) await admin.from("client_memory").insert(lessons.map((l) => ({ client_id: clientId, kind: l.kind, body: l.body.trim().slice(0, 1000), source: "client", created_by: by })));
  return lessons;
}

/** The client's open asks on a ticket: their pinned notes per design, and the round's overall notes. */
export async function clientAsks(admin: SupabaseClient, requestId: string) {
  const [{ data: round }, { data: pins }] = await Promise.all([
    admin.from("client_rounds").select("id, round, targets, copy_notes, design_note, created_at").eq("request_id", requestId).eq("decision", "revise").is("sent_back_at", null).order("round", { ascending: false }).limit(1).maybeSingle(),
    admin.from("review_comments").select("id, design_id, version, x, y, w, h, t_ms, body").eq("request_id", requestId).eq("round", "client").is("resolved_at", null).order("created_at"),
  ]);
  const pct = (n: unknown) => Math.round(Number(n) * 100);
  const where = (p: { x: number | null; y: number | null; w: number | null; h: number | null; t_ms: number | null }) =>
    p.t_ms != null
      ? `at ${clock(p.t_ms)}`
      : p.x != null && p.y != null && p.w != null && p.h != null
        ? `the boxed area from ${pct(p.x)}% to ${pct(Number(p.x) + Number(p.w))}% across and ${pct(p.y)}% to ${pct(Number(p.y) + Number(p.h))}% down`
        : p.x != null && p.y != null
          ? `pinned ${pct(p.x)}% across, ${pct(p.y)}% down`
          : "";
  return {
    round,
    pins: (pins ?? []).map((p) => ({ id: p.id, designId: p.design_id, text: `${p.body}${where(p) ? ` (${where(p)})` : ""}` })),
  };
}

/**
 * When a revised ad goes back to the client: what they asked and what changed, for the "revised" tag. Also closes the
 * round's comments. Changes come from the maker's version notes, the AI review of the new files and the copy revision.
 */
export async function summarizeRevision(admin: SupabaseClient, requestId: string) {
  const { round, pins } = await clientAsks(admin, requestId);
  if (!round) return null;
  const [{ data: versions }, { data: review }, { data: copy }] = await Promise.all([
    admin.from("design_versions").select("version, note, created_at, designs!inner(request_id, position, name)").eq("designs.request_id", requestId).gt("created_at", round.created_at),
    admin.from("creative_ai_reviews").select("content").eq("request_id", requestId).eq("status", "done").order("started_at", { ascending: false }).limit(1).maybeSingle(),
    admin.from("copy_sets").select("changes, scope").eq("request_id", requestId).maybeSingle(),
  ]);
  const asked = [
    ...pins.map((p) => `Design: ${p.text}`),
    ...(round.design_note ? [`Design overall: ${round.design_note}`] : []),
    ...(round.copy_notes ? [`Copy: ${round.copy_notes}`] : []),
  ];
  const changed = [
    ...(versions ?? []).map((v) => {
      const d = v.designs as unknown as { position: number; name: string };
      return `D${d.position} ${d.name} new version v${v.version}${v.note ? `: ${v.note}` : ""}`;
    }),
    ...((review?.content as CreativeNotes | null)?.notes ?? []).filter((n) => /client/i.test(n.area) || n.severity === "good").map((n) => `AI check (${n.severity}): ${n.note}`),
    ...((copy?.changes as { ad: number; what: string }[] | null) ?? []).map((c) => `Copy: ${c.what}`),
  ];
  let items: { asked: string; changed: string }[] = asked.map((a) => ({ asked: a, changed: "Updated as you asked." }));
  try {
    const out = await askJson<{ items: { asked: string; changed: string }[] }>({
      agent: "review",
      label: "revision summary",
      system: REVISION_SUMMARY_SYSTEM,
      schema: REVISION_SUMMARY_SCHEMA,
      prompt: `<client_asked>\n${asked.join("\n") || "(no notes)"}\n</client_asked>\n\n<what_changed>\n${changed.join("\n") || "(no notes on the changes)"}\n</what_changed>`,
    });
    if (out.items.length) items = out.items;
  } catch {
    // The plain list is still useful
  }
  const now = new Date().toISOString();
  await admin.from("client_rounds").update({ changes: items, sent_back_at: now }).eq("id", round.id);
  if (pins.length) await admin.from("review_comments").update({ resolved_at: now }).in("id", pins.map((p) => p.id));
  return items;
}

/** The client-facing "why we made this" (goal, audience, strategy), written once when the ticket first goes to them. */
export async function writeClientSummary(admin: SupabaseClient, requestId: string, force = false) {
  const { data: r } = await admin.from("board_requests").select("id, number, client_id, title, angle_name, audience, brief, landing_url, client_summary").eq("id", requestId).maybeSingle();
  if (!r || (r.client_summary && !force)) return (r?.client_summary as ClientSummary | null) ?? null;
  const ctx = await clientContext(admin, r.client_id);
  const summary = await askJson<ClientSummary>({
    agent: "review",
    label: `client summary #${r.number}`,
    system: CLIENT_SUMMARY_SYSTEM,
    schema: CLIENT_SUMMARY_SCHEMA,
    prompt: `<client>${ctx?.name ?? "the client"}</client>
${ctx?.brandBible ? `<brand_bible>
${ctx.brandBible.slice(0, 3000)}
</brand_bible>
` : ""}
<request>
Title: ${r.title}
Angle: ${r.angle_name ?? "not set"}
Audience: ${r.audience ?? "not set"}
Landing page: ${r.landing_url ?? "not set"}
Brief:
${r.brief ?? "(no brief)"}
</request>`,
  });
  await admin.from("requests").update({ client_summary: summary }).eq("id", requestId);
  return summary;
}

/** A ticket just went to the client's portal: the "why we made this" intro, and (when it's revised) what changed. */
export async function onReachedClient(admin: SupabaseClient, requestId: string) {
  try {
    await writeClientSummary(admin, requestId);
  } catch (e) {
    console.error("[portal] client summary failed:", e instanceof Error ? e.message : e);
  }
  try {
    await summarizeRevision(admin, requestId);
  } catch (e) {
    console.error("[portal] revision summary failed:", e instanceof Error ? e.message : e);
  }
}
