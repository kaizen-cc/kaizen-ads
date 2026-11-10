"use server";

import { requireStaff } from "@/lib/auth";
import { BRIEF_BUCKET, MAX_BRIEF_FILES, briefFileProblem, safeName } from "@/lib/brief-files";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// Upload slots for files added to a brief (Talk it through, the revise chat): checked here (the client is one this
// person works on, the type and size are ones we take), then the browser sends each file straight to storage.

type Fail = { ok: false; error: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** role "frame": a picture the browser took from a video (small JPEG), kept next to the video */
export async function briefFileSlots(clientId: string, files: { name: string; mime: string; bytes: number; role?: "file" | "frame" }[]): Promise<{ ok: true; slots: { path: string; token: string }[] } | Fail> {
  await requireStaff();
  if (!UUID.test(clientId)) return { ok: false, error: "Pick a client first." };
  if (!adminConfigured()) return { ok: false, error: "Files can't be added here (storage isn't connected)." };
  const { data: mine } = await (await createClient()).from("clients").select("id").eq("id", clientId).maybeSingle();
  if (!mine) return { ok: false, error: "That client isn't one you work on." };
  const main = files.filter((f) => (f.role ?? "file") === "file");
  if (!main.length) return { ok: false, error: "No file to add." };
  if (main.length > MAX_BRIEF_FILES) return { ok: false, error: `Up to ${MAX_BRIEF_FILES} files at a time.` };
  if (files.length > MAX_BRIEF_FILES * 6) return { ok: false, error: "Too many pieces." };
  for (const f of files) {
    if ((f.role ?? "file") === "frame") {
      if (f.mime !== "image/jpeg" || !(f.bytes > 0) || f.bytes > 3_000_000) return { ok: false, error: "A video frame couldn't be read." };
      continue;
    }
    const why = briefFileProblem(f);
    if (why) return { ok: false, error: why };
  }
  const admin = createAdminClient();
  const batch = crypto.randomUUID();
  const slots: { path: string; token: string }[] = [];
  for (const [i, f] of files.entries()) {
    const path = `${clientId}/${batch}/${(f.role ?? "file") === "frame" ? "frame-" : ""}${String(i).padStart(2, "0")}-${safeName(f.name)}`;
    const { data, error } = await admin.storage.from(BRIEF_BUCKET).createSignedUploadUrl(path);
    if (error || !data) return { ok: false, error: "Couldn't get the upload ready. Try again." };
    slots.push({ path: data.path, token: data.token });
  }
  return { ok: true, slots };
}
