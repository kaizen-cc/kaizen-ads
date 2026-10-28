import type { CreativeDb } from "@/lib/creative-db";
import { loadClientKpis } from "@/lib/kpi/client";
import { loadWatchList } from "@/lib/fatigue";
import { loadClientMarket } from "@/lib/market";
import type { IntakeRecord } from "./intake-panel";
import type { ClientCall } from "./calls-panel";
import { notFound } from "next/navigation";
import type { Digest } from "@/lib/ai";
import { isExecOrLead, requireStaff, seesAllClients } from "@/lib/auth";
import { SLOTS, type TeamRole } from "@/lib/roles";
import { freshness, nyToday } from "@/lib/dates";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { loadClientCreative } from "@/lib/client-creative";
import { ClientView } from "./client-view";
import { latestAudits } from "@/lib/audit-summary";
import { changeKey, loadChanges } from "@/lib/account-changes";
import type { ShotList } from "@/lib/shot-list";
import { assetsStale } from "@/lib/client-assets";
import { loadSprints } from "@/lib/sprints";
import { reportableTargets } from "@/lib/reports/access";
import { loadClientChat } from "@/lib/client-chat";
import type { AuditTarget } from "./client-chat";
import { clientReadiness } from "@/lib/readiness";
import { loadCampaigns } from "@/lib/client-campaigns";
import { loadLedger } from "@/lib/ledger";
import type { HistoryReport } from "./reports-history";
import { monthLabel } from "@/lib/reports/format";

/** Went live again in the last two weeks (the readiness check stays up that long) */
const lately = (iso: string | null) => Boolean(iso && Date.now() - new Date(iso).getTime() < 14 * 86_400_000);

// Refreshing a briefing asks the AI to read everything new about the client
export const maxDuration = 800; // Sync now on the Meta ad account, and Brand Bible builds (web research) that finish in the background


