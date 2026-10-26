import Link from "next/link";
import type { WatchRow } from "@/lib/fatigue";
import { FatigueWatch } from "@/components/fatigue-watch";
import type { CallPromise, OnboardingState, SuggestionsState } from "@/lib/suggestions";
import { CallPromises } from "./call-promises";
import { OnboardingCallout } from "./onboarding-callout";
import { SuggestedBriefs } from "./suggested-briefs";
import { AttentionList, ClientHealth, KpiPulse, type Alert, type ClientPulse, type KpiPulseData } from "./shared";
import type { Theme } from "./themes";
import { ProductionPanel } from "@/components/production";
import type { Production } from "@/lib/production";
import { Topic, type TopicTile } from "./topics";

// The topics execs and leads share on the Overview, each with its tile (what's in it, at a glance) and its panel
// (the detail to act on). Only topics with something in them are shown; what's all clear is said in one line.

export type SharedTopics = {
  onboarding?: OnboardingState | null;
  callPromises?: CallPromise[] | null;
  suggestions?: SuggestionsState | null;
  kpis?: KpiPulseData[] | null; // one per service line the viewer works on (Meta, Google)
  fatigue?: WatchRow[] | null;
  attention: Alert[];
  clients?: ClientPulse[];
  monthElapsed?: number;
  clientOptions?: { id: string; name: string }[];
};

type Built = { tile: TopicTile | null; panel: React.ReactNode; clear?: string };
const s = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });

export function actTopics(d: SharedTopics): Built[] {
  const out: Built[] = [];

  const promises = d.callPromises ?? [];
  if (promises.length) {
    const oldest = promises.map((p) => p.dueAt).sort()[0];
    const summary = `Said on calls, nothing in production yet · oldest was due ${day(oldest)}`;
    out.push({
      tile: { id: "promises", label: "Promised", value: promises.length, sub: "on calls, not started", tone: "warn" },
      panel: (
        <Topic key="promises" id="promises" title="Promised on calls" summary={summary} count={promises.length} tone="warn">
          <CallPromises promises={promises} bare />
        </Topic>
      ),
    });
  } else if (d.callPromises) out.push({ tile: null, panel: null, clear: "every promise from calls is in motion" });

  const briefs = d.suggestions?.open ?? [];
  if (d.suggestions && (briefs.length || d.suggestions.running)) {
    const clients = new Set(briefs.map((b) => b.client)).size;
    out.push({
      tile: { id: "briefs", label: "Briefs", value: briefs.length, sub: briefs.length ? `ideas across ${s(clients, "client")}` : "being written", tone: "quiet" },
      panel: (
        <Topic key="briefs" id="briefs" title="Suggested briefs" summary={briefs.length ? `Ideas the strategist wrote from what it saw in ${s(clients, "account")}: use, edit or pass` : "The strategist is reading every account"} count={briefs.length} tone="quiet">
          <SuggestedBriefs state={d.suggestions} bare />
        </Topic>
      ),
    });
  } else if (d.suggestions) out.push({ tile: null, panel: null, clear: "no briefs waiting on a decision" });

  const onboarding = d.onboarding;
  const starting = onboarding?.clients ?? [];
  if (onboarding && (starting.length || onboarding.unmatched.length)) {
    const ready = starting.filter((c) => c.firstRound).length;
    const notSetUp = starting.filter((c) => c.setup && Object.values(c.setup.steps).some((v) => !v)).length;
    const bits = [ready ? `${s(ready, "first round")} ready for you` : null, notSetUp ? `${notSetUp} still being set up` : null, onboarding.unmatched.length ? `${s(onboarding.unmatched.length, "intake form")} to match` : null].filter(Boolean);
    out.push({
      tile: { id: "onboarding", label: "Onboarding", value: starting.length, sub: ready ? `${ready} first round${ready === 1 ? "" : "s"} ready` : "clients getting started", tone: ready ? "brand" : "quiet" },
      panel: (
        <Topic key="onboarding" id="onboarding" title="Clients getting started" summary={bits.join(" · ") || "Where each new client is: setup, intake, first round, production"} count={starting.length} tone={ready ? "brand" : "quiet"}>
          <OnboardingCallout state={onboarding} clients={d.clientOptions ?? []} bare />
        </Topic>
      ),
    });
  }

  if (d.attention.length) {
    const bad = d.attention.filter((a) => a.tone === "bad").length;
    const kinds = [...new Set(d.attention.map((a) => a.kind.toLowerCase()))].slice(0, 3).join(", ");
    out.push({
      tile: { id: "attention", label: "Attention", value: d.attention.length, sub: bad ? `${bad} urgent` : kinds, tone: bad ? "bad" : "warn" },
      panel: (
        <Topic key="attention" id="attention" title="Needs attention" summary={`Worst first: ${kinds}`} count={d.attention.length} tone={bad ? "bad" : "warn"}>
          <AttentionList alerts={d.attention} empty="" />
        </Topic>
      ),
    });
  } else out.push({ tile: null, panel: null, clear: "nothing stuck" });

  return out;
}

