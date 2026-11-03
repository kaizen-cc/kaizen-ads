"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { EMAIL_PLATFORMS, GOOGLE_TOOLS, WEBSITE_PLATFORMS, googleTools, isEcommerce, toolSettled, type GoogleTool, type ToolStep } from "@/lib/onboarding-guide-types";
import { PLATFORM_STEPS, fillAddress, type PlatformStep } from "@/lib/platform-steps";
import { closeParams, pushParams, useParam } from "@/lib/url-state";
import { TRACKING_KINDS, platformsFor, trackingPlatform, type TrackingKind } from "@/lib/tracking-platforms";
import { emailStep, saveBusiness, toolStep, trackingStep, websiteStep } from "./actions";
import { Copy, HelpChat, Hit, OnCall, Screen, Sheet, Walk, type StartProps } from "./start-view";

// The access beyond Meta and Google Ads: Google Analytics, Tag Manager, Business Profile and Merchant Center, their
// website and their email platform. Each one a short walk with pictures of the screens and our address to copy; "I
// don't have one" sets it up with us on the call. Which tool is open lives in the address, so back returns to the list.

type Addr = { tech: string; klaviyo: string };
const addrOf = (p: StartProps): Addr => ({ tech: p.techEmail ?? "Ask your Kaizen contact", klaviyo: p.klaviyoEmail ?? p.techEmail ?? "Ask your Kaizen contact" });

