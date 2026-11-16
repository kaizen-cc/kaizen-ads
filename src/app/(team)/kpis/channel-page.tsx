import { type Staff } from "@/lib/auth";
import { HEAD_OF, type Line } from "@/lib/channel-kpis/calc";
import { loadChannelBoard } from "@/lib/channel-kpis/load";
import { teamPlatform } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";
import { ChannelBoard, type BoardSwitch } from "./channel-board";

/**
 * The Email or Social KPI board. The email and social teams land here on /kpis for their own line; execs and leads reach
 * it from the switch beside Meta and Google (?p=email, ?p=social). Switching boards is a page change (each loads its own
 * numbers), so it's a link and the browser's back returns to the board before.
 */
export async function ChannelKpis({ me, line, switcher }: { me: Staff; line: Line; switcher: boolean }) {
  const db = await createClient();
  const board = await loadChannelBoard(db, line, me);
  const ads = teamPlatform(me.role) ? ([teamPlatform(me.role)] as ("meta" | "google")[]) : (["meta", "google"] as const);
  const tabs: BoardSwitch[] | null = switcher
    ? [
        ...ads.map((p) => ({ id: p, label: p === "meta" ? "Meta" : "Google", href: `/kpis?p=${p}`, active: false })),
        { id: "email", label: "Email", href: "/kpis?p=email", active: line === "email" },
        { id: "social", label: "Social", href: "/kpis?p=social", active: line === "social" },
      ]
    : null;
  // Someone seated on clients opens on those; heads, leads and execs open on everyone
  const wide = me.isExec || me.isLead || me.role === HEAD_OF[line];
  const lastSync = board.rows.map((r) => r.lastSyncedAt).filter((x): x is string => Boolean(x)).sort().at(-1) ?? null;
  return <ChannelBoard line={line} rows={board.rows} month={board.month} switcher={tabs} initialWho={!wide && board.rows.some((r) => r.mine) ? "mine" : "all"} lastSync={lastSync} />;
}
