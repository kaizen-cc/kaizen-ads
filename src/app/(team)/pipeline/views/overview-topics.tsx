import Link from "next/link";
import type { WatchRow } from "@/lib/fatigue";
import { FatigueWatch } from "@/components/fatigue-watch";
import type { CallPromise, OnboardingState, SuggestionsState } from "@/lib/suggestions";
import { CallPromises } from "./call-promises";
import { OnboardingCallout } from "./onboarding-callout";
import { SuggestedBriefs } from "./suggested-briefs";
import { AttentionList, ClientHealth, KpiPulse, type Alert, type ClientPulse, type KpiPulseData } from "./shared";
import { Topic, type TopicTile } from "./topics";

// The topics execs and leads share on the Overview, each with its tile (what's in it, at a glance) and its panel
// (the detail to act on). Only topics with something in them are shown; what's all clear is said in one line.

export type SharedTopics = {
  onboarding?: OnboardingState | null;
  callPromises?: CallPromise[] | null;
  suggestions?: SuggestionsState | null;
  kpis?: KpiPulseData | null;
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
      tile: { id: "briefs", label: "Briefs", value: briefs.length, sub: briefs.length ? `to decide, across ${s(clients, "client")}` : "being written", tone: "brand" },
      panel: (
        <Topic key="briefs" id="briefs" title="Suggested briefs" summary={briefs.length ? `The strategist wrote ${s(briefs.length, "brief")} from what it saw in ${s(clients, "account")}: approve, edit or decline` : "The strategist is reading every account"} count={briefs.length} tone="brand">
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

  if (d.kpis && d.kpis.accounts) {
    const k = d.kpis;
    const on = k.counts.excellent + k.counts.good;
    const tone = k.counts.off ? "bad" : k.counts.close ? "warn" : "ok";
    out.push({
      tile: { id: "kpis", label: "Off target", value: k.counts.off, sub: `of ${k.accounts} ad accounts · ${on} on target`, tone },
      panel: (
        <Topic key="kpis" id="kpis" title="Ad accounts against target" summary={`${k.counts.off} off target · ${k.counts.close} close · ${on} on or beating it${k.pacing.length ? ` · ${s(k.pacing.length, "budget")} off pace` : ""}`} count={k.counts.off} tone={tone}>
          <KpiPulse k={k} title="" />
        </Topic>
      ),
    });
  }

  const fatigue = d.fatigue ?? [];
  if (fatigue.length) {
    const tired = fatigue.filter((r) => r.severity === "tired").length;
    out.push({
      tile: { id: "fatigue", label: "Wearing out", value: fatigue.length, sub: tired ? `${tired} ready to replace` : "ads slipping", tone: tired ? "warn" : "quiet" },
      panel: (
        <Topic key="fatigue" id="fatigue" title="Ads wearing out" summary={`${tired ? `${s(tired, "ad")} ready to replace · ` : ""}each against its own last three weeks`} count={fatigue.length} tone={tired ? "warn" : "quiet"}>
          <FatigueWatch rows={fatigue} bare />
        </Topic>
      ),
    });
  } else if (d.fatigue) out.push({ tile: null, panel: null, clear: "no ads wearing out" });

  const clients = (d.clients ?? []).filter((c) => c.allotment > 0);
  if (clients.length) {
    const over = clients.filter((c) => c.used > c.allotment).length;
    const behind = clients.filter((c) => c.used / c.allotment < (d.monthElapsed ?? 0) - 0.25).length;
    out.push({
      tile: { id: "allotments", label: "Allotments", value: over, sub: `over this month${behind ? ` · ${behind} behind pace` : ""}`, tone: over ? "warn" : "ok" },
      panel: (
        <Topic key="allotments" id="allotments" title="Creative allotments" summary={`${over} over · ${behind} behind where they should be by today · ${clients.length} clients with a package`} count={over || undefined} tone={over ? "warn" : "ok"}>
          <div className="grid gap-2">
            <ClientHealth clients={clients} monthElapsed={d.monthElapsed ?? 0} />
            <Link href="/clients" className="justify-self-start text-xs text-muted hover:text-fg">
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
