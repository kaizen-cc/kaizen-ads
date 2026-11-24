import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// Work the person approved that keeps going after the call or chat ends (case studies for a list of clients, each
// written, drawn and, when they named a folder, put into their Google Drive): the background step does one item at a
// time, tells the person in the app as each one is ready with its file linked, and once more when the job is done.
// Everything runs as them: their clients (checked when the job was queued), their Drive.

export type JobItem = { client_id: string; client: string; notes: string; status: "queued" | "done" | "failed"; doc_id?: string; link?: string | null; drive?: string | null; error?: string };
type JobRow = { id: string; profile_id: string; kind: string; title: string; items: JobItem[]; drive_folder: string | null; drive_subfolder: string | null; drive_folder_id: string | null; drive_folder_path: string | null; status: string };

/** Queues a job (the clients already checked against what the person can see) */
export async function queueJob(admin: SupabaseClient, o: { profileId: string; callId: string | null; title: string; items: { client_id: string; client: string; notes: string }[]; folder?: string | null; subfolder?: string | null; folderPath?: string | null }): Promise<string> {
  const { data, error } = await admin
    .from("after_call_jobs")
    .insert({ profile_id: o.profileId, call_id: o.callId, kind: "case_studies", title: o.title.slice(0, 200), items: o.items.map((i) => ({ ...i, status: "queued" })), drive_folder: o.folder || null, drive_subfolder: o.subfolder || null, drive_folder_path: o.folderPath || null })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Couldn't queue it.");
  return data.id as string;
}

async function tell(admin: SupabaseClient, profileId: string, key: string, title: string, body: string, href: string, clientId: string | null) {
  await admin.from("notifications").upsert([{ profile_id: profileId, kind: "assistant", title: title.slice(0, 200), body: body.slice(0, 1000), href, client_id: clientId, key, priority: "normal" }], { onConflict: "profile_id,key", ignoreDuplicates: true });
}

/** One pass of the background step: the next item of each open job (a few jobs at a time, oldest first) */
export async function runAfterCallJobs(admin: SupabaseClient, opts: { maxItems?: number } = {}): Promise<{ done: number; failed: number }> {
  const max = opts.maxItems ?? 3;
  const { data } = await admin.from("after_call_jobs").select("id, profile_id, kind, title, items, drive_folder, drive_subfolder, drive_folder_id, drive_folder_path, status").in("status", ["queued", "running"]).order("created_at").limit(5);
  let done = 0;
  let failed = 0;
  for (const job of (data ?? []) as JobRow[]) {
    if (done + failed >= max) break;
    const items = [...job.items];
    const i = items.findIndex((x) => x.status === "queued");
    if (i < 0) {
      await finish(admin, job, items);
      continue;
    }
    await admin.from("after_call_jobs").update({ status: "running", updated_at: new Date().toISOString() }).eq("id", job.id);
    const { data: me } = await admin.from("profiles").select("id, email, is_active").eq("id", job.profile_id).maybeSingle();
    const item = items[i];
    // The folder is found before anything is made (the Drive rule: the folder they named, its last subfolder made
    // when missing; several matches or none: nothing is made and they're told, with the candidates)
    if (job.drive_folder && !job.drive_folder_id && me?.is_active) {
      const { findDestination } = await import("@/lib/drive-destination");
      const { pathText } = await import("@/lib/drive-destination-core");
      const f = await findDestination(String(me.email), job.drive_folder, job.drive_subfolder, "make").catch((e) => ({ notFound: e instanceof Error ? e.message : String(e) }));
      if (!("dest" in f)) {
        const why = ("ask" in f ? f.say : `The Drive folder "${job.drive_folder_path ?? job.drive_folder}" wasn't found: ${f.notFound}`).slice(0, 800);
        await admin.from("after_call_jobs").update({ status: "failed", error: why, finished_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", job.id);
        await tell(admin, job.profile_id, `job:${job.id}:folder`, `${job.title}: the Drive folder needs you`, `${why} Nothing was made yet. Send the folder's link and ask again.`, "/assistant", null);
        failed++;
        continue;
      }
      const path = pathText(f.dest.path);
      await admin.from("after_call_jobs").update({ drive_folder_id: f.dest.id, drive_folder_path: path }).eq("id", job.id);
      job.drive_folder_id = f.dest.id;
      job.drive_folder_path = path;
    }
    try {
      if (!me?.is_active) throw new Error("Their account isn't active any more.");
      const { writeCaseStudy, makeCaseStudy } = await import("@/lib/documents/case-study-server");
      const client = { id: item.client_id, name: item.client };
      const cs = await writeCaseStudy(admin, client, item.notes);
      const made = await makeCaseStudy(admin, { id: job.profile_id }, client, cs);
      let drive: string | null = null;
      if (job.drive_folder_id) {
        const { uploadToFolder } = await import("@/lib/drive-push");
        drive = (await uploadToFolder(String(me.email), job.drive_folder_id, made.fileName, made.bytes, "application/pdf")).link;
        // Remembered for this client's case studies, so the next one is a quick "Saving to <path>, OK?"
        const { rememberDestination } = await import("@/lib/drive-destination");
        await rememberDestination(admin, { profileId: job.profile_id, clientId: item.client_id, docType: "case_study" }, { id: job.drive_folder_id, path: (job.drive_folder_path ?? "").split(" › ").filter(Boolean), link: `https://drive.google.com/drive/folders/${job.drive_folder_id}` }).catch(() => undefined);
      }
      items[i] = { ...item, status: "done", doc_id: made.id, link: made.href, drive };
      done++;
      await tell(admin, job.profile_id, `job:${job.id}:${i}`, `${item.client} case study is ready`, drive ? `Saved: ${drive} in ${job.drive_folder_path ?? "your Drive folder"}.` : "Open it to read or download it.", drive ?? made.href, item.client_id);
    } catch (e) {
      items[i] = { ...item, status: "failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
      failed++;
    }
    await admin.from("after_call_jobs").update({ items, updated_at: new Date().toISOString() }).eq("id", job.id);
    if (!items.some((x) => x.status === "queued")) await finish(admin, job, items);
  }
  return { done, failed };
}

async function finish(admin: SupabaseClient, job: JobRow, items: JobItem[]) {
  const ok = items.filter((x) => x.status === "done");
  const bad = items.filter((x) => x.status === "failed");
  await admin.from("after_call_jobs").update({ status: ok.length ? "done" : "failed", finished_at: new Date().toISOString(), updated_at: new Date().toISOString(), error: bad.length ? bad.map((b) => `${b.client}: ${b.error}`).join("; ").slice(0, 1000) : null }).eq("id", job.id);
  await tell(admin, job.profile_id, `job:${job.id}:done`, `${job.title}: ${ok.length} of ${items.length} done`, [bad.length ? `Not done: ${bad.map((b) => `${b.client} (${b.error})`).join("; ")}.` : "Everything you asked for is ready.", job.drive_folder_path && ok.some((x) => x.drive) ? `In ${job.drive_folder_path}.` : ""].filter(Boolean).join(" "), ok[0]?.drive ?? ok[0]?.link ?? "/assistant", null);
}