export default async function ClientPage({ params, searchParams }: PageProps<"/clients/[slug]">) {
  const me = await requireStaff();
  const { slug } = await params;
  const supabase = await createClient();

  const { data: client } = await supabase
    .from("clients")
    .select(
      "id, name, slug, status, client_type, archived_at, archive_reason, archive_source, portal_live, portal_live_at, industry, industry_detail, industry_source, website, meta_ad_account_id, url_tags, slack_channel_id, internal_slack_channel_id, drive_folder_id, kaizen_id, auto_approve_opt_in, creative_package, creative_package_key, creative_package_until, creative_package_note, creative_db, reactivated_at, reactivated_by, services, services_extra, creative_packages(label)",
    )
    .eq("slug", slug)
    .maybeSingle();
  if (!client) notFound();

  const [{ data: assignments }, { data: links }, { data: angles }, { data: usage }, { data: staff }, { data: memory }, { data: briefing }, { data: slackSync }] =
    await Promise.all([
      supabase.from("client_assignments").select("role, profile_id, profiles(full_name)").eq("client_id", client.id),
      supabase.from("contact_clients").select("is_primary, contacts(id, email, full_name, auth_user_id)").eq("client_id", client.id),
      supabase.from("angles").select("id, name, kind, description, status").eq("client_id", client.id).order("status").order("name"),
      supabase.from("client_allotment_usage").select("*").eq("client_id", client.id).maybeSingle(),
      supabase.from("profiles").select("id, full_name, role").eq("is_active", true).order("full_name"),
      supabase.from("client_memory").select("id, kind, body, source, share_reason, created_at, dated, profiles(full_name)").eq("client_id", client.id).eq("status", "active").order("created_at", { ascending: false }),
      supabase.from("client_briefings").select("digest, generated_at, sources").eq("client_id", client.id).maybeSingle(),
      // Execs only (RLS): which of this client's Slack channels the bot couldn't get into on the last run
      supabase.from("sync_state").select("last_result").eq("source", "slack").maybeSingle(),
    ]);
  const { data: bibleRow } = await supabase
    .from("client_brand_bibles")
    .select("status, version, markdown, read_this_first, team_notes, open_questions, error, started_at, generated_at, reviewed_at, learnings, profiles!client_brand_bibles_reviewed_by_fkey(full_name)")
    .eq("client_id", client.id)
    .maybeSingle();
  const brandBible = bibleRow
    ? {
        status: bibleRow.status,
        version: bibleRow.version,
        markdown: bibleRow.markdown,
        readThisFirst: bibleRow.read_this_first,
        teamNotes: (bibleRow.team_notes ?? []) as string[],
        openQuestions: (bibleRow.open_questions ?? []) as { question: string; who: string }[],
        error: bibleRow.error,
        startedAt: bibleRow.started_at,
        generatedAt: bibleRow.generated_at,
        reviewedAt: bibleRow.reviewed_at,
        reviewedBy: (bibleRow.profiles as unknown as { full_name: string } | null)?.full_name ?? null,
        learnings: (bibleRow.learnings ?? []) as { at: string; kind: string; text: string }[],
      }
    : null;
  const { data: gtmRow } = await supabase
    .from("client_gtm_strategies")
    .select("status, missing, version, markdown, read_this_first, open_items, quality, error, started_at, generated_at, reviewed_at, profiles!client_gtm_strategies_reviewed_by_fkey(full_name)")
    .eq("client_id", client.id)
    .maybeSingle();
  const gtm = gtmRow
    ? {
        status: gtmRow.status,
        missing: (gtmRow.missing ?? []) as string[],
        version: gtmRow.version,
        markdown: gtmRow.markdown,
        readThisFirst: gtmRow.read_this_first,
        openItems: (gtmRow.open_items ?? []) as { item: string; who: string }[],
        quality: (gtmRow.quality ?? []) as { check: string; pass: boolean; note: string }[],
        error: gtmRow.error,
        startedAt: gtmRow.started_at,
        generatedAt: gtmRow.generated_at,
        reviewedAt: gtmRow.reviewed_at,
        reviewedBy: (gtmRow.profiles as unknown as { full_name: string } | null)?.full_name ?? null,
      }
    : null;
  const { data: packages } = await supabase.from("creative_packages").select("key, label, images, videos").neq("key", "custom").order("sort_order");
  const { data: allotment } = usage ? { data: null } : await supabase.from("client_allotments").select("images_per_month, videos_per_month").eq("client_id", client.id).maybeSingle();
  const images = usage?.images_per_month ?? allotment?.images_per_month ?? 0;
  const videos = usage?.videos_per_month ?? allotment?.videos_per_month ?? 0;

  const needsInvite = (((slackSync?.last_result as { needsInvite?: string[] } | null)?.needsInvite ?? []) as string[])
    .filter((x) => x.endsWith(`(${client.name})`))
    .map((x) => x.slice(0, -(client.name.length + 3)));
  const digest = briefing?.digest && Object.keys(briefing.digest).length ? (briefing.digest as Digest) : null;
  const packageLabel = (client.creative_packages as unknown as { label: string } | null)?.label;

  const currentIn = (slot: string) => {
    const a = (assignments ?? []).find((x) => x.role === slot);
    return a ? { id: a.profile_id, name: (a.profiles as unknown as { full_name: string } | null)?.full_name ?? "Unknown" } : null;
  };
  const optionsFor = (eligible: readonly TeamRole[]) =>
    (staff ?? []).filter((p) => eligible.includes(p.role as TeamRole)).map((p) => ({ id: p.id, name: p.full_name }));
  const contacts = (links ?? []).flatMap((l: { is_primary: boolean; contacts: unknown }) => {
    const c = l.contacts as { id: string; email: string; full_name: string | null; auth_user_id: string | null } | null;
    return c ? [{ ...c, isPrimary: l.is_primary }] : [];
  });

  // When each connection last synced. Sync bookmarks are server-side, so they're read with the server's rights (timestamps only)
  const keys = [client.slack_channel_id && `slack:${client.slack_channel_id}`, client.internal_slack_channel_id && `slack:${client.internal_slack_channel_id}`, client.drive_folder_id && `drive:${client.drive_folder_id}`].filter(Boolean) as string[];
  const [{ data: synced }, { data: lastMeta }] = await Promise.all([
    adminConfigured() && keys.length ? createAdminClient().from("sync_state").select("source, last_run_at").in("source", keys) : Promise.resolve({ data: [] as { source: string; last_run_at: string | null }[] }),
    supabase.from("meta_snapshots").select("fetched_at").eq("client_id", client.id).order("fetched_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const [creative, kpis, fatigue, { data: intakeRow }, { data: callRows }, marketAll] = await Promise.all([
    loadClientCreative(supabase, client.id),
    loadClientKpis(supabase, client.id),
    loadWatchList(supabase, { clientId: client.id }),
    supabase.from("client_intakes").select("received_at, status, summary, answers, error").eq("client_id", client.id).order("received_at", { ascending: false }).limit(1).maybeSingle(),
    supabase
      .from("call_mentions")
      .select("summary, client_calls!inner(id, source, title, occurred_at, url, status)")
      .eq("client_id", client.id)
      .order("occurred_at", { referencedTable: "client_calls", ascending: false })
      .limit(20),
    loadClientMarket(supabase, client.id, { limit: 200 }),
  ]);
  // In the market: the competitors this client named first, then what's proven, testing or new in their industry
  const seenBrand = new Set<string>();
  const market = marketAll.filter((a) => (seenBrand.has(a.brand) ? false : (seenBrand.add(a.brand), true))).slice(0, 8);
  // Every call that discussed this client (client calls and internal meetings), with what was said about them
  const callIds = (callRows ?? []).map((m) => (m.client_calls as unknown as { id: string }).id);
  const { data: promised } = callIds.length
    ? await supabase.from("call_commitments").select("id, call_id, kind, what, status, request_numbers, asana_gids").eq("client_id", client.id).in("call_id", callIds)
    : { data: [] };
  // Promises covered by a task in Asana link to it there
  const gids = [...new Set((promised ?? []).flatMap((x) => (x.asana_gids ?? []) as string[]))];
  const { data: asanaLinks } = gids.length ? await supabase.from("asana_tasks").select("gid, url").in("gid", gids) : { data: [] };
  const calls: ClientCall[] = (callRows ?? [])
    .map((m) => {
      const c = m.client_calls as unknown as { id: string; source: string; title: string; occurred_at: string; url: string | null; status: string };
      return {
        id: c.id,
        source: c.source as ClientCall["source"],
        title: c.status === "internal" ? `Internal: ${c.title}` : c.title,
        at: c.occurred_at,
        url: c.url,
        status: c.status,
        summary: (m.summary as ClientCall["summary"]) ?? null,
        commitments: (promised ?? []).filter((x) => x.call_id === c.id).map((x) => ({ id: x.id, kind: x.kind, what: x.what, status: x.status, requestNumbers: (x.request_numbers ?? []) as number[], asana: ((x.asana_gids ?? []) as string[]).map((g) => (asanaLinks ?? []).find((a) => a.gid === g)?.url).filter((u): u is string => Boolean(u)) })),
      };
    })
    .sort((a, b) => b.at.localeCompare(a.at));
  const intake: IntakeRecord | null = intakeRow
    ? { receivedAt: intakeRow.received_at, status: intakeRow.status, summary: (intakeRow.summary as IntakeRecord["summary"]) ?? null, answers: (intakeRow.answers ?? []) as IntakeRecord["answers"], error: intakeRow.error }
    : null;
  // The audits on this client's KPIs (the same ones the KPI board shows) and my thread with the AI
  const [auditBy, chatTurns] = await Promise.all([latestAudits(supabase, kpis.map((k) => k.id)), loadClientChat(supabase, client.id, me.id)]);
  const audits = Object.fromEntries(auditBy);
  // What's on their Drive to make creative from, and the latest shot list
  const count = (kind: string) => supabase.from("client_assets").select("file_id", { count: "exact", head: true }).eq("client_id", client.id).eq("kind", kind);
  const [{ count: imageCount }, { count: videoCount }, { count: designs }, { data: newestAsset }, { data: shot }] = await Promise.all([
    count("image"),
    count("video"),
    count("design"),
    supabase.from("client_assets").select("created_at").eq("client_id", client.id).in("kind", ["image", "video"]).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("shot_lists").select("id, list, created_at, sent_at").eq("client_id", client.id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const newest = newestAsset?.created_at ?? null;
  const assetGlance = { images: imageCount ?? 0, videos: videoCount ?? 0, designs: designs ?? 0, newest, stale: assetsStale(newest) };
  const shotList = shot ? { id: shot.id, list: shot.list as ShotList, createdAt: shot.created_at, sentAt: shot.sent_at } : null;
  // Each ad account's last 30 changes
  const changeBy = await loadChanges(supabase, kpis.filter((k) => k.accountId).map((k) => changeKey(k.platform, k.accountId!)), 30);
  const changes = Object.fromEntries(kpis.filter((k) => k.accountId).map((k) => [k.id, changeBy.get(changeKey(k.platform, k.accountId!)) ?? []]));
  const targets: AuditTarget[] = kpis
    .filter((k) => k.accountId)
    .map((k) => {
      const a = auditBy.get(k.id);
      return { id: k.id, label: `${k.platform === "google" ? "Google" : "Meta"}${k.label ? ` · ${k.label}` : ""}`, status: a?.status ?? "none", auditId: a?.id ?? null };
    });
  // The optimization sprint on each account, for the page's glance
  const sprintList = await loadSprints(supabase, { targetIds: kpis.map((k) => k.id) });
  const sprints = Object.fromEntries(sprintList.map((s) => [s.targetId, s.sprint]));
  // Which of these accounts this person can draft a report for
  const reportable = (await reportableTargets(supabase, me)).filter((t) => t.client_id === client.id).map((t) => t.id);
  const at = (key: string) => (synced ?? []).find((r) => r.source === key)?.last_run_at ?? null;
  const connections = {
    meta: client.meta_ad_account_id ? freshness(lastMeta?.fetched_at) : null,
    slackClient: client.slack_channel_id ? freshness(at(`slack:${client.slack_channel_id}`)) : null,
    slackInternal: client.internal_slack_channel_id ? freshness(at(`slack:${client.internal_slack_channel_id}`)) : null,
    drive: client.drive_folder_id ? freshness(at(`drive:${client.drive_folder_id}`)) : null,
  };

  // The readiness check: for two weeks after a client goes live again (or from the notification's link), execs and
  // leads see what's still missing; it opens by itself for whoever brought them back (the execs, when Track did)
  const asked = (await searchParams).ready === "1";
  const live = !client.archived_at && ["active", "onboarding"].includes(client.status);
  const readiness =
    live && isExecOrLead(me) && (asked || lately(client.reactivated_at))
      ? { initial: await clientReadiness(supabase, client.id), autoOpen: asked || client.reactivated_by === me.id || (!client.reactivated_by && me.isExec), stamp: client.reactivated_at ?? "asked" }
      : null;

  // What they buy, and each service's tier
  const [{ data: tierList }, { data: tierPicks }] = await Promise.all([
    supabase.from("service_tiers").select("id, service, label, includes").order("sort_order").order("created_at"),
    supabase.from("client_service_tiers").select("service, tier_id").eq("client_id", client.id),
  ]);

  // Where this client's new ads go, as their buyers taught the launcher
  const { data: ruleRows } = await supabase.from("launch_rules").select("id, rule, from_adset, to_adset, via, active, created_at, profiles(full_name)").eq("client_id", client.id).order("created_at", { ascending: false }).limit(30);
  const launchRules = (ruleRows ?? []).map((r) => ({
    id: r.id as string,
    rule: r.rule as string,
    from: (r.from_adset as { name?: string } | null)?.name ?? null,
    to: (r.to_adset as { name?: string } | null)?.name ?? null,
    via: r.via as string,
    by: (r.profiles as unknown as { full_name: string } | null)?.full_name ?? null,
    at: r.created_at as string,
    active: r.active as boolean,
  }));

  // Each platform's campaigns over the last 30 days (campaign tables are read with the server's rights)
  const campaigns = adminConfigured() ? await loadCampaigns(createAdminClient(), client.id).catch(() => []) : [];
  // Every file and link shared about them
  const { data: docRows } = await supabase
    .from("client_documents")
    .select("id, kind, name, url, path, mime, bytes, title, summary, status, note, via, created_at, profiles!client_documents_uploaded_by_fkey(full_name)")
    .eq("client_id", client.id)
    .order("created_at", { ascending: false })
    .limit(200);
  // Every report made for them: one row per report (a joint one's parts together)
  const { data: repRows } = await supabase
    .from("reports")
    .select("id, kind, platform, status, period_start, period_end, bundle_id, owner_id, posted_at, sections, metrics, profiles!reports_owner_id_fkey(full_name), report_bundles(status, sent_at, token, ranges)")
    .eq("client_id", client.id)
    .order("period_start", { ascending: false })
    .limit(300);
  type RepRow = { id: string; kind: HistoryReport["kind"]; platform: "meta" | "google"; status: string; period_start: string; period_end: string; bundle_id: string | null; owner_id: string | null; posted_at: string | null; sections: { headline?: string } | null; metrics: { main?: { label?: string } } | null; profiles: { full_name: string } | null; report_bundles: { status: string; sent_at: string | null; token: string; ranges: { label: string }[] | null } | null };
  const groups = new Map<string, RepRow[]>();
  for (const r of (repRows ?? []) as unknown as RepRow[]) groups.set(r.bundle_id ?? r.id, [...(groups.get(r.bundle_id ?? r.id) ?? []), r]);
  const reportHistory: HistoryReport[] = [...groups.values()].map((list): HistoryReport => {
    const live = list.filter((r) => r.status !== "skipped");
    const first = live[0] ?? list[0];
    const b = first.report_bundles;
    const sent = b?.status === "sent" || live.some((r) => r.status === "posted");
    return {
      id: (live.find((r) => r.owner_id === me.id) ?? first).id,
      kind: first.kind,
      period: first.kind === "built" && b?.ranges?.length ? b.ranges.map((x) => x.label).join(" + ") : first.kind === "monthly" ? monthLabel(first.period_start) : (first.metrics?.main?.label ?? `${first.period_start} – ${first.period_end}`),
      start: first.period_start,
      services: [...new Set(live.map((r) => r.platform))].sort() as ("meta" | "google")[],
      by: [...new Set(live.map((r) => r.profiles?.full_name).filter((x): x is string => Boolean(x)))],
      headline: live.map((r) => r.sections?.headline).filter(Boolean).join(" · ") || null,
      status: sent ? "sent" : !live.length ? "skipped" : b?.status === "failed" ? "failed" : "in_progress",
      sentAt: b?.sent_at ?? live.map((r) => r.posted_at).filter((x): x is string => Boolean(x)).sort().at(-1) ?? null,
      whole: first.kind === "built" && live.length > 1,
      link: sent && b?.token ? `/r/${b.token}` : null,
    };
  }).sort((a, b) => b.start.localeCompare(a.start));
  const docs = (docRows ?? []).map((d) => ({ id: d.id, kind: d.kind, name: d.name, url: d.url, path: d.path, mime: d.mime, bytes: d.bytes, title: d.title, summary: d.summary, status: d.status, note: d.note, via: d.via, at: d.created_at, by: (d.profiles as unknown as { full_name: string } | null)?.full_name ?? null }));

  return (
    <ClientView
      campaigns={campaigns}
      docs={docs}
      playbook={{ items: await loadLedger(supabase, client.id), learnings: ((await supabase.from("client_brand_bibles").select("learnings").eq("client_id", client.id).maybeSingle()).data?.learnings ?? []) as { at: string; kind: string; text: string }[] }}
      reports={reportHistory}
      launchRules={launchRules}
      readiness={readiness}
      services={{
        track: (client.services ?? []) as string[],
        extra: (client.services_extra ?? []) as string[],
        tiers: tierList ?? [],
        chosen: Object.fromEntries((tierPicks ?? []).filter((t) => t.tier_id).map((t) => [t.service as string, t.tier_id as string])),
      }}
      connections={connections}
      creative={creative}
      kpis={kpis}
      audits={audits}
      changes={changes}
      sprints={sprints}
      reportable={reportable}
      assets={assetGlance}
      shotList={shotList}
      chat={{ initial: chatTurns, targets }}
      fatigue={fatigue}
      market={market}
      intake={intake}
      calls={calls}
      client={client}
      packageLabel={packageLabel ?? null}
      packages={packages ?? []}
      brandBible={brandBible}
      gtm={gtm}
      today={nyToday()}
      team={Object.fromEntries(SLOTS.map((slot) => [slot.value, { current: currentIn(slot.value), options: optionsFor(slot.eligible) }]))}
      contacts={contacts}
      angles={angles ?? []}
      memory={(memory ?? []).map((m) => ({ id: m.id, kind: m.kind, body: m.body, source: m.source, shareReason: m.share_reason, dated: m.dated, by: (m.profiles as unknown as { full_name: string } | null)?.full_name ?? null }))}
      digest={digest}
      briefingAt={briefing?.generated_at ?? null}
      needsInvite={needsInvite}
      images={images}
      videos={videos}
      imagesUsed={usage?.images_used ?? 0}
      videosUsed={usage?.videos_used ?? 0}
      fromAsana={{ images: usage?.asana_images ?? 0, videos: usage?.asana_videos ?? 0, waitingImages: usage?.asana_waiting_images ?? 0, waitingVideos: usage?.asana_waiting_videos ?? 0 }}
      creativeDb={(client.creative_db as CreativeDb | null) ?? null}
      can={{ admin: me.isExec, contacts: seesAllClients(me), allot: me.isExec || me.isLead, assign: isExecOrLead(me) }}
    />
  );
}
