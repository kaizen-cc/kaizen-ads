"use server";

import { requireStaff } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { CopyComment } from "@/lib/copy-docs/core";
import type { CopyDoc } from "@/lib/copy-docs/server";

// The copy document view's actions: comment on a line, resolve it, ask the AI copywriter for a change (from a note or
// the open comments: the next version), approve it (the Google Doc in the client's HQ Drive), create the request
// (Asana now; Kaizen OS requests are coming soon), and the version check the view polls so a change made on a call
// shows up live. Each reads the copy through the person's own session first.

type Fail = { ok: false; error: string };
const fail = (e: unknown): Fail => ({ ok: false, error: e instanceof Error ? e.message : "Something went wrong." });

async function who() {
  const me = await requireStaff();
  return { me: { id: me.id, fullName: me.fullName, email: me.email ?? null }, db: await createClient(), admin: createAdminClient() };
}

export async function copyVersion(id: string): Promise<{ version: number; status: string; comments: number } | null> {
  const { db } = await who();
  const { data } = await db.from("copy_docs").select("version, status, comments").eq("id", id).maybeSingle();
  return data ? { version: Number(data.version), status: String(data.status), comments: ((data.comments ?? []) as unknown[]).length } : null;
}

export async function commentOnLine(id: string, c: { anchor: string; quote: string; text: string }): Promise<{ ok: true; comments: CopyComment[] } | Fail> {
  try {
    const { me, db, admin } = await who();
    const { addCopyComment } = await import("@/lib/copy-docs/server");
    return { ok: true, comments: await addCopyComment(admin, db, me, id, c) };
  } catch (e) {
    return fail(e);
  }
}

export async function resolveComment(id: string, commentId: string, resolved: boolean): Promise<{ ok: true; comments: CopyComment[] } | Fail> {
  try {
    const { db, admin } = await who();
    const { resolveCopyComment } = await import("@/lib/copy-docs/server");
    return { ok: true, comments: await resolveCopyComment(admin, db, id, commentId, resolved) };
  } catch (e) {
    return fail(e);
  }
}

export async function askForChange(id: string, note: string): Promise<{ ok: true; doc: CopyDoc } | Fail> {
  try {
    const { me, db, admin } = await who();
    const { reviseCopyDoc } = await import("@/lib/copy-docs/server");
    const doc = await reviseCopyDoc(admin, db, me, id, { note });
    // A call working on this copy sees the new version too
    const { data: run } = await admin.from("deliverable_runs").select("id").eq("doc_id", id).eq("open", true).maybeSingle();
    if (run) {
      const { patchRunById } = await import("@/lib/deliverables/server");
      await patchRunById(admin, run.id as string, { doc: { id, version: doc.version } });
    }
    return { ok: true, doc };
  } catch (e) {
    return fail(e);
  }
}

/** Approve: the Google Doc in the client's HQ Drive (Email Marketing); on a flow's run it counts as the person's approval */
export async function approveCopy(id: string): Promise<{ ok: true; docUrl: string } | (Fail & { fixHref?: string })> {
  try {
    const { me, db, admin } = await who();
    const { approveCopyDoc } = await import("@/lib/copy-docs/server");
    const r = await approveCopyDoc(admin, db, me, id);
    if (!r.ok) return r;
    const { data: run } = await admin.from("deliverable_runs").select("id").eq("doc_id", id).eq("open", true).maybeSingle();
    if (run) {
      const { patchRunById } = await import("@/lib/deliverables/server");
      await patchRunById(admin, run.id as string, { approve: "person" });
    }
    return { ok: true, docUrl: r.docUrl };
  } catch (e) {
    return fail(e);
  }
}

/** The request from the document view: a click on Create in Asana is the yes */
export async function requestCopy(id: string, where: "asana" | "kaizen"): Promise<{ ok: true; tasks: { name: string; url: string }[]; followerMissing: string | null } | Fail> {
  if (where === "kaizen") return { ok: false, error: "Kaizen OS requests are coming soon. Create it in Asana for now." };
  try {
    const { me, db, admin } = await who();
    const { loadCopyDoc } = await import("@/lib/copy-docs/server");
    const d = await loadCopyDoc(db, id);
    if (!d || !d.clientId) return { ok: false, error: "That copy isn't one you can request." };
    if (d.status === "draft") return { ok: false, error: "Approve the copy first." };
    const { applyPatch, newRun } = await import("@/lib/deliverables/engine");
    const { lineOf } = await import("@/lib/deliverables/lines");
    const { createRequests, patchRun } = await import("@/lib/deliverables/server");
    const cfg = lineOf("email")!;
    const { data: row } = await admin.from("deliverable_runs").select("id, state").eq("doc_id", id).eq("open", true).maybeSingle();
    // Outside a call's flow: a run for this copy, approved as it stands (the click is the person's and the lead's yes)
    let state = (row?.state as ReturnType<typeof newRun> | undefined) ?? newRun("email", { id: d.clientId, name: d.client ?? "" });
    for (const p of [{ kind: d.content.kind, count: d.content.emails.length }, ...(state.topicsAgreed ? [] : [{ topics: d.content.emails.map((e) => ({ title: e.name, angle: "", offer: "", include: [], exclude: [], send: "" })), agreed: true }]), { doc: { id: d.id, version: d.version } }, { approve: "person" as const }, { approve: "lead" as const }, { asked: true }]) {
      const r = applyPatch(cfg, state, p);
      if (r.ok) state = r.state;
    }
    let runId = row?.id as string | undefined;
    if (!runId) {
      const { data: made } = await admin.from("deliverable_runs").insert({ profile_id: me.id, line: "email", client_id: d.clientId, state, doc_id: d.id }).select("id").single();
      runId = made?.id as string;
    }
    const run = { id: runId, state, cfg };
    const r = await createRequests(admin, db, me, run);
    if (!r.ok) return r;
    await patchRun(admin, run, { requests: r.tasks });
    return { ok: true, tasks: r.tasks.map((t) => ({ name: t.name, url: t.url })), followerMissing: r.followerMissing };
  } catch (e) {
    return fail(e);
  }
}
