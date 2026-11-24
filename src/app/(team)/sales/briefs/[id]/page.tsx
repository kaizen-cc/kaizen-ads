import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { cleanCallBrief } from "@/lib/sales-briefs-core";
import { getBrief } from "@/lib/sales-briefs";
import { worksSales } from "@/lib/sales-core";
import { BriefView } from "./brief-view";

export const metadata: Metadata = { title: "Sales call brief" };
// "Refresh the brief" re-researches and rewrites it (a minute or two)
export const maxDuration = 300;

// One sales call's brief: for whoever runs the call (their own only), and for the execs and leads.

export default async function BriefPage({ params }: PageProps<"/sales/briefs/[id]">) {
  const me = await requireStaff();
  const { id } = await params;
  const db = await createClient();
  const row = await getBrief(db, id);
  if (!row || (row.owner_id !== me.id && !worksSales(me))) notFound();
  const { data: prospect } = row.prospect_id ? await db.from("prospects").select("id, name, website, status").eq("id", row.prospect_id).maybeSingle() : { data: null };
  const { data: runner } = row.owner_id ? await db.from("profiles").select("full_name").eq("id", row.owner_id).maybeSingle() : { data: null };
  return (
    <BriefView
      row={{ id: row.id, title: row.title, startsAt: row.starts_at, endsAt: row.ends_at, status: row.status, link: row.html_link, guests: row.attendees, error: row.error, madeAt: row.made_at }}
      brief={row.brief ? { ...cleanCallBrief(row.brief, { booking: row.brief.booking, in_motion: row.brief.in_motion }), business: row.brief.business ?? row.title, site: row.brief.site ?? null } : null}
      prospect={prospect && worksSales(me) ? { id: prospect.id as string, name: prospect.name as string, website: (prospect.website as string | null) ?? null, status: prospect.status as string } : null}
      runner={(runner?.full_name as string | undefined) ?? null}
      mine={row.owner_id === me.id}
      sells={worksSales(me)}
    />
  );
}
