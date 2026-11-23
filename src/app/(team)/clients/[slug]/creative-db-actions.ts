"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// The client's Creative Database, from the allotment card: link (or replace) the sheet the team logs deliveries in,
// and read it now. Delivered this cycle comes from it (every version counts), in motion from Asana.

type Result = { ok: true; name: string } | { ok: false; error: string };

async function guard(clientId: string) {
  const me = await requireStaff();
  if (!adminConfigured()) throw new Error("Not set up.");
  if (!(me.isExec || me.isLead || me.role === "head_of_creative")) throw new Error("The Head of Creative, a lead or an executive links the Creative Database.");
  const db = await createClient();
  const { data } = await db.from("clients").select("id, slug").eq("id", clientId).maybeSingle();
  if (!data) throw new Error("That client isn't one you work on.");
  return { admin: createAdminClient(), slug: data.slug as string };
}

/** Link or replace the client's Creative Database (a Google Sheets link), then read it */
export async function linkCreativeDb(clientId: string, link: string): Promise<Result> {
  try {
    const { admin, slug } = await guard(clientId);
    const { sheetIdOf, readClientCreativeDb } = await import("@/lib/creative-db");
    const id = sheetIdOf(link.trim());
    if (!id) return { ok: false, error: "Paste the Google Sheet's link." };
    await admin.from("clients").update({ creative_db_sheet_id: id }).eq("id", clientId);
    const r = await readClientCreativeDb(admin, clientId);
    revalidatePath(`/clients/${slug}`);
    return r;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Something went wrong." };
  }
}

/** Read the client's Creative Database now */
export async function readCreativeDbNow(clientId: string): Promise<Result> {
  try {
    const me = await requireStaff();
    if (!adminConfigured()) return { ok: false, error: "Not set up." };
    const db = await createClient();
    const { data } = await db.from("clients").select("id, slug").eq("id", clientId).maybeSingle();
    if (!data) return { ok: false, error: "That client isn't one you work on." };
    void me;
    const { readClientCreativeDb } = await import("@/lib/creative-db");
    const r = await readClientCreativeDb(createAdminClient(), clientId);
    revalidatePath(`/clients/${data.slug}`);
    return r;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Something went wrong." };
  }
}
