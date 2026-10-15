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

  const { data: client } = await db.from("clients").select("id, name, slug, portal_live").eq("slug", slug).maybeSingle();
  if (!client || (viewer.kind === "contact" && !client.portal_live)) notFound();

  const data = await loadPortal(db, client.id);
  const brands = viewer.kind === "contact" ? viewer.brands : [{ name: client.name, slug: client.slug }];
  const firstName = viewer.kind === "contact" ? (viewer.fullName?.split(" ")[0] ?? null) : null;

  return (
    <div className="min-h-screen">
      <header className="pt-safe sticky top-0 z-20 border-b border-line bg-bg/90 backdrop-blur">
        <div className="mx-auto flex max-w-md items-center justify-between gap-3 px-4 py-2.5">
          <BrandSwitcher current={{ name: client.name, slug: client.slug }} brands={brands} />
          <span className="flex shrink-0 items-center gap-3">
            {viewer.kind === "staff" ? (
              <Link href={`/clients/${client.slug}`} className="text-xs text-muted hover:text-fg">
                Back to the client
              </Link>
            ) : (
              <form action="/auth/signout" method="post">
                <button className="text-xs text-muted hover:text-fg">Sign out</button>
              </form>
            )}
            <span className="rounded-full bg-surface-2 px-2.5 py-1 text-[11px] text-muted">Kaizen</span>
          </span>
        </div>
      </header>
      <Portal slug={client.slug} clientName={client.name} firstName={firstName} data={data} testing={viewer.kind === "staff"} live={client.portal_live} />
    </div>
  );
}