/** **bold** in the steps' text, as the guide shows it */
function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split(/\*\*(.+?)\*\*/g).map((part, i) =>
        i % 2 ? (
          <b key={i} className="text-fg">
            {part}
          </b>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** A platform's steps, drawn: the screen, its menu with the item to pick, the dialog filled in, our address to copy */
function walkOf(key: string, a: Addr) {
  return walkSteps(PLATFORM_STEPS[key] ?? [], a);
}

function walkSteps(steps: PlatformStep[], a: Addr) {
  return steps.map((s) => ({
    title: s.title,
    body: (
      <>
        <Rich text={fillAddress(s.body, a)} />
        {s.link && (
          <a href={s.link} target="_blank" rel="noreferrer" className="ml-1 text-brand-text underline">
            Open ↗
          </a>
        )}
        {s.copy && (
          <span className="mt-3 block">
            <Copy value={s.copy === "klaviyo" ? a.klaviyo : a.tech} label="Our address" />
          </span>
        )}
      </>
    ),
    screen: (
      <Screen url={s.url} menu={s.menu} active={s.active}>
        {s.panel ? (
          <div className="mx-auto grid max-w-[300px] gap-1.5 rounded-[10px] bg-white p-3 text-[11.5px] shadow">
            <p className="text-[12.5px] font-semibold">{s.panel.title}</p>
            {s.panel.rows.map((r) => (
              <p key={r} className="truncate rounded-[6px] border border-[#dadde1] px-2 py-1.5">
                {fillAddress(r, a)}
              </p>
            ))}
            <div className="text-right">
              <Hit>{s.panel.hit}</Hit>
            </div>
          </div>
        ) : (
          <div className="grid h-full place-items-center py-6">{s.hit && <Hit>{s.hit}</Hit>}</div>
        )}
      </Screen>
    ),
  }));
}

function Done({ title, text }: { title: string; text: string }) {
  return (
    <div className="grid gap-2 rounded-[20px] border border-ok/40 bg-ok-soft/40 p-5">
      <p className="font-heading text-[20px] text-ok">✓ {title}</p>
      <p className="text-[14.5px] text-muted">{text}</p>
    </div>
  );
}

function Called({ text }: { text: string }) {
  return <p className="rounded-[14px] bg-warn-soft/50 px-4 py-3 text-[13.5px] text-warn">☎ {text}</p>;
}

function Choice({ on, children, onClick }: { on: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`min-h-11 rounded-full border px-4 text-[14px] transition-colors ${on ? "border-brand bg-brand/15 text-fg" : "border-line text-muted hover:border-faint hover:text-fg"}`}>
      {children}
    </button>
  );
}

/** Two yes/no questions that decide Merchant Center and the Business Profile, answered for them by our guess until they change it */
function AboutBusiness(p: StartProps) {
  const router = useRouter();
  const ecommerce = isEcommerce(p.guide, p.has);
  const location = p.guide.business?.location;
  const set = async (b: { ecommerce?: boolean; location?: boolean }) => {
    await saveBusiness(p.slug, b);
    router.refresh();
  };
  return (
    <div className="grid gap-3 rounded-[20px] border border-line bg-surface p-4">
      <div className="grid gap-2">
        <p className="text-[14px]">Do you sell products online that you ship to customers?</p>
        <div className="flex gap-2">
          <Choice on={ecommerce} onClick={() => void set({ ecommerce: true })}>Yes</Choice>
          <Choice on={!ecommerce} onClick={() => void set({ ecommerce: false })}>No</Choice>
        </div>
      </div>
      <div className="grid gap-2">
        <p className="text-[14px]">Do customers come to a location (a store, office, restaurant)?</p>
        <div className="flex gap-2">
          <Choice on={location === true} onClick={() => void set({ location: true })}>Yes</Choice>
          <Choice on={location === false} onClick={() => void set({ location: false })}>No</Choice>
        </div>
      </div>
    </div>
  );
}

const toolState = (t: ToolStep) => (t.status === "done" ? "Added" : t.status === "na" ? "Not needed" : t.status === "on_call" ? (t.none ? "We'll set it up on our call" : "On our call") : null);

/** Google Analytics, Tag Manager, Business Profile and Merchant Center: a list, each opening its walk */
export function ToolsSheet(p: StartProps) {
  const open = useParam("tool") as GoogleTool | null;
  const tools = googleTools(p.guide, p.has);
  const a = addrOf(p);
  const tool = open && tools.includes(open) ? GOOGLE_TOOLS.find((t) => t.key === open)! : null;
  return (
    <Sheet kicker="Access" title={tool ? tool.name : "Google Analytics & tools"} help={<HelpChat slug={p.slug} step="tools" initial={p.help.tools} onCall={tools.every((t) => p.guide[t].status === "on_call")} />}>
      {tool ? (
        <ToolWalk key={tool.key} {...p} tool={tool} a={a} />
      ) : (
        <div className="grid gap-4">
          <p className="text-[14.5px] leading-relaxed text-muted">
            Beyond your ad account, these let us track what happens after the click and show up on Google. Each one is adding our address as an admin, about a minute each:
          </p>
          <Copy value={a.tech} label="Our address" />
          <AboutBusiness {...p} />
          <div className="grid gap-2.5">
            {tools.map((key) => {
              const t = GOOGLE_TOOLS.find((x) => x.key === key)!;
              const state = toolState(p.guide[key]);
              return (
                <button key={key} type="button" onClick={() => pushParams({ tool: key })} className="group flex items-center gap-3.5 rounded-[18px] border border-line bg-surface p-4 text-left hover:border-faint">
                  <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-full text-[14px] font-semibold ${p.guide[key].status === "done" || p.guide[key].status === "na" ? "bg-ok text-white" : p.guide[key].status === "on_call" ? "bg-warn-soft text-warn" : "bg-surface-2 text-muted"}`}>
                    {p.guide[key].status === "done" || p.guide[key].status === "na" ? "✓" : p.guide[key].status === "on_call" ? "☎" : "G"}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-heading text-[16px]">{t.name}</span>
                    <span className="block text-[13px] text-muted">{state ?? t.line}</span>
                  </span>
                  <span className="text-[12px] text-faint group-hover:text-fg">→</span>
                </button>
              );
            })}
          </div>
          {!tools.every((t) => toolSettled(p.guide[t])) && <OnCall slug={p.slug} which="tools" done={false} />}
        </div>
      )}
    </Sheet>
  );
}

function ToolWalk(p: StartProps & { tool: (typeof GOOGLE_TOOLS)[number]; a: Addr }) {
  const router = useRouter();
  const step = p.guide[p.tool.key];
  const [id, setId] = useState(step.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (status: "done" | "none" | "na") => {
    setBusy(true);
    setError(null);
    const r = await toolStep(p.slug, p.tool.key, status, id);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    router.refresh();
    closeParams("tool");
  };
  if (step.status === "done") return <Done title="Added" text={`Thanks: we'll accept the invite and check we can see your ${p.tool.name}${step.id ? ` (${step.id})` : ""}.`} />;
  if (step.status === "na") return <Done title="Not needed" text="Got it, nothing to do here." />;
  if (step.status === "on_call") return <Called text={step.none ? `No problem: we'll set up ${p.tool.name} with you on our onboarding call.` : "Got it: we'll do this together on our onboarding call."} />;
  return (
    <div className="grid gap-5">
      <Walk
        steps={walkOf(p.tool.key, p.a)}
        last={
          <div className="grid gap-4">
            <p className="font-heading text-[20px]">Last thing: tell us it&rsquo;s done</p>
            {p.tool.idLabel && <input value={id} onChange={(e) => setId(e.target.value)} placeholder={p.tool.idLabel} className="h-12 rounded-[14px] border border-line bg-surface px-4 text-[15px] outline-none focus:border-brand-text/60" />}
            <button type="button" disabled={busy} onClick={() => void save("done")} className="h-12 rounded-full bg-brand text-[15px] font-medium text-white disabled:opacity-60">
              {busy ? "Saving…" : "I've added Kaizen"}
            </button>
            {error && <p className="text-[13px] text-bad">{error}</p>}
          </div>
        }
      />
      <div className="grid gap-2 border-t border-line pt-4">
        <button type="button" disabled={busy} onClick={() => void save("none")} className="justify-self-start text-[13.5px] text-brand-text hover:underline">
          I don&rsquo;t have {p.tool.key === "gbp" ? "a Business Profile" : p.tool.key === "merchant" ? "Merchant Center" : `${p.tool.name}`} yet: set it up with me on our call →
        </button>
        {p.tool.key === "gbp" && (
          <button type="button" disabled={busy} onClick={() => void save("na")} className="justify-self-start text-[13.5px] text-muted hover:text-fg">
            We don&rsquo;t have a location customers visit
          </button>
        )}
      </div>
    </div>
  );
}

/** Pick the platform, then its walk (Shopify: the collaborator code and store address) */
function PlatformPicker({ list, pick }: { list: readonly { key: string; name: string }[]; pick: (k: string) => void }) {
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
      {list.map((x) => (
        <button key={x.key} type="button" onClick={() => pick(x.key)} className="grid min-h-16 place-items-center rounded-[16px] border border-line bg-surface px-3 py-4 text-center font-heading text-[15px] hover:border-brand/60">
          {x.name}
        </button>
      ))}
    </div>
  );
}

export function WebsiteSheet(p: StartProps) {
  const router = useRouter();
  const step = p.guide.website;
  const platform = useParam("platform");
  const a = addrOf(p);
  const [url, setUrl] = useState(step.url ?? "");
  const [code, setCode] = useState("");
  const [store, setStore] = useState("");
  const [other, setOther] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async (status: "done" | "none") => {
    setBusy(true);
    setError(null);
    const r = await websiteStep(p.slug, { platform: platform ?? "", status, url, code, store, other });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    closeParams("platform");
    router.refresh();
  };
  const known = WEBSITE_PLATFORMS.find((x) => x.key === platform);
  return (
    <Sheet kicker="Access" title={known && step.status !== "done" ? `Website: ${known.name}` : "Your website"} help={<HelpChat slug={p.slug} step="website" initial={p.help.website} onCall={step.status === "on_call"} />}>
      {step.status === "done" ? (
        step.platform === "shopify" ? (
          <div className="grid gap-4">
            <Done title="Thanks, we have it" text={`We'll send a collaborator request to ${step.store}. Shopify emails you when it lands.`} />
            <p className="text-[14.5px] leading-relaxed text-muted">
              Then in Shopify: <b className="text-fg">Settings › Users and permissions › Collaborators</b>, open our request and click <b className="text-fg">Accept</b>.
            </p>
          </div>
        ) : (
          <Done title="Added" text="Thanks: we'll accept the invite and check we can get in." />
        )
      ) : step.status === "on_call" ? (
        <Called text={step.none ? "No website yet: we'll talk it through on our onboarding call." : "Got it: we'll do this together on our onboarding call."} />
      ) : !known ? (
        <div className="grid gap-4">
          <p className="text-[14.5px] leading-relaxed text-muted">So we can add tracking and fix what holds your ads back. Which platform is your website on?</p>
          <PlatformPicker list={WEBSITE_PLATFORMS} pick={(k) => pushParams({ platform: k })} />
          <button type="button" disabled={busy} onClick={() => void send("none")} className="justify-self-start text-[13.5px] text-brand-text hover:underline">
            We don&rsquo;t have a website yet →
          </button>
          {error && <p className="text-[13px] text-bad">{error}</p>}
        </div>
      ) : (
        <Walk
          steps={walkOf(known.key === "other" ? "website-other" : known.key, a)}
          last={
            known.key === "shopify" ? (
              <div className="grid gap-4">
                <p className="font-heading text-[20px]">Send us the two things</p>
                <p className="text-[14.5px] leading-relaxed text-muted">We send a collaborator request from our side; you accept it in Shopify. No passwords shared.</p>
                <input value={store} onChange={(e) => setStore(e.target.value)} placeholder="yourstore.myshopify.com" autoCapitalize="none" className="h-12 rounded-[14px] border border-line bg-surface px-4 text-[15px] outline-none focus:border-brand-text/60" />
                <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 4))} inputMode="numeric" placeholder="Collaborator request code (4 digits)" className="h-12 rounded-[14px] border border-line bg-surface px-4 text-[15px] tracking-widest outline-none focus:border-brand-text/60" />
                <button type="button" disabled={busy} onClick={() => void send("done")} className="h-12 rounded-full bg-brand text-[15px] font-medium text-white disabled:opacity-60">
                  {busy ? "Sending…" : "Send to Kaizen"}
                </button>
                {error && <p className="text-[13px] text-bad">{error}</p>}
              </div>
            ) : (
              <div className="grid gap-4">
                <p className="font-heading text-[20px]">Last thing: tell us it&rsquo;s done</p>
                {known.key === "other" && <input value={other} onChange={(e) => setOther(e.target.value)} placeholder="Which platform? (e.g. GoDaddy, Duda, custom)" className="h-12 rounded-[14px] border border-line bg-surface px-4 text-[15px] outline-none focus:border-brand-text/60" />}
                <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Your website address" inputMode="url" autoCapitalize="none" className="h-12 rounded-[14px] border border-line bg-surface px-4 text-[15px] outline-none focus:border-brand-text/60" />
                <button type="button" disabled={busy} onClick={() => void send("done")} className="h-12 rounded-full bg-brand text-[15px] font-medium text-white disabled:opacity-60">
                  {busy ? "Saving…" : "I've added Kaizen"}
                </button>
                {error && <p className="text-[13px] text-bad">{error}</p>}
              </div>
            )
          }
        />
      )}
      {step.status !== "done" && step.status !== "on_call" && (
        <div className="mt-6 grid">
          <OnCall slug={p.slug} which="website" done={false} />
        </div>
      )}
    </Sheet>
  );
}

export function EmailSheet(p: StartProps) {
  const router = useRouter();
  const step = p.guide.email;
  const platform = useParam("platform");
  const a = addrOf(p);
  const [other, setOther] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async (status: "done" | "none") => {
    setBusy(true);
    setError(null);
    const r = await emailStep(p.slug, { platform: platform ?? "", status, other });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    closeParams("platform");
    router.refresh();
  };
  const known = EMAIL_PLATFORMS.find((x) => x.key === platform);
  return (
    <Sheet kicker="Access" title={known && step.status !== "done" ? `Email: ${known.name}` : "Your email platform"} help={<HelpChat slug={p.slug} step="email" initial={p.help.email} onCall={step.status === "on_call"} />}>
      {step.status === "done" ? (
        <Done title="Added" text="Thanks: we'll accept the invite and check we can get in." />
      ) : step.status === "on_call" ? (
        <Called text={step.none ? "No email platform yet: we'll pick and set one up with you on our call." : "Got it: we'll do this together on our onboarding call."} />
      ) : !known ? (
        <div className="grid gap-4">
          <p className="text-[14.5px] leading-relaxed text-muted">Which platform do you send your emails and texts from?</p>
          <PlatformPicker list={EMAIL_PLATFORMS} pick={(k) => pushParams({ platform: k })} />
          <button type="button" disabled={busy} onClick={() => void send("none")} className="justify-self-start text-[13.5px] text-brand-text hover:underline">
            We don&rsquo;t use one yet →
          </button>
          {error && <p className="text-[13px] text-bad">{error}</p>}
        </div>
      ) : (
        <Walk
          steps={walkOf(known.key === "other" ? "email-other" : known.key, a)}
          last={
            <div className="grid gap-4">
              <p className="font-heading text-[20px]">Last thing: tell us it&rsquo;s done</p>
              {known.key === "other" && <input value={other} onChange={(e) => setOther(e.target.value)} placeholder="Which platform? (e.g. HubSpot, Drip)" className="h-12 rounded-[14px] border border-line bg-surface px-4 text-[15px] outline-none focus:border-brand-text/60" />}
              <button type="button" disabled={busy} onClick={() => void send("done")} className="h-12 rounded-full bg-brand text-[15px] font-medium text-white disabled:opacity-60">
                {busy ? "Saving…" : "I've added Kaizen"}
              </button>
              {error && <p className="text-[13px] text-bad">{error}</p>}
            </div>
          }
        />
      )}
      {step.status !== "done" && step.status !== "on_call" && (
        <div className="mt-6 grid">
          <OnCall slug={p.slug} which="email" done={false} />
        </div>
      )}
    </Sheet>
  );
}

/**
 * Where their orders, bookings or leads live (from their industry: POS and online ordering, booking software, CRM and
 * call tracking, store apps): pick everything they use, then add us on each. One that can't add a user, or "not sure",
 * is set up with the tracking team on the call.
 */
export function TrackingSheet(p: StartProps & { kind: TrackingKind }) {
  const router = useRouter();
  const step = p.guide.tracking;
  const open = useParam("platform");
  const a = addrOf(p);
  const k = TRACKING_KINDS[p.kind];
  const list = platformsFor(p.kind);
  const [editing, setEditing] = useState(!(step.picks?.length || step.notSure));
  const [chosen, setChosen] = useState<string[]>((step.picks ?? []).map((x) => x.key));
  const [other, setOther] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (op: Parameters<typeof trackingStep>[1], after?: () => void) => {
    setBusy(true);
    setError(null);
    const r = await trackingStep(p.slug, op);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    after?.();
    router.refresh();
  };
  const pick = (step.picks ?? []).find((x) => x.key === open) ?? null;
  const platform = pick ? trackingPlatform(pick.key) : null;
  const helpChat = <HelpChat slug={p.slug} step="tracking" initial={p.help.tracking} onCall={step.status === "on_call"} />;

  // One platform's walk
  if (pick) {
    const steps = platform?.steps ?? [{ title: `Add Kaizen to ${pick.name}`, body: "In its settings, find **Users**, **Team** or **Employees**, and invite our address with access to **reports**. Not possible on your plan? Tap below and we'll connect it together on the call.", url: pick.name, hit: "Invite user", copy: "tech" as const }];
    return (
      <Sheet kicker={k.title} title={pick.name} help={helpChat}>
        {pick.status === "done" ? (
          <Done title="Added" text={`Thanks: our tracking team will accept it and connect ${pick.name} to your ads.`} />
        ) : pick.status === "on_call" ? (
          <div className="grid gap-4">
            <Called text={`Our tracking team will connect ${pick.name} with you on the onboarding call (a report export or a connection). Nothing to do now.`} />
          </div>
        ) : (
          <div className="grid gap-5">
            <Walk
              steps={walkSteps(steps, a)}
              last={
                <div className="grid gap-4">
                  <p className="font-heading text-[20px]">Last thing: tell us it&rsquo;s done</p>
                  <button type="button" disabled={busy} onClick={() => void run({ done: pick.key }, () => closeParams("platform"))} className="h-12 rounded-full bg-brand text-[15px] font-medium text-white disabled:opacity-60">
                    {busy ? "Saving…" : "I've added Kaizen"}
                  </button>
                  {error && <p className="text-[13px] text-bad">{error}</p>}
                </div>
              }
            />
            <button type="button" disabled={busy} onClick={() => void run({ call: pick.key }, () => closeParams("platform"))} className="justify-self-start border-t border-line pt-4 text-[13.5px] text-brand-text hover:underline">
              Can&rsquo;t add users, or rather do it together? Connect it on our call →
            </button>
          </div>
        )}
      </Sheet>
    );
  }

  return (
    <Sheet kicker="Access" title={k.title} help={helpChat}>
      {editing ? (
        <div className="grid gap-4">
          <p className="text-[14.5px] leading-relaxed text-muted">So our tracking team can tie your sales and leads back to the ads, and we judge them on real results. {k.ask}</p>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
            {list.map((x) => {
              const on = chosen.includes(x.key);
              return (
                <button key={x.key} type="button" aria-pressed={on} onClick={() => setChosen(on ? chosen.filter((c) => c !== x.key) : [...chosen, x.key])} className={`relative grid min-h-16 place-items-center rounded-[16px] border px-3 py-4 text-center font-heading text-[15px] transition-colors ${on ? "border-brand bg-brand/10" : "border-line bg-surface hover:border-faint"}`}>
                  {on && <span className="absolute right-2 top-2 grid h-5 w-5 place-items-center rounded-full bg-brand text-[11px] text-white">✓</span>}
                  {x.name}
                </button>
              );
            })}
          </div>
          {chosen
            .filter((c) => c.startsWith("other:"))
            .map((c) => (
              <span key={c} className="justify-self-start rounded-full border border-brand bg-brand/10 px-3 py-1.5 text-[13px]">
                {(step.picks ?? []).find((x) => x.key === c)?.name ?? c.slice(6)}
              </span>
            ))}
          <input value={other} onChange={(e) => setOther(e.target.value)} placeholder="Something else? Type its name" className="h-12 rounded-[14px] border border-line bg-surface px-4 text-[15px] outline-none focus:border-brand-text/60" />
          <button type="button" disabled={busy || (!chosen.length && !other.trim())} onClick={() => void run({ picks: chosen, other }, () => setEditing(false))} className="h-12 rounded-full bg-brand text-[15px] font-medium text-white disabled:opacity-50">
            {busy ? "Saving…" : "That's what we use"}
          </button>
          <button type="button" disabled={busy} onClick={() => void run({ picks: [], notSure: true }, () => setEditing(false))} className="justify-self-start text-[13.5px] text-brand-text hover:underline">
            Not sure? We&rsquo;ll figure it out together on our call →
          </button>
          {error && <p className="text-[13px] text-bad">{error}</p>}
        </div>
      ) : step.notSure && !(step.picks ?? []).length ? (
        <div className="grid gap-4">
          <Called text="No problem: our tracking team will work it out with you on the onboarding call." />
          <button type="button" onClick={() => setEditing(true)} className="justify-self-start text-[13.5px] text-muted hover:text-fg">
            Actually, I know what we use →
          </button>
        </div>
      ) : (
        <div className="grid gap-4">
          <p className="text-[14.5px] leading-relaxed text-muted">Add us on each one (about a minute each). Ones that can&rsquo;t add a user we connect with you on the call.</p>
          <Copy value={a.tech} label="Our address" />
          <div className="grid gap-2.5">
            {(step.picks ?? []).map((x) => (
              <button key={x.key} type="button" onClick={() => pushParams({ platform: x.key })} className="group flex items-center gap-3.5 rounded-[18px] border border-line bg-surface p-4 text-left hover:border-faint">
                <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-full text-[14px] font-semibold ${x.status === "done" ? "bg-ok text-white" : x.status === "on_call" ? "bg-warn-soft text-warn" : "bg-surface-2 text-muted"}`}>{x.status === "done" ? "✓" : x.status === "on_call" ? "☎" : x.name.slice(0, 1)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block font-heading text-[16px]">{x.name}</span>
                  <span className="block text-[13px] text-muted">{x.status === "done" ? "Added" : x.status === "on_call" ? "Connecting it on our call" : "Add Kaizen"}</span>
                </span>
                <span className="text-[12px] text-faint group-hover:text-fg">→</span>
              </button>
            ))}
          </div>
          <button type="button" onClick={() => setEditing(true)} className="justify-self-start text-[13.5px] text-muted hover:text-fg">
            Change what we use →
          </button>
        </div>
      )}
    </Sheet>
  );
}
