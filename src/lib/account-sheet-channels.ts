import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readTab } from "@/lib/account-sheet";
import { setPrimarySeat } from "@/lib/buyer-seats";
import { channelSeatsOf, isBlankName, sheetRows, splitNames, type ChannelTab } from "@/lib/account-sheet-channels-core";

// The Email and Organic Social tabs of the Account Overview sheet: who's on each client for that line. The sheet is
// where the teams keep it, so it's the source of truth, the same way the Meta and Google tabs set the media buyers: the
// person a column names becomes that client's seat (Strategist, Designer, Builder on Email; Strategist, Graphic Designer,
// Video Editor on Organic Social). A blank cell never takes anyone off; a name that isn't on the team is reported.

/** A seat as the boards name it (the second name is a second person on the seat: the Video Editor beside the designer) */
const SEAT_NAME: Record<string, [string, string]> = {
  email_strategist: ["Strategist", "Strategist"],
  email_designer: ["Designer", "Designer"],
  email_builder: ["Builder", "Builder"],
  social_manager: ["Strategist", "Strategist"],
  social_creative: ["Graphic designer", "Video editor"],
};

export type ChannelSheetResult = { seats: number; rows: number; unknownPeople: string[]; noClient: string[]; tabs: string[] };

export async function syncChannelTabs(admin: SupabaseClient, tok: string, titles: string[]): Promise<ChannelSheetResult> {
  const out: ChannelSheetResult = { seats: 0, rows: 0, unknownPeople: [], noClient: [], tabs: [] };
  const tabs: { line: ChannelTab; title: string }[] = [];
  const email = titles.find((x) => /^\s*email/i.test(x));
  const social = titles.find((x) => /organic|^\s*social/i.test(x));
  if (email) tabs.push({ line: "email", title: email });
  if (social) tabs.push({ line: "social", title: social });
  if (!tabs.length) return out;

  const [{ data: people }, { data: clients }] = await Promise.all([
    admin.from("profiles").select("id, full_name, role, also_social").eq("is_active", true),
    admin.from("clients").select("id, name").is("archived_at", null),
  ]);
  const person = (name: string) => {
    const n = name.trim().toLowerCase();
    if (!n) return null;
    const all = people ?? [];
    return all.find((p) => p.full_name.toLowerCase() === n) ?? all.find((p) => p.full_name.toLowerCase().split(" ")[0] === n.split(" ")[0]) ?? null;
  };
  const nm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const clientNamed = (name: string) => {
    const n = nm(name);
    if (n.length < 3) return null;
    const exact = (clients ?? []).filter((c) => nm(c.name) === n);
    if (exact.length === 1) return exact[0];
    const loose = (clients ?? []).filter((c) => nm(c.name).length >= 4 && (n.includes(nm(c.name)) || nm(c.name).includes(n)));
    return loose.length === 1 ? loose[0] : null;
  };
  const unknown = new Set<string>();

  for (const { line, title } of tabs) {
    const values = await readTab(tok, title).catch(() => [] as string[][]);
    if (!values.length) continue;
    out.tabs.push(title);
    for (const r of sheetRows(values)) {
      const name = r["Client Name"] ?? "";
      if (!name.trim()) continue;
      out.rows++;
      const client = clientNamed(name);
      if (!client) {
        out.noClient.push(`${name} (${title})`);
        continue;
      }
      // The names as the sheet has them, for the boards (who's on it even before they're in the app)
      const named = channelSeatsOf(line, r).map((s) => ({ seat: SEAT_NAME[s.role][s.primary ? 0 : 1], names: splitNames(s.value).filter((x) => !isBlankName(x)) }));
      const { data: cur } = await admin.from("clients").select("channel_sheet").eq("id", client.id).maybeSingle();
      await admin.from("clients").update({ channel_sheet: { ...((cur?.channel_sheet ?? {}) as Record<string, unknown>), [line]: named } }).eq("id", client.id);
      for (const seat of channelSeatsOf(line, r)) {
        const names = splitNames(seat.value).filter((x) => !isBlankName(x));
        for (const [i, who] of names.entries()) {
          const p = person(who);
          if (!p) {
            unknown.add(`${who} (${seat.column})`);
            continue;
          }
          // A creative the Organic Social tab names works on organic social: their switch goes on so the seat is theirs
          if (seat.role === "social_creative" && !p.also_social) {
            await admin.from("profiles").update({ also_social: true }).eq("id", p.id);
            p.also_social = true;
          }
          const { data: cur } = await admin.from("client_assignments").select("profile_id, is_primary").eq("client_id", client.id).eq("role", seat.role);
          if ((cur ?? []).some((c) => c.profile_id === p.id)) continue;
          // The first person a column names holds the seat; a second one (the Video Editor beside the Graphic Designer,
          // or "Ana / Luis") sits on it too, without taking the lead
          if (seat.primary && i === 0) {
            const res = await setPrimarySeat(admin, client.id, seat.role, p.id);
            if (res.ok) out.seats++;
          } else {
            const { error } = await admin.from("client_assignments").insert({ client_id: client.id, role: seat.role, profile_id: p.id, is_primary: false });
            if (!error) out.seats++;
          }
        }
      }
    }
  }
  out.unknownPeople = [...unknown];
  return out;
}
