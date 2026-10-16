import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadPlaybook, playbookExamples, type Playbook } from "@/lib/playbooks";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import type { Benchmark } from "@/lib/verticals";
import { BenchmarkStrip, PlaybookView, type Example } from "../../(team)/ideas/playbook-view";

export const metadata: Metadata = { title: "Kaizen playbook", robots: { index: false, follow: false } };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The shareable playbook, for sales: no sign-in, and no client, brand or person names anywhere. The AI writes it
 * name-free; this also scrubs every client and brand name we know of, in case one slipped into the ad copy.
 */
export default async function SharedPlaybook({ params }: PageProps<"/p/[token]">) {
  const { token } = await params;
  if (!adminConfigured() || !/^[\w-]{12,40}$/.test(token)) notFound();
  const admin = createAdminClient();
  const { data: row } = await admin.from("vertical_playbooks").select("vertical_id").eq("share_token", token).maybeSingle();
  if (!row) notFound();
  const [{ data: sub }, playbook, { data: clients }, { data: brands }] = await Promise.all([
    admin.from("verticals").select("name, benchmarks, verticals!verticals_parent_id_fkey(name)").eq("id", row.vertical_id).single(),
    loadPlaybook(admin, row.vertical_id),
    admin.from("clients").select("name"),
    admin.from("market_brands").select("name"),
  ]);
  if (!sub || !playbook) notFound();

  const names = [...(clients ?? []), ...(brands ?? [])]
    .map((x) => String(x.name ?? "").trim())
    .filter((n) => n.length >= 3)
    .sort((a, b) => b.length - a.length)
    .map((n) => new RegExp(`\\b${escape(n)}\\b`, "gi"));
  const scrub = (s: string) => names.reduce((t, re) => t.replace(re, "a local brand"), s);
  const safe: Playbook = JSON.parse(scrub(JSON.stringify(playbook)));
  const raw = await playbookExamples(admin, playbook);
  const examples = new Map<string, Example>([...raw].map(([k, e]) => [k, { ...e, name: "", href: null, headline: e.headline ? scrub(e.headline) : null }]));

  return (
    <main className="min-h-screen bg-bg px-4 py-12 md:px-8 md:py-16">
      <PlaybookView
        title={sub.name}
        parent={(sub.verticals as unknown as { name: string } | null)?.name ?? null}
        playbook={{ ...safe, shareToken: null }}
        examples={examples}
        named={false}
        benchmarks={<BenchmarkStrip benchmarks={(sub.benchmarks ?? []) as Benchmark[]} />}
        actions={<p className="font-heading text-sm tracking-tight text-muted">Kaizen Marketing</p>}
      />
    </main>
  );
}
