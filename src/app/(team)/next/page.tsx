import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { greetingFor, todayLabel } from "@/lib/dates";
import { loadNextForMe } from "@/lib/next-for-me";
import { createClient } from "@/lib/supabase/server";
import { NextList } from "./next-list";

export const metadata: Metadata = { title: "Next for me" };

/** Everything on you: tickets, decisions, your accounts. Team members and leads; execs have the Overview. */
export default async function NextForMe() {
  const me = await requireStaff();
  if (me.isExec) redirect("/pipeline");
  const data = await loadNextForMe(await createClient(), me);
  const now = new Date();
  const first = me.fullName.split(" ")[0];
  const n = data.now.length + data.decide.length;
  return (
    <div className="mx-auto grid max-w-4xl gap-6">
      <header className="grid gap-1.5">
        <p className="text-xs uppercase tracking-[0.18em] text-faint">{todayLabel(now)}</p>
        <h1 className="font-display text-3xl tracking-tight md:text-4xl">
          {greetingFor(now)}, {first}
        </h1>
        <p className="text-sm text-muted">{n ? `${n} ${n === 1 ? "thing needs" : "things need"} you. Here's everything that's next, in one place.` : "Here's everything that's next for you, in one place."}</p>
      </header>
      <NextList data={data} />
    </div>
  );
}
