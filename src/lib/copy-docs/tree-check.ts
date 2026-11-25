import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { folderIdOf } from "@/lib/creative-drive-paths";
import { isEmailMarketing, planLines, planTree, type FolderInfo, type TreePlan } from "./tree-check-core";

// Checks (and, on a yes, fixes) where a client's approved email copy sits in Drive (src/lib/copy-docs/tree-check-core.ts),
// as the person asking: their Headquarters is found the way approving copy finds it (never made), the folders the copy
// Docs went into are read with their full paths, and anything outside the Headquarters is listed with the fix. The fix
// moves Docs (or the misplaced folder) and nothing else; an emptied folder is left for them to delete.

export type TreeCheck = { ok: true; plan: TreePlan; lines: string[] } | { ok: false; error: string; askForLink?: boolean };

export async function checkEmailTree(admin: SupabaseClient, me: { email: string }, clientId: string, hqLink?: string | null): Promise<TreeCheck> {
  const [{ clientFacts }, { findHq }, { driveFor }, { folderWhere, childrenOf }] = await Promise.all([import("./server"), import("./hq-path"), import("./drive"), import("@/lib/drive-destination")]);
  const facts = await clientFacts(admin as never, clientId);
  const root = process.env.GOOGLE_SHARED_DRIVE_ID ?? null;
  const probe = [hqLink, ...facts.hqLinks, facts.clientFolder, root].map((x) => (x ? folderIdOf(x) : null)).find(Boolean) ?? null;
  if (!probe) return { ok: false, error: `I don't know where ${facts.name}'s Headquarters folder is: paste its link.`, askForLink: true };
  const look = await driveFor(me.email, probe);
  const hq = await findHq(look.drive, { client: { name: facts.name, kaizenId: facts.kaizenId }, pasted: hqLink ?? null, stored: facts.hqLinks, clientFolder: facts.clientFolder, root });
  if (!hq.ok) return { ok: false, error: hq.error, askForLink: true };
  const hqInfo = await folderWhere(me.email, hq.id);
  if (!hqInfo) return { ok: false, error: `Drive won't open ${facts.name}'s Headquarters as you.` };
  const emailChild = (await childrenOf(me.email, hq.id)).find((f) => f.mimeType === "application/vnd.google-apps.folder" && isEmailMarketing(f.name)) ?? null;
  const email = emailChild ? await folderWhere(me.email, emailChild.id) : null;
  const { data: docs } = await admin.from("copy_docs").select("folder_id").eq("client_id", clientId).not("folder_id", "is", null);
  const counts = new Map<string, number>();
  for (const d of docs ?? []) counts.set(d.folder_id as string, (counts.get(d.folder_id as string) ?? 0) + 1);
  const info: Record<string, FolderInfo | null> = {};
  for (const id of counts.keys()) info[id] = await folderWhere(me.email, id).catch(() => null);
  const plan = planTree({ hq: hqInfo, email, docFolders: [...counts].map(([folderId, n]) => ({ folderId, docs: n })), info });
  return { ok: true, plan, lines: planLines(plan) };
}

/** The fix, after the person said yes to the listed plan: moves only what was listed */
export async function fixEmailTree(admin: SupabaseClient, me: { email: string }, clientId: string, hqLink?: string | null): Promise<{ ok: true; moved: string[] } | { ok: false; error: string }> {
  const c = await checkEmailTree(admin, me, clientId, hqLink);
  if (!c.ok) return c;
  const { moveInto, childrenOf } = await import("@/lib/drive-destination");
  const moved: string[] = [];
  for (const m of c.plan.misplaced) {
    if (m.action === "move_folder") {
      await moveInto(me.email, m.folder.id, c.plan.hq.id);
      moved.push(`${m.folder.name} → ${c.plan.hq.path.join(" › ")}`);
      await admin.from("copy_docs").update({ updated_at: new Date().toISOString() }).eq("client_id", clientId).eq("folder_id", m.folder.id);
    } else {
      for (const f of await childrenOf(me.email, m.folder.id)) {
        await moveInto(me.email, f.id, c.plan.email!.id);
        moved.push(`${f.name} → ${c.plan.email!.path.join(" › ")}`);
      }
      await admin.from("copy_docs").update({ folder_id: c.plan.email!.id }).eq("client_id", clientId).eq("folder_id", m.folder.id);
    }
  }
  return { ok: true, moved };
}