export function accountTopics(d: SharedTopics): Built[] {
  const out: Built[] = [];

  // Each service line on its own: a client whose Google is fine still shows its Meta account off target
  for (const k of d.kpis ?? []) {
    if (!k.accounts) continue;
    const name = k.platform === "google" ? "Google" : k.platform === "meta" ? "Meta" : "Ad";
    const id = `kpis-${k.platform}`;
    const on = k.counts.excellent + k.counts.good;
    const live = k.accounts - k.counts.setup;
    const pacing = k.pacing.filter((p) => p.status !== "check").length;
    const tone = k.counts.off ? "bad" : k.counts.close ? "warn" : "ok";
    out.push({
      tile: { id, label: `${name} off target`, value: k.counts.off, sub: `of ${live} ${name} accounts · ${on} on target`, tone },
      panel: (
        <Topic key={id} id={id} title={`${name} accounts against target`} summary={`${k.counts.off} off target · ${k.counts.close} close · ${on} on or beating it${pacing ? ` · ${s(pacing, "budget")} off pace` : ""}`} count={k.counts.off} tone={tone}>
          <KpiPulse k={k} title="" />
        </Topic>
      ),
    });
  }

  const fatigue = d.fatigue ?? [];
  if (fatigue.length) {
    const tired = fatigue.filter((r) => r.severity === "tired").length;
    out.push({
      tile: { id: "fatigue", label: "Wearing out", value: fatigue.length, sub: tired ? `${tired} ready for a refresh` : "ads slipping", tone: "quiet" },
      panel: (
        <Topic key="fatigue" id="fatigue" title="Ads due a refresh" summary={`${tired ? `${s(tired, "ad")} ready for a refresh · ` : ""}each against its own last three weeks`} count={fatigue.length} tone="quiet">
          <FatigueWatch rows={fatigue} bare />
        </Topic>
      ),
    });
  } else if (d.fatigue) out.push({ tile: null, panel: null, clear: "no ads wearing out" });

  const clients = (d.clients ?? []).filter((c) => c.allotment > 0);
  if (clients.length) {
    // Under-delivering is the risk; a client getting more than their allotment is only noted
    const behind = clients.filter((c) => c.note === "Nothing delivered yet" || c.note === "Behind on creative").length;
    const over = clients.filter((c) => c.used > c.allotment).length;
    out.push({
      tile: { id: "allotments", label: "Allotments", value: behind, sub: `behind on creative${over ? ` · ${over} getting extra` : ""}`, tone: behind ? "warn" : "ok" },
      panel: (
        <Topic key="allotments" id="allotments" title="Creative allotments" summary={`${behind} behind where they should be by today · ${over} past their allotment · ${clients.length} clients with a package`} count={behind || undefined} tone={behind ? "warn" : "ok"}>
          <div className="grid gap-2">
            <ClientHealth clients={clients} monthElapsed={d.monthElapsed ?? 0} />
            <Link href="/clients" className="justify-self-start py-3 text-xs text-muted hover:text-fg md:py-0">
              All clients →
            </Link>
          </div>
        </Topic>
      ),
    });
  }
  return out;
}

/** "All clear: nothing stuck, no ads wearing out." */
export function AllClear({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <p className="flex items-center gap-2 px-1 text-xs text-faint">
      <span className="grid h-4 w-4 place-items-center rounded-full bg-ok-soft text-[9px] text-ok">✓</span>
      All clear: {items.join(", ")}.
    </p>
  );
}

