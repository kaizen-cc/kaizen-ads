import Link from "next/link";
import { ActionButton, ActionForm } from "@/components/action-form";
import { Section, field, label } from "@/components/ui";
import type { Digest } from "@/lib/ai";
import { SLOTS } from "@/lib/roles";
import { AssignSelect, type Option } from "../assign-select";
import type { Freshness } from "@/lib/dates";
import { BriefingPanel } from "./briefing-panel";
import { ConnectionStatus } from "./connection-status";
import {
  syncMetaNow,
  addAngle,
  addContact,
  addMemory,
  archiveMemory,
  endCreativePackage,
  refreshClientBriefing,
  removeContact,
  saveAllotment,
  saveClientDetails,
  setAngleStatus,
  setSprintPackage,
} from "./actions";
import { PackagePanel, type PackageOption } from "./package-panel";
import { BrandBiblePanel, type BrandBible } from "./brand-bible-panel";
import { untilLabel } from "@/lib/allotment";

const fmt = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
const chip = "inline-flex items-center rounded-full px-2.5 py-1 text-xs";
const row = "flex items-start justify-between gap-3 rounded-[8px] bg-surface-2/70 px-4 py-3 text-sm";

export type ClientViewProps = {
  client: {
    id: string;
    name: string;
    slug: string;
    status: string;
    client_type: string;
    website: string | null;
    meta_ad_account_id: string | null;
    slack_channel_id: string | null;
    internal_slack_channel_id: string | null;
    drive_folder_id: string | null;
    kaizen_id: number | null;
    auto_approve_opt_in: boolean;
    creative_package: boolean;
    creative_package_key?: string | null;
    creative_package_until?: string | null;
    creative_package_note?: string | null;
  };
  packages: PackageOption[];
  brandBible?: BrandBible | null;
  today: string; // YYYY-MM-DD in New York
  packageLabel: string | null;
  team: Record<string, { current: Option | null; options: Option[] }>;
  contacts: { id: string; email: string; full_name: string | null; auth_user_id: string | null }[];
  angles: { id: string; name: string; kind: string; description: string | null; status: string }[];
  memory: { id: string; kind: string; body: string; source: string; by: string | null }[];
  digest: Digest | null;
  briefingAt: string | null;
  needsInvite: string[];
  images: number;
  videos: number;
  imagesUsed: number;
  videosUsed: number;
  can: { admin: boolean; contacts: boolean; allot: boolean; assign: boolean };
  demo?: boolean; // design preview: the refresh only plays its animation
  connections: { meta: Freshness | null; slackClient: Freshness | null; slackInternal: Freshness | null; drive: Freshness | null };
};

