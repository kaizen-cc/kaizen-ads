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

// The AI review of a design runs after an upload, and the copy after a ticket is made
export const maxDuration = 300;

// The Email Board: every campaign batch and flow, where it's sitting and for how long. Execs see it beside the
// Creative Board (the switch); the email team works here only; everyone else goes to the Creative Board. Execs and the
// Head of Email also get its two KPI tabs (?view=kpis for the designers, ?view=copy-kpis for the copy), the way execs
// and leads get the Creative Board's; the strategists, designers and builders work on the Board itself.
export default async function EmailBoard({ searchParams }: PageProps<"/board/email">) {
  const { t, view, period } = await searchParams;
  const [me, db] = await Promise.all([requireStaff(), createClient()]);
  if (!seesEmailBoard(me)) redirect("/board");
  const lead = me.isExec || me.role === "head_of_email";
  const switcher = seesCreativeBoard(me);
  const p = period === "30" || period === "90" ? period : "cycle";
  if (view === "kpis" && lead) {
    const [{ cachedEmailDesignKpis }, { EmailDesignKpisView }] = await Promise.all([import("@/lib/board-kpis-cache"), import("./email-kpis")]);
    return <EmailDesignKpisView k={await cachedEmailDesignKpis(p)} canDismiss={lead} switcher={switcher} />;
  }
  if (view === "copy-kpis" && lead) {
    const [{ cachedEmailCopyKpis }, { EmailCopyKpisView }] = await Promise.all([import("@/lib/board-kpis-cache"), import("./email-copy-kpis")]);
    return <EmailCopyKpisView k={await cachedEmailCopyKpis(p)} switcher={switcher} />;
  }
  // Execs and the Head of Email: the KPI tabs worked out while they look at the Board, so switching to them is instant
  if (lead)
    after(async () => {
      const { cachedEmailDesignKpis, cachedEmailCopyKpis } = await import("@/lib/board-kpis-cache");
      await Promise.all([cachedEmailDesignKpis("cycle"), cachedEmailCopyKpis("cycle")]).catch(() => null);
    });
  const asked = typeof t === "string" && /^\d+$/.test(t) ? Number(t) : null;
  const [tickets, { data: clientRows }, { data: people }, shadows] = await Promise.all([
    loadEmailBoard(db, { number: asked }),
    db.from("clients").select("id, name, slug, services, services_extra, services_removed").is("archived_at", null).in("status", ["active", "onboarding"]).order("name"),
    db.from("profiles").select("id, full_name, role, is_exec").eq("is_active", true).order("full_name"),
    loadEmailShadows(db).catch(() => []),
  ]);
  const clients = (clientRows ?? []).filter((c) => (servicesOf(c) as string[]).includes("email-marketing") || tickets.some((x) => x.clientId === c.id)).map((c) => ({ id: c.id as string, name: c.name as string, slug: c.slug as string }));
  const team = (people ?? []).filter((p) => p.is_exec || ["head_of_email", "email_strategist", "email_designer", "email_builder"].includes(p.role as string)).map((p) => ({ id: p.id as string, name: p.full_name as string, role: roleLabel(p.role as TeamRole) }));
  // The strategists, designers and builders open the board on their own work; the Head of Email and execs on everyone's
  const mine = !me.isExec && me.role !== "head_of_email";
  return (
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
  );
}
