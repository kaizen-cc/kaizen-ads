import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { loadStepins } from "@/lib/stepins/act";
import { StepinsHero, StepinCardView } from "@/components/stepins/deck";
import { stepinPeople } from "@/components/stepins/section";

export const metadata: Metadata = { title: "Step-ins" };

// The executives' step-ins, the whole of it: this week's accounts where an exec needs to step in (in their focus lines,
// plus fires for everyone), as the deck and story mode, and the ones handled this week under it. src/lib/stepins.

export default async function StepinsPage() {
  const me = await requireStaff();
  if (!me.isExec) redirect("/pipeline");
  const db = await createClient();
  const [cards, people] = await Promise.all([loadStepins(db, me, { status: "all" }), stepinPeople(db)]);
  const handled = cards.filter((c) => c.status === "handled");
  return (
    <div className="mx-auto grid max-w-6xl gap-6 md:gap-8">
      <StepinsHero cards={cards} people={people} canRefresh />
      {handled.length > 0 && (
        <section className="grid gap-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Handled · reopens if it slides again</h2>
          <div className="grid gap-3 md:grid-cols-2">
            {handled.map((c) => (
              <StepinCardView key={c.id} s={c} people={people} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