/** The client page itself, given its data (the page loads it; the design preview passes samples). */
export function ClientView({ client, packageLabel, packages, brandBible = null, today, team, contacts, angles, memory, digest, briefingAt, needsInvite, images, videos, imagesUsed, videosUsed, can, demo = false, connections }: ClientViewProps) {
  // A sprint whose end date passed is off, even before the nightly job switches it off
  const until = client.creative_package_until ?? null;
  const active = client.creative_package && (!until || until >= today);
  return (
    <div className="mx-auto grid max-w-6xl gap-8">
      {/* Header */}
      <header className="grid gap-3">
        <Link href="/clients" className="text-xs text-muted hover:text-fg">
          ← Clients
        </Link>
        <h1 className="font-heading text-[32px] leading-tight">{client.name}</h1>
        <div className="flex flex-wrap items-center gap-2">
          {active ? (
            <span className={`${chip} bg-brand-soft text-brand-text`}>{packageLabel ? `${packageLabel} creative package` : "Creative package"}</span>
          ) : (
            <span className={`${chip} gap-1.5 border border-dashed border-line text-faint`}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <rect x="5" y="11" width="14" height="9" rx="2" />
                <path d="M8 11V8a4 4 0 0 1 8 0v3" />
              </svg>
              Not on a creative package
            </span>
          )}
          {active && until && <span className={`${chip} bg-warn-soft text-warn`}>Sprint until {untilLabel(until)}</span>}
          <span className={`${chip} bg-surface-2 capitalize text-muted`}>{client.status}</span>
          {client.client_type === "whitelabel" && <span className={`${chip} bg-surface-2 text-muted`}>White label</span>}
          {client.auto_approve_opt_in && <span className={`${chip} bg-ok-soft text-ok`}>Opted into auto-approval</span>}
          {client.kaizen_id && <span className={`${chip} tabular bg-surface-2 text-faint`}>ID {client.kaizen_id}</span>}
          <span className="ml-1 text-xs text-faint">
            Portal <span className="text-muted">ads.kaizenmarketing.agency/c/{client.slug}</span>
          </span>
        </div>
      </header>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* Main column: what the AI knows and what the team adds to it */}
        <div className="grid min-w-0 gap-6">
          {active && (
            <BriefingPanel
              demo={demo}
              refresh={refreshClientBriefing.bind(null, client.id, client.slug)}
              description={
                <>
                  What the AI knows from Slack, email, Drive, Meta and past requests. Refreshes at 12pm and 6pm ET.
                  {briefingAt && <span className="text-faint"> Updated {fmt(briefingAt)}.</span>}
                </>
              }
            >
              {needsInvite.length > 0 && (
                <p className="rounded-[8px] border border-warn/30 bg-warn-soft px-4 py-3 text-sm text-warn">
                  The Slack bot can&apos;t read {needsInvite.join(" and ")} yet. It&apos;s private, so someone in it needs to type /invite and the bot&apos;s name.
                </p>
              )}
              {digest ? (
                <div className="grid gap-6 text-sm">
                  <div className="grid gap-3">
                    <p className="text-[15px] leading-relaxed">{digest.summary}</p>
                    {digest.direction && (
                      <p className="rounded-[8px] border-l-2 border-brand bg-brand-soft/30 px-4 py-3 leading-relaxed text-muted">
                        <span className="mb-1 block text-xs font-medium text-fg">Direction</span>
                        {digest.direction}
                      </p>
                    )}
                    {digest.performance && (
                      <p className="rounded-[8px] border-l-2 border-ok bg-ok-soft/30 px-4 py-3 leading-relaxed text-muted">
                        <span className="mb-1 block text-xs font-medium text-fg">Ad performance · Meta</span>
                        {digest.performance}
                      </p>
                    )}
                  </div>
                  <div className="grid gap-x-10 gap-y-7 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                    {(
                      [
                        ["Asks", digest.asks, "bg-fg"],
                        ["Avoid", digest.avoid, "bg-bad"],
                        ["Works", digest.works, "bg-ok"],
                        ["Open questions", digest.openQuestions, "bg-warn"],
                      ] as const
                    )
                      .filter(([, items]) => items.length > 0)
                      .map(([title, items, dot]) => (
                        <div key={title} className="grid min-w-0 content-start gap-3">
                          <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.12em] text-faint">
                            <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
                            {title}
                          </p>
                          <ul className="grid gap-2.5 leading-relaxed text-muted">
                            {items.map((x) => (
                              <li key={x}>{x}</li>
                            ))}
                          </ul>
                        </div>
                      ))}
                  </div>
                  {digest.newAssets.length > 0 && (
                    <div className="grid gap-2.5 border-t border-line pt-5">
                      <p className="text-xs font-medium uppercase tracking-[0.12em] text-faint">New Drive assets not used yet</p>
                      <ul className="grid gap-2">
                        {digest.newAssets.map((a) => (
                          <li key={a.url || a.name} className="leading-relaxed text-muted">
                            {a.url ? (
                              <a href={a.url} target="_blank" rel="noreferrer" className="text-fg underline decoration-line underline-offset-4 hover:decoration-fg">
                                {a.name}
                              </a>
                            ) : (
                              <span className="text-fg">{a.name}</span>
                            )}
                            {a.note && <span className="text-faint"> · {a.note}</span>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm text-faint">No briefing yet. It&apos;s made at the next 12pm or 6pm run, or now with Refresh now.</p>
              )}
            </BriefingPanel>
          )}

          <BrandBiblePanel clientId={client.id} slug={client.slug} bible={brandBible} canBuild={can.assign} />

          <Section title="Client memory" description="What we've learned about this client. The AI reads it for suggestions and flags anything that goes against it before a request is sent.">
            {memory.length > 0 ? (
              <ul className="grid gap-2">
                {memory.map((m) => (
                  <li key={m.id} className={row}>
                    <span className="flex min-w-0 items-start gap-3">
                      <span
                        className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                          m.kind === "avoid" ? "bg-bad-soft text-bad" : m.kind === "prefer" ? "bg-ok-soft text-ok" : "bg-bg text-muted"
                        }`}
                      >
                        {m.kind === "avoid" ? "Avoid" : m.kind === "prefer" ? "Works" : "Note"}
                      </span>
                      <span className="grid min-w-0 gap-0.5">
                        <span className="leading-relaxed">{m.body}</span>
                        <span className="text-xs text-faint">
                          {m.source === "client" ? "Client said" : "Team"}
                          {m.by ? ` · ${m.by}` : ""}
                        </span>
                      </span>
                    </span>
                    <ActionButton action={archiveMemory.bind(null, client.slug, m.id)} label="Remove" confirmText="Remove this?" />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-faint">Nothing yet. Add what the client loves, hates, or asked us never to do again.</p>
            )}
            <ActionForm action={addMemory.bind(null, client.id, client.slug)} submitLabel="Add to memory" resetOnSuccess className="grid gap-4 border-t border-line pt-5">
              <div className="grid gap-3 sm:grid-cols-[150px_150px_minmax(0,1fr)]">
                <label className={label}>
                  Type
                  <select name="kind" className={field} defaultValue="avoid">
                    <option value="avoid">Avoid</option>
                    <option value="prefer">Works well</option>
                    <option value="note">Note</option>
                  </select>
                </label>
                <label className={label}>
                  From
                  <select name="source" className={field} defaultValue="client">
                    <option value="client">Client said</option>
                    <option value="team">Team</option>
                  </select>
                </label>
                <label className={label}>
                  What should the AI know?
                  <input name="body" required maxLength={1000} className={field} placeholder="e.g. Don't mention delivery, pickup only until December" />
                </label>
              </div>
            </ActionForm>
          </Section>

          <Section title="Angles & avatars" description="Copy is approved once per angle and reused for every creative on it.">
            {angles.length > 0 ? (
              <ul className="grid gap-2 sm:grid-cols-2">
                {angles.map((a) => (
                  <li key={a.id} className={`${row} ${a.status === "archived" ? "opacity-50" : ""}`}>
                    <span className="grid min-w-0 gap-0.5">
                      <span>
                        {a.name} <span className="text-xs capitalize text-faint">· {a.kind}</span>
                      </span>
                      {a.description && <span className="text-xs leading-relaxed text-muted">{a.description}</span>}
                    </span>
                    <ActionButton
                      action={setAngleStatus.bind(null, client.slug, a.id, a.status === "archived" ? "active" : "archived")}
                      label={a.status === "archived" ? "Restore" : "Archive"}
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-faint">No angles yet. They&apos;re also created from requests.</p>
            )}
            <ActionForm action={addAngle.bind(null, client.id, client.slug)} submitLabel="Add angle" resetOnSuccess className="grid gap-4 border-t border-line pt-5">
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_150px_minmax(0,1.4fr)]">
                <label className={label}>
                  Name
                  <input name="name" required className={field} placeholder="e.g. Fresh, never frozen" />
                </label>
                <label className={label}>
                  Type
                  <select name="kind" className={field}>
                    <option value="angle">Angle</option>
                    <option value="avatar">Avatar</option>
                  </select>
                </label>
                <label className={label}>
                  <span>
                    Description <span className="font-normal text-faint">(optional)</span>
                  </span>
                  <input name="description" className={field} />
                </label>
              </div>
            </ActionForm>
          </Section>
        </div>

        {/* Side column: who, how much, and how it's wired */}
        <div className="grid min-w-0 gap-6">
          <PackagePanel
            active={active}
            packageLabel={packageLabel}
            packageKey={client.creative_package_key ?? null}
            until={client.creative_package_until ?? null}
            note={client.creative_package_note ?? null}
            today={today}
            images={images}
            videos={videos}
            imagesUsed={imagesUsed}
            videosUsed={videosUsed}
            packages={packages}
            can={{ exec: can.admin, allot: can.allot }}
            setSprint={setSprintPackage.bind(null, client.id, client.slug)}
            endPackage={endCreativePackage.bind(null, client.id, client.slug)}
            saveAllotment={saveAllotment.bind(null, client.id, client.slug)}
          />

          <Section title="Kaizen team" description="Camille reviews all copy and Jorgi handles every client.">
            <dl className="grid gap-1">
              {SLOTS.map((slot) => (
                <div key={slot.value} className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-3">
                  <dt className="text-sm text-muted">{slot.label}</dt>
                  <dd className="min-w-0">
                    <AssignSelect clientId={client.id} slot={slot.value} label={slot.label} current={team[slot.value]?.current ?? null} options={team[slot.value]?.options ?? []} canEdit={can.assign} size="md" />
                  </dd>
                </div>
              ))}
            </dl>
          </Section>

          <Section title="Client contacts" description="They get a magic link and can approve. The first approval counts.">
            {contacts.length > 0 ? (
              <ul className="grid gap-2">
                {contacts.map((c) => (
                  <li key={c.id} className={row}>
                    <span className="grid min-w-0 gap-0.5">
                      <span className="truncate">{c.full_name ?? c.email}</span>
                      <span className="truncate text-xs text-faint">
                        {c.full_name ? `${c.email} · ` : ""}
                        {c.auth_user_id ? "Signed in" : "Not signed in yet"}
                      </span>
                    </span>
                    {can.contacts && <ActionButton action={removeContact.bind(null, client.id, client.slug, c.id)} label="Remove" confirmText="Remove?" />}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-faint">No contacts yet.</p>
            )}
            {can.contacts && (
              <ActionForm action={addContact.bind(null, client.id, client.slug)} submitLabel="Add contact" resetOnSuccess className="grid gap-4 border-t border-line pt-5">
                <div className="grid gap-3">
                  <label className={label}>
                    Email
                    <input name="email" type="email" required className={field} placeholder="name@brand.com" />
                  </label>
                  <label className={label}>
                    <span>
                      Name <span className="font-normal text-faint">(optional)</span>
                    </span>
                    <input name="name" className={field} />
                  </label>
                </div>
              </ActionForm>
            )}
          </Section>

          <Section title="Details">
            {can.admin ? (
              <ActionForm action={saveClientDetails.bind(null, client.id, client.slug)} submitLabel="Save details" className="grid gap-5">
                <div className="grid grid-cols-2 gap-3">
                  <label className={label}>
                    Status
                    <select name="status" defaultValue={client.status} className={field}>
                      <option value="onboarding">Onboarding</option>
                      <option value="active">Active</option>
                      <option value="paused">Paused</option>
                      <option value="offboarded">Offboarded</option>
                    </select>
                  </label>
                  <label className={label}>
                    Type
                    <select name="client_type" defaultValue={client.client_type} className={field}>
                      <option value="traditional">Traditional</option>
                      <option value="whitelabel">White label</option>
                    </select>
                  </label>
                </div>
                <div className="grid gap-3 border-t border-line pt-5">
                  <p className="text-xs font-medium uppercase tracking-[0.12em] text-faint">Connections</p>
                  <label className={label}>
                    Meta ad account ID
                    <span className="relative block">
                      <input name="meta_ad_account_id" defaultValue={client.meta_ad_account_id ?? ""} className={`${field} tabular pr-20`} placeholder="From Ads Manager, e.g. 6615…" />
                      {connections.meta?.tone === "ok" && (
                        <span className="pointer-events-none absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-1.5 text-[11px] font-medium text-ok">
                          <span className="relative flex h-2 w-2">
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok opacity-60" />
                            <span className="relative inline-flex h-2 w-2 rounded-full bg-ok" />
                          </span>
                          Live
                        </span>
                      )}
                    </span>
                    <ConnectionStatus status={connections.meta} sync={syncMetaNow.bind(null, client.id, client.slug)} demo={demo} />
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <label className={label}>
                      Client Slack channel
                      <input name="slack_channel_id" defaultValue={client.slack_channel_id ?? ""} className={field} placeholder="Linked automatically" />
                      <ConnectionStatus status={connections.slackClient} />
                    </label>
                    <label className={label}>
                      Internal Slack channel
                      <input name="internal_slack_channel_id" defaultValue={client.internal_slack_channel_id ?? ""} className={field} placeholder="Linked automatically" />
                      <ConnectionStatus status={connections.slackInternal} />
                    </label>
                  </div>
                  <label className={label}>
                    <span>
                      Drive folder <span className="font-normal text-faint">(ID or link)</span>
                    </span>
                    <input name="drive_folder_id" defaultValue={client.drive_folder_id ?? ""} className={field} placeholder="Linked automatically" />
                    <ConnectionStatus status={connections.drive} />
                  </label>
                  <div className="grid grid-cols-[minmax(0,1fr)_110px] gap-3">
                    <label className={label}>
                      Website
                      <input name="website" defaultValue={client.website ?? ""} className={field} placeholder="https://" />
                    </label>
                    <label className={label}>
                      Client ID
                      <input name="kaizen_id" defaultValue={client.kaizen_id ?? ""} className={`${field} tabular`} inputMode="numeric" />
                    </label>
                  </div>
                </div>
              </ActionForm>
            ) : (
              <dl className="grid gap-2.5 text-sm">
                <div className="flex justify-between gap-3">
                  <dt className="text-muted">Status</dt>
                  <dd className="capitalize">{client.status}</dd>
                </div>
                {(
                  [
                    ["Meta ad account", connections.meta, true],
                    ["Client Slack", connections.slackClient, false],
                    ["Internal Slack", connections.slackInternal, false],
                    ["Drive folder", connections.drive, false],
                  ] as const
                ).map(([k, st, canSync]) => (
                  <div key={k} className="grid gap-1">
                    <dt className="text-muted">{k}</dt>
                    <dd>{st ? <ConnectionStatus status={st} sync={canSync ? syncMetaNow.bind(null, client.id, client.slug) : undefined} demo={demo} /> : <span className="text-faint">Not linked</span>}</dd>
                  </div>
                ))}
              </dl>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}
