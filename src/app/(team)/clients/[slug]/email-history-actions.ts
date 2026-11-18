"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { requireStaff } from "@/lib/auth";
import { providerName } from "@/lib/email-providers/core";
import { emailConnection } from "@/lib/email-providers/which";
import { historyBusy, readingLine, stretchLabel, type HistoryState } from "@/lib/email-history/core";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// "Read full history" on the client's email card: a lead, an exec or anyone on the client asks for the months before
// what is stored (from the client's start or up to two years back); it is read in the background, a few pieces at a time.

export type HistoryView = { provider: string; stored: string | null; busy: boolean; line: string | null; pct: number; failed: string | null; done: string | null };

const etToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

async function mine(clientId: string) {
  await requireStaff();
  if (!adminConfigured()) return { error: "Not set up here." } as const;
  const { data } = await (await createClient()).from("clients").select("id, slug, created_at").eq("id", clientId).maybeSingle();
  if (!data) return { error: "You don't work on this client." } as const;
  return { slug: data.slug as string, start: (data.created_at as string | null) ?? null, admin: createAdminClient() } as const;
}

export async function emailHistoryState(clientId: string): Promise<HistoryView | null> {
  const l = await mine(clientId);
  if ("error" in l) return null;
  const { readHistoryState, storedFrom } = await import("@/lib/email-history/run");
  const conn = await emailConnection(l.admin, clientId);
  if (!conn) return null;
  const [stored, s] = await Promise.all([storedFrom(l.admin, clientId), readHistoryState(l.admin, clientId)]);
  const name = providerName(conn.provider);
  const busy = historyBusy(s);
  const st: HistoryState | null = s;
  return {
    provider: name,
    stored,
    busy,
    line: busy && st ? readingLine(name, st.want, st.to) : null,
    pct: busy && st ? st.pct : 0,
    failed: st?.status === "failed" ? (st.error ?? "The read stopped.") : null,
    done: st?.status === "done" ? stretchLabel(st.want, st.to) : null,
  };
}

/** Starts the read: "start" from the client's start date, "2y" up to two years back */
export async function readFullHistory(clientId: string, span: "start" | "2y"): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const l = await mine(clientId);
  if ("error" in l) return { ok: false, error: l.error ?? "That client isn't yours." };
  const { requestHistory, runHistory, historyFloor } = await import("@/lib/email-history/run");
  const today = etToday();
  const want = historyFloor(l.start, span === "start" ? "start" : "2y", today);
  const ask = await requestHistory(l.admin, clientId, { wantStart: want, asked: "card", floor: span === "start" ? l.start : null });
  if (!ask.queued) return { ok: true, message: ask.line ?? "The history already goes back that far." };
  const admin = l.admin;
  after(() => runHistory(admin, clientId, 280_000).then(() => undefined));
  revalidatePath(`/clients/${l.slug}`);
  return { ok: true, message: `${ask.line ?? "Reading the history"} It runs in the background; you can leave this page.` };
}
