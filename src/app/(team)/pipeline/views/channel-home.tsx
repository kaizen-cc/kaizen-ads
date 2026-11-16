import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { servicesOf } from "@/lib/services";
import { roleLabel, type TeamRole, type lineOfTeam } from "@/lib/roles";
import { PageHeader } from "./shared";

type Line = NonNullable<ReturnType<typeof lineOfTeam>>;
const SERVICE: Record<Line, string> = { email: "email-marketing", social: "social-media" };

/**
 * Overview for the email and organic social teams: their clients (the ones they hold a seat on, or for a head every
 * client with their service) and a note that their KPIs and reports are coming. It reads nothing from the ad tables,
 * so it can't fail on data the team doesn't have.
 */
export async function ChannelHome({ me, line, today, greeting, firstName }: { me: { id: string; role: TeamRole }; line: Line; today: string; greeting: string; firstName: string }) {
  const db = await createClient();
  const [{ data }, { data: seats }] = await Promise.all([
    db.from("clients").select("id, name, slug, status, services, services_extra, services_removed").is("archived_at", null).neq("status", "offboarded").order("name"),
    db.from("client_assignments").select("client_id, role").eq("profile_id", me.id),
  ]);
  const mine = new Map<string, string[]>();
  for (const s of seats ?? []) mine.set(s.client_id as string, [...(mine.get(s.client_id as string) ?? []), s.role as string]);
  // Only clients that buy their service (the database already limits the list to their own)
  const clients = (data ?? []).filter((c) => servicesOf(c).includes(SERVICE[line] as never));
  const channel = line === "social" ? "Social" : "Email";
  return (
    <div className="mx-auto grid max-w-4xl gap-8">
      <PageHeader today={today} title={`${greeting}, ${firstName}`} subtitle={`${roleLabel(me.role)} · ${clients.length} ${clients.length === 1 ? "client" : "clients"}`} />
      <section className="grid gap-3">
        <h2 className="font-heading text-lg">Your clients</h2>
        {clients.length ? (
          <ul className="grid gap-2 sm:grid-cols-2">
            {clients.map((c) => (
              <li key={c.id as string}>
                <Link href={`/clients/${c.slug}`} className="flex min-h-14 items-center justify-between gap-3 rounded-[14px] border border-line bg-surface px-4 py-3 transition-colors hover:border-faint/70">
                  <span className="min-w-0 truncate font-medium">{c.name}</span>
                  <span className="shrink-0 text-xs capitalize text-faint">{(mine.get(c.id as string) ?? []).length ? "On your seat" : c.status}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-[14px] border border-dashed border-line px-4 py-6 text-sm text-faint">No clients yet. They show up here once you hold a seat on one.</p>
        )}
      </section>
      <section className="rounded-[14px] border border-line bg-surface px-5 py-4">
        <p className="text-sm font-medium">{channel} KPIs and reports are coming</p>
        <p className="mt-1 text-sm text-muted">Your daily recap and each client&apos;s {channel.toLowerCase()} numbers arrive in the next step. For now, open a client to see the {channel} panel, their Brand Bible, calls and notes.</p>
      </section>
    </div>
  );
}
