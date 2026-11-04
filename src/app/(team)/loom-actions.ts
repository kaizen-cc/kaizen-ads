"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { isExecOrLead, requireStaff, type Staff } from "@/lib/auth";
import { aiEnabled } from "@/lib/ai";
import { isLoomSpace, loomFolders, pastedLooms } from "@/lib/loom-links";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// Loom videos into the knowledge: pasted in bulk (links one per line, a CSV export, a folder page's source) or as a
// shared folder link, in Settings (execs and leads) or on a client's Documents (anyone who can see the client). The
// queue is worked through in the background; the panel asks it to keep going while it's open.

type R<T = object> = ({ ok: true } & T) | { ok: false; error: string };

async function canUse(me: Staff, clientId: string | null) {
  if (!clientId) return isExecOrLead(me);
  const { data } = await (await createClient()).from("clients").select("id").eq("id", clientId).maybeSingle();
  return Boolean(data);
}

async function work() {
  const admin = createAdminClient();
  const { processLoomQueue } = await import("@/lib/loom-intake");
  after(() => processLoomQueue(admin, { budgetMs: 480_000 }).catch(() => null));
}

/** Links and folder links in pasted text: every video queued (duplicates skipped), every folder saved and read */
export async function importLooms(text: string, clientId: string | null): Promise<R<{ added: number; skipped: number; folders: { found: number; added: number; error: string | null }[] }>> {
  try {
    const me = await requireStaff();
    if (!adminConfigured()) return { ok: false, error: "Not connected." };
    if (!(await canUse(me, clientId))) return { ok: false, error: "You can't add Looms here." };
    if (!aiEnabled()) return { ok: false, error: "The AI isn't connected, so videos can't be read yet." };
    const admin = createAdminClient();
    const { addLoomFolder, queueLooms } = await import("@/lib/loom-intake");
    const links = pastedLooms(text).slice(0, 5000);
    const folders = loomFolders(text).slice(0, 10);
    if (!links.length && !folders.length)
      return { ok: false, error: isLoomSpace(text) ? "That's a Loom Space, which only its members can open. Share a folder (anyone with the link) and paste its link, or paste the video links." : "No Loom links found. Paste video links (loom.com/share/…) or a shared folder link (loom.com/share/folder/…)." };
    const q = links.length ? await queueLooms(admin, links, { source: clientId ? "client" : "bulk", by: me.id, clientId }) : { added: 0, skipped: 0 };
    const read: { found: number; added: number; error: string | null }[] = [];
    for (const f of folders) {
      const r = await addLoomFolder(admin, f.url, { clientId, by: me.id }).catch((e) => ({ found: 0, added: 0, error: e instanceof Error ? e.message : String(e) }));
      read.push({ found: r.found, added: r.added, error: r.error });
    }
    await work();
    revalidatePath(clientId ? "/clients" : "/settings", "layout");
    return { ok: true, added: q.added + read.reduce((n, f) => n + f.added, 0), skipped: q.skipped, folders: read };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't add them." };
  }
}

/** While the panel is open and videos are waiting: keep the queue moving (only when nothing is being read right now) */
export async function keepLoomsGoing(): Promise<R> {
  try {
    await requireStaff();
    if (!adminConfigured() || !aiEnabled()) return { ok: true };
    const admin = createAdminClient();
    const { count: busy } = await admin.from("loom_videos").select("id", { count: "exact", head: true }).eq("status", "reading").gt("updated_at", new Date(Date.now() - 5 * 60_000).toISOString());
    const { count: due } = await admin.from("loom_videos").select("id", { count: "exact", head: true }).eq("status", "queued").lte("next_at", new Date().toISOString());
    if (!busy && due) await work();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't continue." };
  }
}

/** A video waiting for its client: filed to the client picked (or to no one client) */
export async function assignLoomVideo(id: string, clientId: string | null): Promise<R> {
  try {
    const me = await requireStaff();
    if (!(await canUse(me, clientId))) return { ok: false, error: "You can't file it there." };
    if (!clientId && !isExecOrLead(me)) return { ok: false, error: "Execs and leads decide that." };
    await (await import("@/lib/loom-intake")).assignLoom(createAdminClient(), id, clientId);
    revalidatePath("/settings", "layout");
    revalidatePath("/clients", "layout");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't file it." };
  }
}

/** A video that couldn't be read (made public, captions on): read again */
export async function retryLoomVideo(id: string): Promise<R> {
  try {
    await requireStaff();
    await (await import("@/lib/loom-intake")).retryLoom(createAdminClient(), id);
    await work();
    revalidatePath("/settings", "layout");
    revalidatePath("/clients", "layout");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't try again." };
  }
}

/** Execs: merge the senior buyer's new teachings now and rewrite the generated skills */
export async function consolidateBuyerInsights(): Promise<R<{ merged: number; conflicts: number; kept: number; left: number }>> {
  try {
    const me = await requireStaff();
    if (!me.isExec) return { ok: false, error: "Execs only." };
    if (!aiEnabled()) return { ok: false, error: "The AI isn't connected." };
    const r = await (await import("@/lib/buying-insights")).consolidateInsights(createAdminClient(), { budgetMs: 420_000 });
    revalidatePath("/settings", "layout");
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't consolidate." };
  }
}

/** Execs: a ruling on a contradiction (keep this one, drop it, or both hold in different situations) */
export async function ruleBuyerInsight(id: string, ruling: "keep" | "drop" | "both"): Promise<R> {
  try {
    const me = await requireStaff();
    if (!me.isExec) return { ok: false, error: "Execs only." };
    await (await import("@/lib/buying-insights")).ruleInsight(createAdminClient(), id, ruling, me.id);
    revalidatePath("/settings", "layout");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't save the ruling." };
  }
}

/** A shared folder read again now (new recordings queued) */
export async function recheckLoomFolder(id: string): Promise<R<{ found: number; added: number; error: string | null }>> {
  try {
    await requireStaff();
    const r = await (await import("@/lib/loom-intake")).syncLoomFolder(createAdminClient(), id);
    await work();
    revalidatePath("/settings", "layout");
    revalidatePath("/clients", "layout");
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't read the folder." };
  }
}
