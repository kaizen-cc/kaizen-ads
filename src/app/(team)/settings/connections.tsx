import Link from "next/link";
import { elevenlabsStatus } from "@/lib/elevenlabs";
import { higgsfieldStatus } from "@/lib/higgsfield";
import { loomConnection } from "@/lib/loom-atlassian";
import { motionConnected } from "@/lib/motion";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { TOKEN_URL } from "@/lib/atlassian-token";
import { LoomAtlassianControls, TokenExpiry } from "./loom-atlassian-controls";

// Settings › Connections: the media connectors (ElevenLabs, Higgsfield, Motion), whether each key is there and
// accepted, what's left on the plan where the provider says, and what the team made with them this month. Keys are
// never shown: only whether they're set.

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const n = (x: number) => x.toLocaleString("en-US");

type Tone = "ok" | "warn" | "bad" | "off";
const dot: Record<Tone, string> = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", off: "bg-faint" };

function Card({ name, tone, state, about, children }: { name: string; tone: Tone; state: string; about: string; children: React.ReactNode }) {
  return (
    <section className="grid content-start gap-4 rounded-[16px] border border-line bg-surface p-4 md:p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="grid gap-1">
          <h2 className="font-heading text-[18px] leading-tight">{name}</h2>
          <p className="text-xs leading-relaxed text-muted">{about}</p>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1 text-[11.5px] text-muted">
          <span className={`h-2 w-2 rounded-full ${dot[tone]}`} aria-hidden />
          {state}
        </span>
      </div>
      {children}
    </section>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-faint">{k}</dt>
      <dd className="min-w-0 text-muted [overflow-wrap:anywhere]">{children}</dd>
    </>
  );
}

