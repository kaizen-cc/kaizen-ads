"use server";

import { getViewer } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// The client's dashboard: the numbers for the dates they pick, and their questions about them. A team member can do
// the same while looking at it as the client.

async function load(slug: string) {
  const viewer = await getViewer();
  if (!adminConfigured()) return { error: "The portal isn't set up yet." } as const;
  const admin = createAdminClient();
  const { data: client } = await admin.from("clients").select("id, name, slug, portal_live").eq("slug", slug).maybeSingle();
  if (!client) return { error: "Not found." } as const;
  if (viewer.kind === "contact" && (!client.portal_live || !viewer.brands.some((b) => b.slug === slug))) return { error: "Not found." } as const;
  if (viewer.kind === "staff") {
    const { createClient } = await import("@/lib/supabase/server");
    const { data: mine } = await (await createClient()).from("clients").select("id").eq("id", client.id).maybeSingle();
    if (!mine) return { error: "Not found." } as const;
  }
  return { admin, client, who: viewer.kind === "contact" ? { name: viewer.fullName ?? viewer.email, contactId: viewer.id } : { name: `${viewer.fullName} (team)`, contactId: null } } as const;
}

const valid = (r: { start: string; end: string }) => /^\d{4}-\d{2}-\d{2}$/.test(r.start) && /^\d{4}-\d{2}-\d{2}$/.test(r.end) && r.start <= r.end && Date.parse(r.end) - Date.parse(r.start) <= 740 * 86_400_000;

export async function dashboardFor(slug: string, range: { start: string; end: string }) {
  const l = await load(slug);
  if ("error" in l) return { ok: false as const, error: l.error! };
  if (!valid(range)) return { ok: false as const, error: "Pick dates up to two years apart." };
  const { dashboardData } = await import("@/lib/client-dashboard");
  return { ok: true as const, parts: await dashboardData(l.admin, l.client.id, range) };
}

/** Every day of their accounts, once: the page draws any dates from it without asking again */
export async function dashboardHistoryFor(slug: string) {
  const l = await load(slug);
  if ("error" in l) return { ok: false as const, error: l.error! };
  const { dashboardHistory } = await import("@/lib/client-dashboard");
  return { ok: true as const, history: await dashboardHistory(l.admin, l.client.id) };
}

export async function askAboutNumbers(slug: string, question: string, range: { start: string; end: string }) {
  const l = await load(slug);
  if ("error" in l) return { ok: false as const, error: l.error! };
  if (!question.trim()) return { ok: false as const, error: "Ask something first." };
  if (!valid(range)) return { ok: false as const, error: "Pick dates up to two years apart." };
  try {
    const { askDashboard } = await import("@/lib/client-dashboard");
    const row = await askDashboard(l.admin, l.client.id, l.who, question, range);
    return { ok: true as const, row };
  } catch (e) {
    const { AiUnavailable } = await import("@/lib/ai");
    return { ok: false as const, error: e instanceof AiUnavailable ? e.message : "Something went wrong. Try again in a moment." };
  }
}
