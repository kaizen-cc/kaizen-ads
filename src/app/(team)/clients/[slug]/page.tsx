import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionButton, ActionForm } from "@/components/action-form";
import { isExecOrLead, requireStaff, seesAllClients } from "@/lib/auth";
import { SLOTS, type TeamRole } from "@/lib/roles";
import { AssignSelect } from "../assign-select";
import { createClient } from "@/lib/supabase/server";
import type { Digest } from "@/lib/ai";
import { addAngle, addContact, addMemory, archiveMemory, refreshClientBriefing, removeContact, saveAllotment, saveClientDetails, setAngleStatus } from "./actions";

// Refreshing a briefing asks the AI to read everything new about the client
export const maxDuration = 120;

const field = "h-9 w-full rounded-brand border border-line bg-bg px-3 text-sm outline-none focus:border-brand-text";
const label = "grid gap-1 text-xs text-muted";

export default async function ClientPage({ params }: PageProps<"/clients/[slug]">) {
  const me = await requireStaff();
  const { slug } = await params;
  const supabase = await createClient();

  const { data: client } = await supabase
    .from("clients")
    .select("id, name, slug, status, client_type, website, meta_ad_account_id, slack_channel_id, internal_slack_channel_id, drive_folder_id, kaizen_id, auto_approve_opt_in, creative_package")
    .eq("slug", slug)
    .maybeSingle();
  if (!client) notFound();

  const [{ data: assignments }, { data: links }, { data: angles }, { data: allotment }, { data: staff }, { data: memory }, { data: briefing }] = await Promise.all([
    supabase.from("client_assignments").select("role, profile_id, profiles(full_name)").eq("client_id", client.id),
    supabase.from("contact_clients").select("is_primary, contacts(id, email, full_name, auth_user_id)").eq("client_id", client.id),
    supabase.from("angles").select("id, name, kind, description, status").eq("client_id", client.id).order("status").order("name"),
    supabase.from("client_allotments").select("images_per_month, videos_per_month").eq("client_id", client.id).maybeSingle(),
    supabase.from("profiles").select("id, full_name, role").eq("is_active", true).order("full_name"),
    supabase
      .from("client_memory")
      .select("id, kind, body, source, created_at, profiles(full_name)")
      .eq("client_id", client.id)
      .eq("status", "active")
      .order("created_at", { ascending: false }),
    supabase.from("client_briefings").select("digest, generated_at, sources").eq("client_id", client.id).maybeSingle(),
  ]);
  const digest = briefing?.digest && Object.keys(briefing.digest).length ? (briefing.digest as Digest) : null;

  const canAdmin = me.isExec;
  const canContacts = seesAllClients(me);
  const canAllot = me.isExec || me.isLead;
  const canAssign = isExecOrLead(me);
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

  return (
    <div className="grid max-w-5xl gap-6">
      <div>
        <Link href="/clients" className="text-xs text-muted hover:text-fg">
          ← Clients
        </Link>
        <h1 className="mt-1 font-heading text-2xl">{client.name}</h1>
        <p className="mt-1 text-sm text-muted">
          Client portal: <span className="text-fg">ads.kaizenmarketing.agency/c/{client.slug}</span>
          {client.creative_package ? (
            <span className="ml-2 rounded-full bg-brand-soft px-2 py-0.5 text-xs text-brand-text">Creative package</span>
          ) : (
            <span className="ml-2 rounded-full bg-surface-2 px-2 py-0.5 text-xs text-faint">Not on a creative package</span>
          )}
          {client.auto_approve_opt_in && <span className="ml-2 rounded-full bg-ok-soft px-2 py-0.5 text-xs text-ok">Opted into auto-approval</span>}
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Team */}
        <section className="grid content-start gap-3 rounded-brand border border-line bg-surface p-5">
          <h2 className="font-medium">Kaizen team</h2>
          <dl className="grid gap-2">
            {SLOTS.map((slot) => (
              <div key={slot.value} className="grid grid-cols-[110px_1fr] items-center gap-3">
                <dt className="text-sm text-muted">{slot.label}</dt>
                <dd>
                  <AssignSelect
                    clientId={client.id}
                    slot={slot.value}
                    label={slot.label}
                    current={currentIn(slot.value)}
                    options={optionsFor(slot.eligible)}
                    canEdit={canAssign}
                    size="md"
                  />
                </dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-faint">Camille reviews all copy and Jorgi handles every client, so they aren&apos;t assigned per client.</p>
        </section>

        {/* Contacts */}
        <section className="grid content-start gap-3 rounded-brand border border-line bg-surface p-5">
          <h2 className="font-medium">Client contacts</h2>
          <p className="text-xs text-muted">These people get a magic link and can approve. The first approval counts.</p>
          <ul className="grid gap-1.5">
            {contacts.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-brand bg-surface-2 px-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="block truncate">{c.full_name ?? c.email}</span>
                  {c.full_name && <span className="block truncate text-xs text-muted">{c.email}</span>}
                </span>
                <span className="flex items-center gap-3">
                  <span className="text-[11px] text-faint">{c.auth_user_id ? "Has signed in" : "Not signed in yet"}</span>
                  {canContacts && (
                    <ActionButton action={removeContact.bind(null, client.id, client.slug, c.id)} label="Remove" confirmText={`Remove ${c.email}?`} />
                  )}
                </span>
              </li>
            ))}
            {contacts.length === 0 && <li className="text-sm text-faint">No contacts yet.</li>}
          </ul>
          {canContacts && (
            <ActionForm action={addContact.bind(null, client.id, client.slug)} submitLabel="Add contact" resetOnSuccess className="grid gap-2">
              <div className="grid gap-2 sm:grid-cols-2">
                <label className={label}>
                  Email
                  <input name="email" type="email" required className={field} placeholder="name@brand.com" />
                </label>
                <label className={label}>
                  Name (optional)
                  <input name="name" className={field} />
                </label>
              </div>
            </ActionForm>
          )}
        </section>

        {/* Angles */}
        <section className="grid content-start gap-3 rounded-brand border border-line bg-surface p-5 lg:col-span-2">
          <h2 className="font-medium">Angles &amp; avatars</h2>
          <p className="text-xs text-muted">Copy is approved once per angle and reused for every creative on it.</p>
          <ul className="grid gap-1.5 sm:grid-cols-2">
            {(angles ?? []).map((a) => (
              <li key={a.id} className={`flex items-start justify-between gap-2 rounded-brand bg-surface-2 px-3 py-2 text-sm ${a.status === "archived" ? "opacity-50" : ""}`}>
                <span className="min-w-0">
                  <span className="block">
                    {a.name} <span className="text-[11px] text-faint">{a.kind}</span>
                  </span>
                  {a.description && <span className="block text-xs text-muted">{a.description}</span>}
                </span>
                <ActionButton
                  action={setAngleStatus.bind(null, client.slug, a.id, a.status === "archived" ? "active" : "archived")}
                  label={a.status === "archived" ? "Restore" : "Archive"}
                />
              </li>
            ))}
            {(angles ?? []).length === 0 && <li className="text-sm text-faint">No angles yet. They&apos;ll also be created from requests and the onboarding agent.</li>}
          </ul>
          <ActionForm action={addAngle.bind(null, client.id, client.slug)} submitLabel="Add angle" resetOnSuccess className="grid gap-2">
            <div className="grid gap-2 sm:grid-cols-[1fr_140px_2fr]">
              <label className={label}>
                Name
                <input name="name" required className={field} placeholder="Fresh, never frozen" />
              </label>
              <label className={label}>
                Type
                <select name="kind" className={field}>
                  <option value="angle">Angle</option>
                  <option value="avatar">Avatar</option>
                </select>
              </label>
              <label className={label}>
                Description (optional)
                <input name="description" className={field} />
              </label>
            </div>
          </ActionForm>
        </section>

        {/* Briefing */}
        {client.creative_package && (
          <section className="grid content-start gap-4 rounded-brand border border-line bg-surface p-5 lg:col-span-2">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="font-medium">Briefing</h2>
                <p className="mt-1 text-xs text-muted">
                  What the AI knows from Slack, email, Drive and past requests. It refreshes at 12pm and 6pm ET and feeds the request form.
                  {briefing && (
                    <>
                      {" "}
                      Last updated{" "}
                      {new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }).format(new Date(briefing.generated_at))}.
                    </>
                  )}
                </p>
              </div>
              <ActionButton action={refreshClientBriefing.bind(null, client.id, client.slug)} label="Refresh briefing" />
            </div>
            {digest ? (
              <div className="grid gap-4 text-sm">
                <p className="leading-relaxed">{digest.summary}</p>
                {digest.direction && (
                  <p className="text-muted">
                    <span className="text-faint">Direction · </span>
                    {digest.direction}
                  </p>
                )}
                <div className="grid gap-4 sm:grid-cols-2">
                  {(
                    [
                      ["Asks", digest.asks, "text-fg"],
                      ["Avoid", digest.avoid, "text-bad"],
                      ["Works", digest.works, "text-ok"],
                      ["Open questions", digest.openQuestions, "text-warn"],
                    ] as const
                  )
                    .filter(([, items]) => items.length > 0)
                    .map(([title, items, tone]) => (
                      <div key={title} className="grid content-start gap-1.5">
                        <p className={`text-xs font-medium ${tone}`}>{title}</p>
                        <ul className="grid gap-1 text-muted">
                          {items.map((x) => (
                            <li key={x}>· {x}</li>
                          ))}
                        </ul>
                      </div>
                    ))}
                </div>
                {digest.newAssets.length > 0 && (
                  <div className="grid gap-1.5">
                    <p className="text-xs font-medium">New Drive assets not used yet</p>
                    <ul className="grid gap-1">
                      {digest.newAssets.map((a) => (
                        <li key={a.url || a.name} className="text-muted">
                          {a.url ? (
                            <a href={a.url} target="_blank" rel="noreferrer" className="text-brand-text hover:underline">
                              {a.name}
                            </a>
                          ) : (
                            a.name
                          )}
                          {a.note && <span className="text-faint"> · {a.note}</span>}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-sm text-faint">No briefing yet. It&apos;s made at the next 12pm or 6pm run, or now with Refresh briefing.</p>
            )}
          </section>
        )}

        {/* Client memory */}
        <section className="grid content-start gap-3 rounded-brand border border-line bg-surface p-5 lg:col-span-2">
          <div>
            <h2 className="font-medium">Client memory</h2>
            <p className="mt-1 text-xs text-muted">
              What we&apos;ve learned about this client. The AI reads it when suggesting requests and flags anything that goes against it before a request is sent.
            </p>
          </div>
          <ul className="grid gap-1.5">
            {(memory ?? []).map((m) => (
              <li key={m.id} className="flex items-start justify-between gap-3 rounded-brand bg-surface-2 px-3 py-2.5 text-sm">
                <span className="flex min-w-0 items-start gap-2.5">
                  <span
                    className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                      m.kind === "avoid" ? "bg-bad-soft text-bad" : m.kind === "prefer" ? "bg-ok-soft text-ok" : "bg-bg text-muted"
                    }`}
                  >
                    {m.kind === "avoid" ? "Avoid" : m.kind === "prefer" ? "Works" : "Note"}
                  </span>
                  <span className="min-w-0">
                    <span className="block">{m.body}</span>
                    <span className="block text-[11px] text-faint">
                      {m.source === "client" ? "Client said" : "Team"}
                      {(m.profiles as unknown as { full_name: string } | null)?.full_name ? ` · added by ${(m.profiles as unknown as { full_name: string }).full_name}` : ""}
                    </span>
                  </span>
                </span>
                <ActionButton action={archiveMemory.bind(null, client.slug, m.id)} label="Remove" confirmText="Remove this from the client's memory?" />
              </li>
            ))}
            {(memory ?? []).length === 0 && <li className="text-sm text-faint">Nothing yet. Add what the client loves, hates, or asked us never to do again.</li>}
          </ul>
          <ActionForm action={addMemory.bind(null, client.id, client.slug)} submitLabel="Add to memory" resetOnSuccess className="grid gap-2">
            <div className="grid gap-2 sm:grid-cols-[130px_130px_1fr]">
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
                <input name="body" required maxLength={1000} className={field} placeholder="Don't mention delivery; pickup only until December" />
              </label>
            </div>
          </ActionForm>
        </section>

        {/* Allotment */}
        <section className="grid content-start gap-3 rounded-brand border border-line bg-surface p-5">
          <h2 className="font-medium">Monthly allotment</h2>
          {canAllot ? (
            <ActionForm action={saveAllotment.bind(null, client.id, client.slug)} submitLabel="Save allotment" className="grid gap-3">
              <div className="grid grid-cols-2 gap-2">
                <label className={label}>
                  Images per month
                  <input name="images" type="number" min={0} defaultValue={allotment?.images_per_month ?? 0} className={field} />
                </label>
                <label className={label}>
                  Videos per month
                  <input name="videos" type="number" min={0} defaultValue={allotment?.videos_per_month ?? 0} className={field} />
                </label>
              </div>
            </ActionForm>
          ) : (
            <p className="text-sm">
              {allotment?.images_per_month ?? 0} images · {allotment?.videos_per_month ?? 0} videos per month
            </p>
          )}
        </section>

        {/* Details */}
        <section className="grid content-start gap-3 rounded-brand border border-line bg-surface p-5">
          <h2 className="font-medium">Details</h2>
          {canAdmin ? (
            <ActionForm action={saveClientDetails.bind(null, client.id, client.slug)} submitLabel="Save details" className="grid gap-3">
              <div className="grid gap-2 sm:grid-cols-2">
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
                <label className={label}>
                  Meta ad account ID
                  <input name="meta_ad_account_id" defaultValue={client.meta_ad_account_id ?? ""} className={field} placeholder="661576002884215" />
                </label>
                <label className={label}>
                  Slack channel with the client
                  <input name="slack_channel_id" defaultValue={client.slack_channel_id ?? ""} className={field} placeholder="C0123ABCD" />
                </label>
                <label className={label}>
                  Internal Slack channel
                  <input name="internal_slack_channel_id" defaultValue={client.internal_slack_channel_id ?? ""} className={field} placeholder="C0456EFGH" />
                </label>
                <label className={label}>
                  Drive folder (ID or link)
                  <input name="drive_folder_id" defaultValue={client.drive_folder_id ?? ""} className={field} placeholder="Matched automatically from the Clients drive" />
                </label>
                <label className={label}>
                  Website
                  <input name="website" defaultValue={client.website ?? ""} className={field} />
                </label>
                <label className="flex items-center gap-2.5 self-end rounded-brand border border-line bg-bg px-3 py-2 text-sm sm:col-span-2">
                  <input type="checkbox" name="creative_package" defaultChecked={client.creative_package} className="h-4 w-4 accent-[var(--brand)]" />
                  <span>
                    On a creative package
                    <span className="block text-xs text-muted">Only these clients can get creative requests. Set their allotment too.</span>
                  </span>
                </label>
                <label className={label}>
                  Account Overview ID
                  <input name="kaizen_id" defaultValue={client.kaizen_id ?? ""} className={field} inputMode="numeric" />
                </label>
              </div>
            </ActionForm>
          ) : (
            <dl className="grid gap-1.5 text-sm">
              <div className="flex justify-between"><dt className="text-muted">Status</dt><dd>{client.status}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Meta ad account</dt><dd>{client.meta_ad_account_id ?? "—"}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Slack channel</dt><dd>{client.slack_channel_id ?? "—"}</dd></div>
            </dl>
          )}
        </section>
      </div>
    </div>
  );
}
