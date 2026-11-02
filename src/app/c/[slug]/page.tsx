import Link from "next/link";
import { notFound } from "next/navigation";
import { BrandSwitcher } from "@/components/brand-switcher";
import { getViewer } from "@/lib/auth";
import { loadPortal } from "@/lib/portal";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { Portal } from "./portal";

// A client's portal for one brand. Clients only get in once Kaizen switches the brand live; until then only the team
// can open it (to test the whole loop), with a banner saying so.
export default async function ClientHome({ params }: PageProps<"/c/[slug]">) {
  const { slug } = await params;
  const viewer = await getViewer();

  let db;
  if (viewer.kind === "contact") {
    // viewer.brands only holds live brands
    if (!viewer.brands.some((b) => b.slug === slug) || !adminConfigured()) notFound();
    db = createAdminClient();
  } else {
    db = await createClient(); // the team's own access rules
  }

  const { data: client } = await db.from("clients").select("id, name, slug, portal_live, status, services").eq("slug", slug).maybeSingle();
  if (!client || (viewer.kind === "contact" && !client.portal_live)) notFound();

  const data = await loadPortal(db, client.id);
  // A new client still setting up: their guide, first
  let setup: { done: number; total: number } | null = null;
  if (client.status === "onboarding" && adminConfigured()) {
    const [{ loadGuide }, { guideProgress }] = await Promise.all([import("@/lib/onboarding-guide"), import("@/lib/onboarding-guide-types")]);
    const p = guideProgress(await loadGuide(createAdminClient(), client.id), ((client.services ?? []) as string[]).includes("google-ads"));
    if (p.done < p.total) setup = p;
  }
  const brands = viewer.kind === "contact" ? viewer.brands : [{ name: client.name, slug: client.slug }];
  const firstName = viewer.kind === "contact" ? (viewer.fullName?.split(" ")[0] ?? null) : null;

  return (
    <div className="min-h-screen">
      <header className="pt-safe sticky top-0 z-20 border-b border-line bg-bg/90 backdrop-blur">
        <div className="mx-auto flex max-w-md items-center justify-between gap-3 px-4 py-2.5">
          <BrandSwitcher current={{ name: client.name, slug: client.slug }} brands={brands} />
          <span className="flex shrink-0 items-center gap-3">
            {viewer.kind === "staff" ? (
              <Link href={`/clients/${client.slug}`} className="text-xs text-muted hover:text-fg max-md:inline-flex max-md:min-h-11 max-md:items-center">
                Back to the client
              </Link>
            ) : (
              <form action="/auth/signout" method="post">
                <button className="text-xs text-muted hover:text-fg max-md:min-h-11">Sign out</button>
              </form>
            )}
            <span className="rounded-full bg-surface-2 px-2.5 py-1 text-[11px] text-muted">Kaizen</span>
          </span>
        </div>
      </header>
      {setup && (
        <div className="mx-auto max-w-md px-4 pt-4">
          <Link href={`/c/${client.slug}/start`} className="flex items-center gap-3 rounded-[18px] border border-brand/40 bg-brand/[0.07] p-4">
            <span className="tabular grid h-11 w-11 shrink-0 place-items-center rounded-full bg-brand text-[13px] font-semibold text-white">
              {setup.done}/{setup.total}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-heading text-[15.5px]">Finish getting set up</span>
              <span className="block text-[12.5px] text-muted">A few quick steps so we can start building your ads</span>
            </span>
            <span className="text-[13px] text-brand-text">→</span>
          </Link>
        </div>
      )}
      <Portal slug={client.slug} clientName={client.name} firstName={firstName} data={data} testing={viewer.kind === "staff"} live={client.portal_live} />
    </div>
  );
}
