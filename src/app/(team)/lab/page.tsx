import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { aiEnabled } from "@/lib/ai";
import { isExecOrLead, requireStaff } from "@/lib/auth";
import { industryLabel } from "@/lib/industries";
import { cprChange, numbersFrom, windowSince, type ClientNumbers, type Metric, type ProposedTest, type Seat } from "@/lib/lab";
import { createClient } from "@/lib/supabase/server";
import { LabClient, type LabClientRow, type LabMessage, type LabSource, type LabTest } from "./lab-client";

export const metadata: Metadata = { title: "Ads Lab" };

// The table can take a minute to think, and reading a link searches the web
export const maxDuration = 300;

export default async function Lab({ searchParams }: PageProps<"/lab">) {
  const me = await requireStaff();
  if (!isExecOrLead(me)) redirect("/pipeline");
  const { t, tab } = await searchParams;
  const db = await createClient();

  const [{ data: threads }, { data: sources }, { data: tests }, { data: clients }, { data: kpis }, { data: labSuggestions }] = await Promise.all([
    db.from("lab_threads").select("id, title, updated_at").order("updated_at", { ascending: false }).limit(50),
    db.from("lab_sources").select("id, kind, title, url, summary, status, created_at, body").order("created_at", { ascending: false }).limit(200),
    db.from("lab_tests").select("*").neq("status", "dropped").order("created_at", { ascending: false }).limit(200),
    db.from("clients").select("id, name, slug, industry, industry_detail").neq("status", "offboarded").order("name"),
    db.from("kpi_snapshots").select("client_id, windows"),
    db.from("creative_suggestions").select("lab_test_id, client_id, status, request_numbers").not("lab_test_id", "is", null),
  ]);

  const threadId = typeof t === "string" ? t : null;
  const { data: messages } = threadId
    ? await db.from("lab_messages").select("id, role, agent, body, data, created_at, profiles(full_name)").eq("thread_id", threadId).order("created_at")
    : { data: [] };

  const rows = (kpis ?? []) as { client_id: string; windows: unknown }[];
  const spend30 = numbersFrom(rows, (clients ?? []).map((c) => c.id), "d30");
  const clientRows: LabClientRow[] = (clients ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    industry: c.industry_detail ?? (c.industry ? industryLabel(c.industry) : null) ?? null,
    spend30: Math.round(spend30[c.id]?.spend ?? 0),
  }));

  const testRows: LabTest[] = (tests ?? []).map((x) => {
    const ids = x.client_ids as string[];
    const live = x.status === "running" ? numbersFrom(rows, ids, windowSince(x.started_at)) : (x.result as Record<string, ClientNumbers>);
    const base = x.baseline as Record<string, ClientNumbers>;
    const deployed = x.deployed_to as string[];
    const deployBase = x.deploy_baseline as Record<string, ClientNumbers>;
    const deployNow = numbersFrom(rows, deployed, "d14");
    const sugg = (labSuggestions ?? []).filter((s) => s.lab_test_id === x.id);
    return {
      id: x.id,
      threadId: x.thread_id,
      title: x.title,
      hypothesis: x.hypothesis,
      change: x.change,
      metric: x.metric as Metric,
      success: x.success,
      targetLift: Number(x.target_lift),
      status: x.status,
      startedAt: x.started_at,
      endsAt: x.ends_at,
      verdict: x.verdict_note,
      learning: x.learning,
      createdAt: x.created_at,
      clients: ids.map((id) => ({ id, before: base[id] ?? null, now: live?.[id] ?? null, change: cprChange(base[id], live?.[id]) })),
      briefs: { waiting: sugg.filter((s) => s.status === "open").length, approved: sugg.filter((s) => s.status === "approved").length, tickets: sugg.flatMap((s) => s.request_numbers as number[]) },
      deployed: deployed.map((id) => ({ id, change: cprChange(deployBase[id], deployNow[id]) })),
      deployedAt: x.deployed_at,
    };
  });

  return (
    <LabClient
      threads={(threads ?? []).map((x) => ({ id: x.id, title: x.title, updatedAt: x.updated_at }))}
      threadId={threadId}
      messages={(messages ?? []).map(
        (m): LabMessage => ({
          id: m.id,
          role: m.role as "user" | "agent",
          seat: (m.agent as Seat | null) ?? null,
          author: (m.profiles as unknown as { full_name: string } | null)?.full_name ?? null,
          body: m.body,
          tests: ((m.data as { tests?: ProposedTest[] } | null)?.tests ?? []) as ProposedTest[],
          at: m.created_at,
        }),
      )}
      sources={(sources ?? []).map(
        (s): LabSource => ({ id: s.id, kind: s.kind, title: s.title, url: s.url, summary: s.summary, status: s.status, at: s.created_at, words: s.body ? s.body.split(/\s+/).length : 0 }),
      )}
      tests={testRows}
      clients={clientRows}
      tab={tab === "tests" || tab === "library" ? tab : "table"}
      aiOn={aiEnabled()}
    />
  );
}
