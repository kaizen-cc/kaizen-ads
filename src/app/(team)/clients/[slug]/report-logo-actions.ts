"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { canSeeReports } from "@/lib/roles";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { clearUploadedLogo, reportBrand, saveReportColor, saveUploadedLogo } from "@/lib/reports/brand-server";

type Result = { ok: true } | { ok: false; error: string };

async function allowed(): Promise<Result | null> {
  const me = await requireStaff();
  if (!canSeeReports(me)) return { ok: false, error: "Only executives and media buyers change a client's reports." };
  if (!adminConfigured()) return { ok: false, error: "The database isn't connected here." };
  return null;
}

/** The logo the client's reports carry, uploaded (PNG, JPG, SVG or WebP, up to 5 MB) */
export async function uploadReportLogo(clientId: string, slug: string, form: FormData): Promise<Result> {
  const no = await allowed();
  if (no) return no;
  const file = form.get("logo");
  if (!(file instanceof File) || !file.size) return { ok: false, error: "Pick a logo file first." };
  if (file.size > 5_000_000) return { ok: false, error: "That file is over 5 MB. Use a smaller logo." };
  const out = await saveUploadedLogo(createAdminClient(), clientId, Buffer.from(await file.arrayBuffer()));
  revalidatePath(`/clients/${slug}`);
  return out;
}

/** The report colour set by hand (a hex), or back to the one found ("") */
export async function setReportColor(clientId: string, slug: string, hex: string): Promise<Result> {
  const no = await allowed();
  if (no) return no;
  const out = await saveReportColor(createAdminClient(), clientId, hex.trim() || null);
  revalidatePath(`/clients/${slug}`);
  return out;
}

/** Back to the logo found on their website, Brand Bible or Drive (looked for again now) */
export async function resetReportLogo(clientId: string, slug: string): Promise<Result> {
  const no = await allowed();
  if (no) return no;
  const admin = createAdminClient();
  await clearUploadedLogo(admin, clientId);
  await reportBrand(admin, clientId, { refresh: true }).catch(() => null);
  revalidatePath(`/clients/${slug}`);
  return { ok: true };
}

/** Look for the logo and colour again (after their website or Brand Bible changed) */
export async function findReportLogo(clientId: string, slug: string): Promise<Result> {
  const no = await allowed();
  if (no) return no;
  await reportBrand(createAdminClient(), clientId, { refresh: true }).catch(() => null);
  revalidatePath(`/clients/${slug}`);
  return { ok: true };
}
