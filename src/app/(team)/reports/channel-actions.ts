"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { lastMonthOf, platformOfLine, type ChannelKind, type ChannelLine } from "@/lib/channel-reports/core";
import { linesFor } from "@/lib/channel-reports/access-core";
import { channelClients, ownersFor } from "@/lib/channel-reports/clients";
import { shiftDay } from "@/lib/reports/period";

// Building an email or organic social report from the Reports page's report builder: the same steps as an ads report
// (the client, the dates, the service), drafted by the channel's writer. Everything done on the report itself (revise
// with the AI, check, the layout, send, Drive, skip, regenerate, the history) goes through the same actions as an ads
// report (actions.ts), which hand the channel's own work to its code.

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

/** The report's cadence for the dates picked: a full calendar month is the monthly, Monday to Sunday last week the weekly, anything else its own dates */
function kindOf(key: string, r: { start: string; end: string }): ChannelKind {
  if (key === "lastWeek") return "weekly";
  const month = lastMonthOf(shiftDay(r.end, 1));
  return month.start === r.start && month.end === r.end ? "monthly" : "custom";
}

/**
 * Builds a report for a client on a line for the dates picked (the builder's presets or custom dates). One already
 * there for those dates is opened instead. `replace` holds the person's own drafts waiting on the client: they step
 * aside for this one (skipped and off the page; they stay in the client's history).
 */
export async function buildChannelReportAction(clientId: string, line: ChannelLine, range: { key: string; start?: string; end?: string }, replace: string[] = []): Promise<Result<{ id: string; existing: boolean }>> {
  const me = await requireStaff();
  if (line !== "email" && line !== "social") return { ok: false, error: "Not found." };
  if (!linesFor(me).includes(line)) return { ok: false, error: "Not found." };
  const admin = createAdminClient();
  if (!(await channelClients(admin, me, line)).some((c) => c.id === clientId)) return { ok: false, error: "Not found." };
  const { coverageFor } = await import("@/lib/channel-reports/clients");
  const cover = (await coverageFor(admin, line, [clientId])).get(clientId);
  if (cover?.state !== "connected") return { ok: false, error: cover?.what ?? "It isn't connected yet." };
  const { resolveRange } = await import("@/lib/reports/builder");
  const period = resolveRange(range.key, undefined, range.start && range.end ? { start: range.start, end: range.end } : undefined);
  if (!period) return { ok: false, error: "Pick the dates to report on (custom dates need a start and an end in the past)." };
  const { draftChannelNow, draftChannelQueued } = await import("@/lib/channel-reports/queue");
  const owners = await ownersFor(admin, line, [clientId]);
  if (replace.length) {
    const now = new Date().toISOString();
    await admin.from("reports").update({ status: "skipped", hidden_at: now, updated_at: now }).in("id", replace.slice(0, 10)).eq("owner_id", me.id).eq("client_id", clientId).eq("platform", platformOfLine(line)).neq("status", "posted");
  }
  const out = await draftChannelNow(admin, { clientId, line, kind: kindOf(range.key, period), period: { start: period.start, end: period.end }, ownerId: owners.get(clientId) ?? me.id });
  if (!out.ok) return out;
  if (!out.existing) after(() => draftChannelQueued(admin, 200_000));
  revalidatePath("/reports");
  return { ok: true, id: out.id, existing: out.existing };
}