export async function Connections({ isExec = false }: { isExec?: boolean }) {
  const admin = adminConfigured() ? createAdminClient() : null;
  const monthStart = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const [el, hf, motion, loom, usage] = await Promise.all([
    elevenlabsStatus(),
    higgsfieldStatus(),
    admin ? motionConnected(admin).catch(() => null) : Promise.resolve(null),
    loomConnection(admin),
    admin
      ? admin.from("ai_media_jobs").select("provider, kind, status, characters, credits").gte("created_at", monthStart.toISOString()).limit(5000).then((r) => r.data ?? [])
      : Promise.resolve([] as { provider: string; kind: string; status: string; characters: number | null; credits: number | null }[]),
  ]);
  const made = (p: string, kind?: string) => usage.filter((u) => u.provider === p && u.status === "ready" && (!kind || u.kind === kind)).length;
  const failed = (p: string) => usage.filter((u) => u.provider === p && u.status === "failed").length;
  const chars = usage.filter((u) => u.provider === "elevenlabs" && u.status === "ready").reduce((s, u) => s + (u.characters ?? 0), 0);
  const credits = usage.filter((u) => u.provider === "higgsfield").reduce((s, u) => s + Number(u.credits ?? 0), 0);

  const elTone: Tone = !el.configured ? "off" : !el.reachable ? "bad" : el.quota && el.quota.limit && el.quota.left / el.quota.limit < 0.1 ? "warn" : "ok";
  const hfTone: Tone = !hf.configured ? "off" : !hf.reachable ? "bad" : "ok";
  const share = el.quota?.limit ? Math.min(1, el.quota.used / el.quota.limit) : 0;
  const loomExpired = loom.expiry !== null && loom.expiry.daysLeft < 0;
  const loomTone: Tone = !loom.configured ? "off" : loom.lastError || loom.authFailedAt || loomExpired ? "bad" : !loom.lastOkAt || (loom.expiry && loom.expiry.daysLeft <= 30) ? "warn" : "ok";
  const loomState = !loom.configured ? "Not connected" : loom.authFailedAt || loomExpired ? "Token expired" : loom.lastError ? "Failing" : loom.lastOkAt ? (loom.expiry && loom.expiry.daysLeft <= 30 ? "Token expiring" : "Connected") : "Not checked yet";

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <p className="text-sm text-muted">
        The tools the creative team generates with. Keys live in Vercel and are never shown here; this only says whether each one is set and accepted. The creative team, leads and execs can generate;
        everyone else can see and play what was made.
      </p>
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-4 lg:grid-cols-3">
        <Card
          name="ElevenLabs"
          tone={elTone}
          state={!el.configured ? "Not connected" : el.reachable ? "Connected" : "Failing"}
          about="Voiceovers on video tickets and in the creative workspace."
        >
          {el.error && <p className="text-xs text-bad">{el.error}</p>}
          {el.quota && (
            <div className="grid gap-1.5">
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="text-muted">Characters left this cycle</span>
                <span className="tabular font-medium text-fg">{n(el.quota.left)}</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-ink/[0.08]">
                <div className={`h-full rounded-full ${share > 0.9 ? "bg-bad" : share > 0.7 ? "bg-warn" : "bg-brand"}`} style={{ width: `${share * 100}%` }} />
              </div>
              <p className="text-[11px] text-faint">
                {n(el.quota.used)} of {n(el.quota.limit)} used · {el.quota.tier} plan{el.quota.resetsAt ? ` · resets ${when(el.quota.resetsAt)}` : ""}
              </p>
            </div>
          )}
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
            <Row k="Key">{el.configured ? "ELEVENLABS_API_KEY is set" : "ELEVENLABS_API_KEY isn't set"}</Row>
            <Row k="This month">
              {made("elevenlabs")} voiceovers · {n(chars)} characters{failed("elevenlabs") ? ` · ${failed("elevenlabs")} failed` : ""}
            </Row>
          </dl>
          {!el.configured && <p className="text-[11px] leading-relaxed text-faint">ElevenLabs › your profile › API Keys › Create key. Add it in Vercel as ELEVENLABS_API_KEY and redeploy.</p>}
        </Card>

        <Card
          name="Higgsfield"
          tone={hfTone}
          state={!hf.configured ? "Not connected" : hf.reachable ? "Connected" : "Failing"}
          about="AI images and short videos from a prompt or a reference, on tickets and in the creative workspace."
        >
          {hf.error && <p className="text-xs text-bad">{hf.error}</p>}
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
            <Row k="Keys">
              {[process.env.HIGGSFIELD_API_KEY ? "key ID set" : "HIGGSFIELD_API_KEY missing", process.env.HIGGSFIELD_API_SECRET ? "secret set" : "HIGGSFIELD_API_SECRET missing"].join(" · ")}
            </Row>
            <Row k="This month">
              {made("higgsfield", "image")} images · {made("higgsfield", "video")} videos{failed("higgsfield") ? ` · ${failed("higgsfield")} failed` : ""}
              {credits ? ` · ${n(credits)} credits` : ""}
            </Row>
            <Row k="Credits">
              Higgsfield&apos;s API doesn&apos;t report the balance.{" "}
              <a href="https://cloud.higgsfield.ai" target="_blank" rel="noreferrer" className="text-brand-text hover:underline">
                See it on Higgsfield ↗
              </a>
            </Row>
          </dl>
          {!hf.configured && <p className="text-[11px] leading-relaxed text-faint">cloud.higgsfield.ai › API keys › Create. Add the key ID as HIGGSFIELD_API_KEY and the secret as HIGGSFIELD_API_SECRET in Vercel, then redeploy.</p>}
        </Card>

        <Card
          name="Motion"
          tone={motion ? (motion.error ? "bad" : "ok") : "off"}
          state={motion ? (motion.error ? "Failing" : "Connected") : "Not connected"}
          about="The market ads behind References from Motion on briefs and shot lists, and Motion's own reports for the AI."
        >
          {motion?.error && <p className="text-xs text-bad">{motion.error}</p>}
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
            <Row k="Sign-in">{motion ? `Connected${motion.connectedAt ? ` ${when(motion.connectedAt)}` : ""}` : "An exec signs in to Motion once"}</Row>
            <Row k="Last sync">{motion?.lastSyncAt ? when(motion.lastSyncAt) : "Not yet"}</Row>
          </dl>
          <Link href="/settings?tab=sync" className="inline-flex h-11 items-center justify-self-start rounded-full border border-line px-4 text-xs text-muted hover:text-fg md:h-9">
            {motion ? "Market sync details" : "Connect in Sync health"}
          </Link>
        </Card>

        <Card name="Loom (Atlassian)" tone={loomTone} state={loomState} about="Every new Loom pulled in by itself through Atlassian's MCP server, read and sorted into the agents' knowledge. Private and workspace-only videos too.">
          {loom.lastError && <p className="text-xs leading-relaxed text-bad">{loom.lastError}</p>}
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
            <Row k="Connected as">{loom.account ?? (loom.configured ? (loom.mode === "service" ? "A service account (shown after the first check)" : "Shown after the first check") : "Nobody yet")}</Row>
            <Row k="Last check">{loom.lastSyncAt ? when(loom.lastSyncAt) : "Not yet"}</Row>
            <Row k="Videos found">
              {n(loom.videoCount)} in all{loom.lastSyncAt ? ` · ${n(loom.lastFound)} on the last check` : ""}
            </Row>
            {loom.walking && <Row k="Pulling">{loom.walking.all ? "Everything, continuing every 15 minutes" : `Everything since ${new Date(loom.walking.from as string).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}, continuing every 15 minutes`}</Row>}
          </dl>
          {loom.configured ? (
            <>
              <TokenExpiry key={loom.expiry?.date ?? "none"} expiry={loom.expiry} isExec={isExec} refused={Boolean(loom.authFailedAt)} />
              <LoomAtlassianControls isExec={isExec} />
            </>
          ) : (
            <p className="text-[11px] leading-relaxed text-faint">
              Add {loom.missing.join(" and ")} in Vercel (
              <a href={TOKEN_URL} target="_blank" rel="noreferrer" className="text-brand-text hover:underline">
                make a token ↗
              </a>{" "}
              signed in as the account whose Looms we pull), or ATLASSIAN_SERVICE_KEY for a service account, then redeploy. An org admin also turns on API-token sign-in at admin.atlassian.com › Connectors › Atlassian MCP server, and the Loom workspace has to be linked to the Atlassian site.
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}
