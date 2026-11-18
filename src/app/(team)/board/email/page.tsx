import { after } from "next/server";
import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { loadEmailBoard } from "@/lib/email-board";
import { loadEmailShadows } from "@/lib/asana-email";
import { roleLabel, seesCreativeBoard, seesEmailBoard, type TeamRole } from "@/lib/roles";
import { servicesOf } from "@/lib/services";
import { createClient } from "@/lib/supabase/server";
import { BoardSwitch } from "../board-switch";
import { BoardTabs } from "../creative-kpis";
import { EmailBoardClient } from "./email-board-client";
import { DirectionFlagsProvider } from "@/components/direction-parts";
import { loadTaskFlags } from "@/lib/direction-changes";

// The AI review of a design runs after an upload, and the copy after a ticket is made
export const maxDuration = 300;

/** Draws the missing pictures of these emails (read from the client's platform once, kept for the reports too) */
async function warmPictures(rows: { clientId: string; key: string }[]) {
  if (!rows.length) return;
  const [{ ensureEmailShots }, { adminConfigured, createAdminClient }] = await Promise.all([import("@/lib/channel-reports/email-shots"), import("@/lib/supabase/admin")]);
  if (!adminConfigured()) return;
  const admin = createAdminClient();
  const byClient = new Map<string, string[]>();
  for (const r of rows) byClient.set(r.clientId, [...(byClient.get(r.clientId) ?? []), r.key.split(":").slice(1).join(":")]);
  for (const [clientId, ids] of byClient) await ensureEmailShots(admin, clientId, ids, { fetch: true, budgetMs: 25_000 }).catch(() => null);
}

// The Email Board: every campaign batch and flow, where it's sitting and for how long. Execs see it beside the
// Creative Board (the switch); the email team works here only; everyone else goes to the Creative Board. Execs and the
// Head of Email also get the Email Team KPIs (?view=kpis&tab=design|build|copy|strategy), the way execs
// and leads get the Creative Board's; the strategists, designers and builders work on the Board itself.
export default async function EmailBoard({ searchParams }: PageProps<"/board/email">) {
  const { t, view, period, tab: tabParam } = await searchParams;
  const [me, db] = await Promise.all([requireStaff(), createClient()]);
  if (!seesEmailBoard(me)) redirect("/board");
  const lead = me.isExec || me.role === "head_of_email";
  const switcher = seesCreativeBoard(me);
  const p = period === "30" || period === "90" ? period : "cycle";
  // The Email Team KPIs: Design, Build, Copy and Strategy, the tab in the address (?view=kpis&tab=; an older
  // ?view=copy-kpis link is the Copy tab). Each tab shows only the people whose role belongs there, never the viewer.
  if ((view === "kpis" || view === "copy-kpis") && lead) {
    const { tabOf } = await import("@/lib/team-kpis-core");
    const tab = tabOf("email", view, tabParam);
    const { cachedEmailDesignKpis, cachedEmailCopyKpis } = await import("@/lib/board-kpis-cache");
    const k = await cachedEmailDesignKpis(p);
    // Winning emails with no picture yet: drawn in the background so the next visit shows the saved one
    after(() => warmPictures(k.winners.filter((r) => !r.image)));
    if (tab === "copy") {
      const { EmailCopyKpisView } = await import("./email-copy-kpis");
      return <EmailCopyKpisView k={await cachedEmailCopyKpis(p)} switcher={switcher} members={k.members.copy.filter((id) => id !== me.id)} workload={k.workload.filter((r) => r.profileId !== me.id)} />;
    }
    if (tab === "build") {
      const { EmailBuildView } = await import("./email-team-kpis");
      return <EmailBuildView k={k} switcher={switcher} viewerId={me.id} />;
    }
    if (tab === "strategy") {
      const { EmailStrategyView } = await import("./email-team-kpis");
      return <EmailStrategyView k={k} switcher={switcher} viewerId={me.id} />;
    }
    const { EmailDesignKpisView } = await import("./email-kpis");
    return <EmailDesignKpisView k={k} canDismiss={lead} switcher={switcher} viewerId={me.id} />;
  }
  // Execs and the Head of Email: the KPI tabs worked out while they look at the Board, so switching to them is instant
  if (lead)
    after(async () => {
      const { cachedEmailDesignKpis, cachedEmailCopyKpis } = await import("@/lib/board-kpis-cache");
      await Promise.all([cachedEmailDesignKpis("cycle"), cachedEmailCopyKpis("cycle")]).catch(() => null);
    });
  const asked = typeof t === "string" && /^\d+$/.test(t) ? Number(t) : null;
  const [allTickets, { data: clientRows }, { data: people }, shadows, flags] = await Promise.all([
    loadEmailBoard(db, { number: asked }),
    db.from("clients").select("id, name, slug, services, services_extra, services_removed").is("archived_at", null).in("status", ["active", "onboarding"]).order("name"),
    db.from("profiles").select("id, full_name, role, is_exec").eq("is_active", true).order("full_name"),
    loadEmailShadows(db).catch(() => []),
    // A client changed direction: the open tasks it touches are flagged on their cards
    loadTaskFlags(db).catch(() => ({})),
  ]);
  // Only clients that buy email marketing (src/lib/service-gate.ts): a removed service's tickets are kept, not shown
  // (one opened by its number still opens)
  const emailClients = new Set((clientRows ?? []).filter((c) => (servicesOf(c) as string[]).includes("email-marketing")).map((c) => c.id as string));
  const tickets = allTickets.filter((x) => emailClients.has(x.clientId) || (asked != null && x.number === asked));
  const clients = (clientRows ?? []).filter((c) => (servicesOf(c) as string[]).includes("email-marketing") || tickets.some((x) => x.clientId === c.id)).map((c) => ({ id: c.id as string, name: c.name as string, slug: c.slug as string }));
  const team = (people ?? []).filter((p) => p.is_exec || ["head_of_email", "email_strategist", "email_designer", "email_builder"].includes(p.role as string)).map((p) => ({ id: p.id as string, name: p.full_name as string, role: roleLabel(p.role as TeamRole) }));
  // The strategists, designers and builders open the board on their own work; the Head of Email and execs on everyone's
  const mine = !me.isExec && me.role !== "head_of_email";
  return (
    <DirectionFlagsProvider flags={flags}>
    <EmailBoardClient
      tickets={tickets}
      clients={clients}
      people={team}
      shadows={shadows}
      me={{ id: me.id, mine, lead }}
      tabs={
        switcher || lead ? (
          <>
            {switcher && <BoardSwitch active="email" />}
            {lead && <BoardTabs active="board" board="email" />}
          </>
        ) : null
      }
    />
    </DirectionFlagsProvider>
  );
}
