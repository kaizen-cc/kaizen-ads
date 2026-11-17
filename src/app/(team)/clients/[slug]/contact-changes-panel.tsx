import { ActionButton, ActionForm } from "@/components/action-form";
import { field } from "@/components/ui";
import type { ChangeItem } from "@/lib/contact-changes-core";
import type { RequestView } from "@/lib/contact-changes";
import { bringBackContact, decideContactChange } from "./actions";

// Under the client's contacts: changes their emails asked for (waiting to be confirmed, or applied on their own and
// undoable for two weeks), and the people taken off, quietly, with when, by whom (or by the client's email, in their
// words) and a way to bring them back. A server component: the buttons are the shared action buttons.

export type RemovedContact = { id: string; email: string; name: string | null; at: string; by: string | null; source: string | null; reason: string | null };

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
const who = (c: Pick<ChangeItem, "name" | "email" | "asWritten">) => (c.name && c.email ? `${c.name} (${c.email})` : (c.email ?? `"${c.asWritten}"`));

function ChangeRow({ r, c, i, clientId, slug, contacts, canEdit }: { r: RequestView; c: ChangeItem; i: number; clientId: string; slug: string; contacts: { id: string; email: string; full_name: string | null }[]; canEdit: boolean }) {
  const verb = c.kind === "add" ? "Add" : "Take off";
  const state = c.status === "applied" ? (c.kind === "add" ? "Added" : "Taken off") : c.status === "dismissed" ? "Dismissed" : c.status === "undone" ? "Undone" : c.status === "blocked" ? "Can't apply" : null;
  const act = (what: "apply" | "dismiss" | "undo") => decideContactChange.bind(null, clientId, slug, r.id, i, what);
  const needsPick = c.status === "pending" && c.kind === "remove" && !c.contactId;
  return (
    <li className="grid gap-2 rounded-[8px] bg-surface-2/70 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <span className="min-w-0 flex-1">
          <span className="text-muted">{verb} </span>
          <span className="break-words">{who(c)}</span>
          {c.kind === "remove" && c.email && c.asWritten.toLowerCase() !== c.email && <span className="text-faint"> (written as &ldquo;{c.asWritten}&rdquo;)</span>}
          {c.reason && <span className="block text-xs text-faint">{c.reason}</span>}
          {c.note && c.status !== "applied" && <span className="block text-xs text-warn">{c.note}</span>}
        </span>
        {state && <span className="shrink-0 text-xs text-faint">{state}</span>}
      </div>
      {canEdit && c.status === "pending" && !needsPick && c.email && (
        <div className="flex flex-wrap items-center gap-x-4">
          <ActionButton action={act("apply")} label={c.kind === "add" ? "Add them" : "Take them off"} />
          <ActionButton action={act("dismiss")} label="Dismiss" />
        </div>
      )}
      {canEdit && needsPick && (
        <div className="grid gap-2">
          <ActionForm action={act("apply")} submitLabel="Take them off" className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <select name="contact" required className={field} defaultValue="">
              <option value="" disabled>
                Who is it?
              </option>
              {contacts.map((ct) => (
                <option key={ct.id} value={ct.id}>
                  {ct.full_name ? `${ct.full_name} (${ct.email})` : ct.email}
                </option>
              ))}
            </select>
          </ActionForm>
          <ActionButton action={act("dismiss")} label="Dismiss" />
        </div>
      )}
      {canEdit && c.status === "pending" && c.kind === "add" && !c.email && <ActionButton action={act("dismiss")} label="Dismiss" />}
      {canEdit && c.status === "applied" && r.status === "applied" && <ActionButton action={act("undo")} label="Undo" confirmText={c.kind === "add" ? "Take them back off?" : "Put them back on?"} />}
    </li>
  );
}

export function ContactChangesPanel({ clientId, slug, requests, removed, contacts, canEdit }: { clientId: string; slug: string; requests: RequestView[]; removed: RemovedContact[]; contacts: { id: string; email: string; full_name: string | null }[]; canEdit: boolean }) {
  if (!requests.length && !removed.length) return null;
  return (
    <div className="grid gap-5 border-t border-line pt-5">
      {requests.map((r) => (
        <div key={r.id} className="grid gap-2">
          <div className="grid gap-1">
            <p className="text-sm font-medium">
              {r.status === "to_confirm" ? "Contact change to confirm" : "Changed from their email"}
              <span className="font-normal text-faint"> · {day(r.receivedAt)}</span>
            </p>
            <p className="text-xs text-muted">
              From {r.fromName ? `${r.fromName} (${r.from})` : r.from}
              {r.forwardedBy ? `, forwarded by ${r.forwardedBy}` : ""}
              {r.url && (
                <>
                  {" · "}
                  <a href={r.url} target="_blank" rel="noreferrer" className="text-brand-text hover:underline">
                    Open the email
                  </a>
                </>
              )}
            </p>
            {r.quote && <blockquote className="border-l-2 border-line pl-3 text-sm italic text-muted">&ldquo;{r.quote}&rdquo;</blockquote>}
            {r.status === "to_confirm" && r.why && <p className="text-xs text-faint">Not applied on its own: {r.why}</p>}
          </div>
          <ul className="grid gap-2">
            {r.changes.map((c, i) => (
              <ChangeRow key={i} r={r} c={c} i={i} clientId={clientId} slug={slug} contacts={contacts} canEdit={canEdit} />
            ))}
          </ul>
        </div>
      ))}
      {removed.length > 0 && (
        <div className="grid gap-2">
          <p className="text-xs font-medium uppercase tracking-[0.12em] text-faint">Removed</p>
          <ul className="grid gap-1.5">
            {removed.map((c) => (
              <li key={c.id} className="flex items-start justify-between gap-3 px-1 py-1.5 text-sm">
                <span className="grid min-w-0 gap-0.5">
                  <span className="truncate text-muted">{c.name ?? c.email}</span>
                  <span className="text-xs text-faint">
                    {c.name ? `${c.email} · ` : ""}
                    {day(c.at)}, {c.source === "client_email" ? "by the client's email" : c.by ? `by ${c.by}` : "by the team"}
                  </span>
                  {c.reason && <span className="break-words text-xs italic text-faint">{c.reason}</span>}
                </span>
                {canEdit && <ActionButton action={bringBackContact.bind(null, clientId, slug, c.id)} label="Bring back" />}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
