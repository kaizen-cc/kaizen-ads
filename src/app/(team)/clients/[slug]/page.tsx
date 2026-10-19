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

// Refreshing a briefing asks the AI to read everything new about the client
export const maxDuration = 800; // Sync now on the Meta ad account, and Brand Bible builds (web research) that finish in the background


export default async function ClientPage({ params }: PageProps<"/clients/[slug]">) {
  const me = await requireStaff();
  const { slug } = await params;
  const supabase = await createClient();

  const { data: client } = await supabase
    .from("clients")
    .select(
      "id, name, slug, status, client_type, archived_at, archive_reason, archive_source, portal_live, portal_live_at, industry, industry_detail, industry_source, website, meta_ad_account_id, slack_channel_id, internal_slack_channel_id, drive_folder_id, kaizen_id, auto_approve_opt_in, creative_package, creative_package_key, creative_package_until, creative_package_note, creative_db, creative_packages(label)",
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
      supabase.from("client_memory").select("id, kind, body, source, share_reason, created_at, profiles(full_name)").eq("client_id", client.id).eq("status", "active").order("created_at", { ascending: false }),
      supabase.from("client_briefings").select("digest, generated_at, sources").eq("client_id", client.id).maybeSingle(),
      // Execs only (RLS): which of this client's Slack channels the bot couldn't get into on the last run
      supabase.from("sync_state").select("last_result").eq("source", "slack").maybeSingle(),
    ]);
  const { data: bibleRow } = await supabase
    .from("client_brand_bibles")
    .select("status, version, markdown, read_this_first, team_notes, open_questions, error, started_at, generated_at, reviewed_at, profiles!client_brand_bibles_reviewed_by_fkey(full_name)")
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
  const at = (key: string) => (synced ?? []).find((r) => r.source === key)?.last_run_at ?? null;
  const connections = {
    meta: client.meta_ad_account_id ? freshness(lastMeta?.fetched_at) : null,
    slackClient: client.slack_channel_id ? freshness(at(`slack:${client.slack_channel_id}`)) : null,
    slackInternal: client.internal_slack_channel_id ? freshness(at(`slack:${client.internal_slack_channel_id}`)) : null,
    drive: client.drive_folder_id ? freshness(at(`drive:${client.drive_folder_id}`)) : null,
  };

  return (
    <ClientView
      connections={connections}
      creative={creative}
      kpis={kpis}
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
      memory={(memory ?? []).map((m) => ({ id: m.id, kind: m.kind, body: m.body, source: m.source, shareReason: m.share_reason, by: (m.profiles as unknown as { full_name: string } | null)?.full_name ?? null }))}
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
