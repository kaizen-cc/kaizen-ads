"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { lastMonthOf, channelPeriods, type ChannelKind, type ChannelLine } from "@/lib/channel-reports/core";
import { linesFor } from "@/lib/channel-reports/access-core";
import { channelClients, ownersFor } from "@/lib/channel-reports/clients";

// Drafting an email or organic social report on demand from the Reports page's Build view. Everything done on the report
// itself (revise with the AI, check, bring the text up to the numbers, the layout, send, Drive, skip, regenerate, the
// history) goes through the same actions as an ads report (actions.ts), which hand the channel's own work to its code.

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

/** Drafts a report now for a client: the month just over, or the week just over (an existing one is opened instead) */
export async function draftChannelAction(clientId: string, line: ChannelLine, kind: ChannelKind): Promise<Result<{ id: string; existing: boolean }>> {
  const me = await requireStaff();
  if (!linesFor(me).includes(line) || (kind !== "monthly" && kind !== "weekly")) return { ok: false, error: "Not found." };
  const admin = createAdminClient();
  if (!(await channelClients(admin, me, line)).some((c) => c.id === clientId)) return { ok: false, error: "Not found." };
  const { coverageFor } = await import("@/lib/channel-reports/clients");
  const cover = (await coverageFor(admin, line, [clientId])).get(clientId);
  if (cover?.state !== "connected") return { ok: false, error: cover?.what ?? "It isn't connected yet." };
  const { draftChannelNow, draftChannelQueued } = await import("@/lib/channel-reports/queue");
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const period = kind === "monthly" ? lastMonthOf(today) : channelPeriods("weekly", today).main;
  const owners = await ownersFor(admin, line, [clientId]);
  const out = await draftChannelNow(admin, { clientId, line, kind, period, ownerId: owners.get(clientId) ?? me.id });
  if (!out.ok) return out;
  if (!out.existing) after(() => draftChannelQueued(admin, 200_000));
  revalidatePath("/reports");
  return { ok: true, id: out.id, existing: out.existing };
}
