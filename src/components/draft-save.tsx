"use client";

import { useState } from "react";
import { saveCallDraft } from "@/app/(team)/settings/call-actions";
import { saveCallDraftToPlatform } from "@/app/(team)/assistant/document-actions";
import type { CallDraft } from "@/lib/agent-call/core";
import { fixGmailLink } from "@/lib/email-filters";
import { connectHref } from "@/lib/personal-connections-core";

/** Reconnecting Slack from the card comes back to the conversation (/connected tells it) */
const RECONNECT = connectHref("slack")!;

// The draft card's way out to where people send things themselves: Save to Gmail drafts (a real draft in their own
// mailbox, in the thread, PDFs attached) or Put in my Slack (a message to themselves, labeled with where it goes, since
// Slack lets no app write into someone's Drafts). Once saved, a link straight to it. Never sends.

export function DraftSave({ callId, d, text }: { callId: string | null; d: CallDraft; text: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ text: string; fallback: boolean; connect?: boolean } | null>(null);
  const [saved, setSaved] = useState<{ to: "gmail" | "slack"; href: string | null; unsure?: boolean } | null>(d.status === "gmail_draft" ? { to: "gmail", href: fixGmailLink(d.link ?? null) } : d.status === "slack_draft" ? { to: "slack", href: d.link ?? null } : null);
  const slack = d.channel === "slack";
  const save = async () => {
    if (!callId) return;
    // Opened now (the click allows it), pointed at the draft once it's saved
    const tab = slack ? null : window.open("about:blank", "_blank");
    setBusy(true);
    setErr(null);
    const edited = text.trim() !== d.text.trim() ? await saveCallDraft(callId, d.id, text) : { ok: true as const };
    const r = edited.ok ? await saveCallDraftToPlatform(callId, d.id) : { ok: false as const, error: edited.error };
    setBusy(false);
    if (!r.ok) {
      tab?.close();
      // Slack not connected or expired: the Connect / Reconnect right here instead of a dead end
      return setErr({ text: r.error, fallback: !slack && Boolean(d.compose), connect: slack && "needsConnect" in r && Boolean(r.needsConnect) });
    }
    setSaved({ to: r.to, href: r.href, unsure: r.unsure });
    if (tab && r.href) tab.location.href = r.href;
    else tab?.close();
  };
  if (d.status === "sent") return null;
  if (saved)
    return (
      <p className="w-full text-[12px] text-muted" role="status">
        {saved.to === "gmail"
          ? `It's in your Gmail drafts${d.attachments?.length ? ", with the PDF attached" : ""}, ready to edit and send.`
          : saved.unsure
            ? "Posted with your Slack. If it isn't under your messages to yourself, it's in your DM with Slackbot."
            : "It's in your Slack, in your messages to yourself: copy it into the thread and send."}{" "}
        {saved.href && (
          <a href={saved.href} target="_blank" rel="noopener noreferrer" className="font-medium text-brand-text underline-offset-2 hover:underline">
            {saved.to === "gmail" ? "Open in Gmail" : "Open in Slack"}
          </a>
        )}
        {saved.unsure && (
          <>
            {" · "}
            <a href={RECONNECT} target="_blank" rel="noopener noreferrer" className="font-medium text-brand-text underline-offset-2 hover:underline">
              Reconnect Slack so drafts always land in your own DM
            </a>
          </>
        )}
      </p>
    );
  return (
    <>
      {err && (
        <p role="alert" className="w-full text-[12px] text-bad">
          {err.text}
          {err.connect && (
            <>
              {" "}
              <a href={RECONNECT} target="_blank" rel="noopener noreferrer" className="font-medium text-fg underline underline-offset-2">
                Connect your Slack
              </a>
            </>
          )}
          {err.fallback && d.compose && (
            <>
              {" "}
              <a href={d.compose} target="_blank" rel="noopener noreferrer" className="font-medium text-fg underline underline-offset-2">
                Open a new email instead
              </a>
            </>
          )}
        </p>
      )}
      {!callId && !slack && d.compose && (
        <a href={d.compose} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center rounded-full border border-line px-4 text-[13px] text-muted transition-colors hover:border-faint hover:text-fg md:min-h-9">
          Open in Gmail
        </a>
      )}
      {callId && (
        <button type="button" disabled={busy || !text.trim()} onClick={save} className="inline-flex min-h-11 items-center rounded-full border border-line px-4 text-[13px] text-muted transition-colors hover:border-faint hover:text-fg disabled:opacity-50 md:min-h-9">
          {busy ? "Saving…" : slack ? "Put in my Slack" : "Save to Gmail drafts"}
        </button>
      )}
    </>
  );
}
