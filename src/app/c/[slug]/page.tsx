import Link from "next/link";
import { notFound } from "next/navigation";
import { BrandSwitcher } from "@/components/brand-switcher";
import { getViewer } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

// A client's home for one brand. Sections fill in as requests and approvals arrive (Phase 2–3).
export default async function ClientHome({ params }: PageProps<"/c/[slug]">) {
  const { slug } = await params;
  const viewer = await getViewer();
  const supabase = await createClient();

  // RLS: contacts only see their own brands; team members see clients they work on.
  const { data: client } = await supabase.from("clients").select("id, name, slug").eq("slug", slug).maybeSingle();
  if (!client) notFound();

  const { data: allotment } = await supabase
    .from("client_allotments")
    .select("images_per_month, videos_per_month")
    .eq("client_id", client.id)
    .maybeSingle();

  const brands = viewer.kind === "contact" ? viewer.brands : [{ name: client.name, slug: client.slug }];
  const firstName = viewer.kind === "contact" ? viewer.fullName?.split(" ")[0] : null;

  return (
    <div className="min-h-screen">
      {viewer.kind === "staff" && (
        <div className="bg-brand px-4 py-2 text-center text-xs text-white">
          You&apos;re previewing {client.name}&apos;s portal as a Kaizen team member.{" "}
          <Link href={`/clients/${client.slug}`} className="underline">
            Back to the client
          </Link>
        </div>
      )}
      <header className="pt-safe sticky top-0 z-20 border-b border-line bg-surface">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-3 px-4 py-3">
          <BrandSwitcher current={{ name: client.name, slug: client.slug }} brands={brands} />
          <span className="flex shrink-0 items-center gap-3">
            <span className="rounded-full bg-surface-2 px-2.5 py-1 text-[11px] text-muted">Kaizen</span>
            {viewer.kind === "contact" && (
              <form action="/auth/signout" method="post">
                <button className="text-xs text-muted hover:text-fg">Sign out</button>
              </form>
            )}
          </span>
        </div>
      </header>

      <main className="mx-auto grid max-w-2xl gap-5 px-4 py-6">
        <section className="grid gap-2 rounded-xl bg-brand p-5 text-white">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-white/75">Waiting on you</p>
          <h1 className="font-heading text-xl leading-tight">
            {firstName ? `You're all caught up, ${firstName}` : "You're all caught up"}
          </h1>
          <p className="text-sm text-white/90">When your Kaizen team sends new ads, they&apos;ll show up here and we&apos;ll email you a link.</p>
        </section>

        <Section title="In revision" note="Changes you asked for that we're working on.">
          <Empty>Nothing in revision.</Empty>
        </Section>

        <Section title="Running now" note="Previews of your live ads.">
          <Empty>Your live ads will appear here.</Empty>
        </Section>

        <Section title="Approved · launching soon">
          <Empty>Nothing waiting to launch.</Empty>
        </Section>

        {(allotment?.images_per_month || allotment?.videos_per_month) ? (
          <Section title="Your monthly creative">
            <p className="text-sm text-muted">
              {allotment.images_per_month} images · {allotment.videos_per_month} videos per month
            </p>
          </Section>
        ) : null}
      </main>
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">{title}</h2>
        {note && <span className="text-xs text-faint">{note}</span>}
      </div>
      {children}
    </section>
  );
}

const Empty = ({ children }: { children: React.ReactNode }) => (
  <p className="rounded-brand border border-dashed border-line px-4 py-5 text-center text-sm text-faint">{children}</p>
);
