import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { AUDIO_BUCKET } from "@/lib/agent-call/safety";
import type { SafetyMoment } from "@/lib/assistant/core";
import { createAdminClient } from "@/lib/supabase/admin";
import { SafetyPlayer, type AudioPart, type TimedLine } from "./safety-player";

export const metadata: Metadata = { title: "Call review" };

// A call the safety review flagged, for the executives only: what was flagged and why, the moments to skip to, the
// timed transcript and the call's audio (kept about 90 days for a flagged call). The caller isn't told about the flag.
// Opening it marks it seen.

export default async function SafetyCallPage({ params }: PageProps<"/safety/[callId]">) {
  const { callId } = await params;
  const me = await requireStaff();
  if (!me.isExec || !/^[0-9a-f-]{36}$/.test(callId)) notFound();
  const admin = createAdminClient();
  const [{ data: review }, { data: call }] = await Promise.all([
    admin.from("call_safety_reviews").select("*").eq("call_id", callId).maybeSingle(),
    admin.from("ai_role_calls").select("id, profile_id, role_key, started_at, ended_at, profiles:profile_id(full_name)").eq("id", callId).maybeSingle(),
  ]);
  if (!review || !call || !review.flagged) notFound();
  if (!review.seen_at) await admin.from("call_safety_reviews").update({ seen_by: me.id, seen_at: new Date().toISOString() }).eq("call_id", callId);
  const { data: rows } = await admin.from("ai_role_chats").select("role, role_key, content, created_at").eq("call_id", callId).order("created_at").limit(400);
  const who = ((call as unknown as { profiles: { full_name: string } | null }).profiles?.full_name ?? "The caller") as string;
  const t0 = Date.parse(call.started_at as string);
  const lines: TimedLine[] = (rows ?? []).map((r) => ({ at: Math.max(0, Math.round((Date.parse(r.created_at as string) - t0) / 1000)), who: r.role === "user" ? who : `AI · ${String(r.role_key).replace(/_/g, " ")}`, text: r.content as string, person: r.role === "user" }));
  let parts: AudioPart[] = [];
  if (!review.audio_deleted_at) {
    const { data: files } = await admin.storage.from(AUDIO_BUCKET).list(callId, { limit: 100, sortBy: { column: "name", order: "asc" } });
    const signed = await Promise.all(
      (files ?? []).map(async (f) => {
        const { data } = await admin.storage.from(AUDIO_BUCKET).createSignedUrl(`${callId}/${f.name}`, 60 * 60);
        const start = Number(f.name.split("-")[1]?.split(".")[0] ?? 0);
        return data ? { url: data.signedUrl, start: Number.isFinite(start) ? start : 0 } : null;
      }),
    );
    parts = signed.filter((p): p is AudioPart => Boolean(p)).sort((a, b) => a.start - b.start);
  }
  const moments = (review.moments ?? []) as SafetyMoment[];
  const when = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(call.started_at as string));
  return (
    <div className="mx-auto grid max-w-3xl gap-5">
      <Link href="/pipeline" className="text-[13px] text-muted hover:text-fg">
        Back to the Overview
      </Link>
      <section className="rounded-[22px] border border-bad/30 bg-bad-soft/30 p-5 sm:p-6">
        <p className="text-[11px] uppercase tracking-[0.16em] text-bad">Flagged by the safety review · executives only</p>
        <h1 className="mt-1 font-heading text-[24px] leading-tight">
          {who}&apos;s call with the {call.role_key === "assistant" ? "assistant" : String(call.role_key).replace(/_/g, " ")}
        </h1>
        <p className="mt-1 text-sm text-muted">
          {when}
          {review.severity ? ` · ${review.severity} severity` : ""}
        </p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {(review.categories as string[]).map((c) => (
            <span key={c} className="rounded-full bg-surface px-3 py-1 text-[12px] text-fg">
              {c.replace(/_/g, " ")}
            </span>
          ))}
        </div>
        {review.summary && <p className="mt-3 text-[14.5px] leading-relaxed">{review.summary as string}</p>}
        {review.distress && <p className="mt-2 text-[13.5px] leading-relaxed text-warn">The caller may need support. Reach out kindly and privately.</p>}
        <p className="mt-3 text-[12px] text-faint">The caller isn&apos;t told about this flag. The audio is deleted about 90 days after the review.</p>
      </section>
      <SafetyPlayer parts={parts} moments={moments} lines={lines} audioGone={Boolean(review.audio_deleted_at)} />
    </div>
  );
}
