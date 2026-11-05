import type { Metadata } from "next";
import Link from "next/link";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import type { NoticeKind } from "@/lib/notice-links";
import { whoActs, type Ref } from "./who";
import { HandledForm } from "./handled-form";

export const metadata: Metadata = { title: "It's handled", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * Closing a chase from its notice: the buttons in a promise or unanswered-message email (a signed link, no sign-in),
 * or the same buttons on the bell and in your day (signed in). Opening it does nothing on its own (mail scanners open
 * links); the person marks it handled or says what's missing here.
 */
export default async function HandledPage({ searchParams }: PageProps<"/handled">) {
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const ref: Ref = one(sp.t) ? { t: one(sp.t) } : { kind: one(sp.k) as NoticeKind, id: one(sp.id) };
  const mode = one(sp.do) === "context" ? "context" : "done";
  const who = adminConfigured() ? await whoActs(ref) : null;
  if (!who) {
    return (
      <Shell>
        <h1 className="font-heading text-[22px] leading-tight">This link has expired</h1>
        <p className="text-sm leading-relaxed text-muted">Links in notice emails work for two weeks, for the person they went to. Open it from the bell in Kaizen Ads instead.</p>
        <Link href="/pipeline" className="inline-flex h-11 w-full items-center justify-center rounded-brand bg-fg px-4 text-sm font-medium text-bg sm:w-auto">
          Open Kaizen Ads
        </Link>
      </Shell>
    );
  }
  const admin = createAdminClient();
  const { loadNotice } = await import("@/lib/notice-resolve");
  const [view, { data: clients }] = await Promise.all([loadNotice(admin, who.kind, who.id, who.profileId), admin.from("clients").select("id, name, status").is("archived_at", null).neq("status", "offboarded").order("name").limit(500)]);
  if (!view) {
    return (
      <Shell>
        <h1 className="font-heading text-[22px] leading-tight">It isn&apos;t there any more</h1>
        <p className="text-sm text-muted">Nothing left to do here.</p>
      </Shell>
    );
  }
  return (
    <Shell>
      <HandledForm
        refx={ref}
        mode={mode}
        view={view}
        clients={(clients ?? []).map((c) => ({ value: c.id as string, label: c.name as string, hint: c.status === "onboarding" ? "Onboarding" : undefined }))}
      />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-bg px-4 py-10 pt-[max(2.5rem,env(safe-area-inset-top))] pb-[max(2.5rem,env(safe-area-inset-bottom))] text-fg">
      <div className="grid w-full max-w-[480px] gap-5">
        <p className="font-display text-[22px] leading-none text-brand-text">ads</p>
        <section className="grid gap-4 rounded-[18px] border border-line bg-surface p-5 shadow-[var(--lift-3)] sm:p-7">{children}</section>
      </div>
    </main>
  );
}