/**
 * The topics grouped into the few themes the Overview shows: clients at risk (promises, anything stuck, accounts off
 * target), creative and growth (briefs, ads wearing out), new clients, and delivery (allotments, plus the work or the
 * team passed in). Each theme carries its count, a one-line headline, a few points, and its topic panels.
 */
export function buildThemes(d: SharedTopics, extra: { first?: Theme | null; delivery?: { content: React.ReactNode; points: string[]; count: number } | null; production?: Production | null } = {}): Theme[] {
  const built = [...actTopics(d), ...accountTopics(d)].filter((b) => b.tile && b.panel);
  const by = (...ids: string[]) => built.filter((b) => ids.includes(b.tile!.id));
  const sum = (bs: Built[]) => bs.reduce((n, b) => n + (Number(b.tile!.value) || 0), 0);
  const SAY: Record<string, string> = { promises: "promises not started", attention: "stuck, late or behind", "kpis-meta": "Meta accounts off target", "kpis-google": "Google accounts off target", "kpis-all": "accounts off target", briefs: "brief ideas", fatigue: "ads due a refresh", allotments: "behind on creative" };
  const points = (bs: Built[]) => bs.filter((b) => Number(b.tile!.value)).map((b) => `${b.tile!.value} ${SAY[b.tile!.id] ?? b.tile!.label.toLowerCase()}`);

  const risk = by("promises", "attention", "kpis-meta", "kpis-google", "kpis-all");
  const growth = by("briefs", "fatigue");
  const fresh = by("onboarding");
  const allot = by("allotments");
  // Creative production (execs and the Head of Creative): clients whose pieces take longest are what needs a look
  const p = extra.production;
  const deliveryCount = sum(allot) + (extra.delivery?.count ?? 0) + (p?.slow.length ?? 0);
  const prodPoints = p ? [p.firstDraft != null ? `${p.firstDraft.toFixed(1)}d to a first draft` : "", p.revisionRate != null ? `${p.revisionRate}% sent back by clients` : "", p.slow.length ? `${s(p.slow.length, "client")} running slow` : ""].filter(Boolean) : [];
  const prodPanel = p ? (
    <Topic key="production" id="production" title="Creative production" summary={`${p.firstDraft == null ? "—" : `${p.firstDraft.toFixed(1)} business days`} to a first draft · ${p.revisionRate ?? "—"}% sent back · revisions back in ${p.revisionTurnaround == null ? "—" : `${p.revisionTurnaround.toFixed(1)}d`}`} count={p.slow.length || undefined} tone={p.slow.length ? "warn" : "ok"} defaultOpen>
      <ProductionPanel p={p} showTeam />
    </Topic>
  ) : null;
  const themes: Theme[] = [];
  if (extra.first) themes.push(extra.first);
  themes.push({
    id: "risk",
    title: "Clients at risk",
    tone: sum(risk) ? "bad" : "ok",
    count: sum(risk),
    headline: sum(risk) ? "Off-target accounts, promises not started, work that's stuck" : "Every account and promise is in hand",
    points: points(risk),
    content: risk.map((b) => b.panel),
  });
  // Suggestions, not alarms: a calm colour and plain wording
  themes.push({
    id: "growth",
    title: "Ideas for clients",
    tone: sum(growth) ? "quiet" : "ok",
    count: sum(growth),
    headline: sum(growth) ? "Briefs the strategist suggests and ads ready for a refresh, when you have a moment" : "No new ideas waiting",
    points: points(growth),
    content: growth.map((b) => b.panel),
  });
  themes.push({
    id: "new",
    title: "New clients",
    tone: sum(fresh) ? "warn" : "ok",
    count: sum(fresh),
    headline: sum(fresh) ? "Setup, intake and first rounds for clients getting started" : "No one onboarding right now",
    points: fresh.map((b) => b.tile!.sub),
    content: fresh.map((b) => b.panel),
  });
  themes.push({
    id: "delivery",
    title: "Delivery",
    tone: deliveryCount ? "quiet" : "ok",
    count: deliveryCount,
    headline: p ? "How fast creative gets made, revisions, and allotments" : deliveryCount ? "Creative allotments this month, and how the work is moving" : "Allotments on pace",
    points: [...prodPoints, ...points(allot), ...(extra.delivery?.points ?? [])],
    content: (
      <>
        {prodPanel}
        {allot.map((b) => b.panel)}
        {extra.delivery?.content}
      </>
    ),
  });
  return themes;
}
