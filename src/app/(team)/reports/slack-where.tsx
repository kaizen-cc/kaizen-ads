"use client";

import { useEffect, useState } from "react";
import { slackWhere, type SlackTarget } from "@/lib/reports/delivery-core";
import { slackChannelsFor, slackTargetDetails, slackThreadsIn } from "./slack-target-actions";

// Where the Slack post goes: the client's channel as a new message by default, or another channel, or a reply in a
// standing thread (a client who asked for every weekly report in one thread), optionally also shown in the channel.
// Remembered per client and line with the send, so next week's report goes to the same place.

type Thread = { ts: string; label: string; replies: number; at: string };

export function SlackWhere({ reportId, value, onChange, disabled }: { reportId: string; value: SlackTarget | null; onChange: (t: SlackTarget | null) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [channels, setChannels] = useState<{ id: string; name: string }[] | null>(null);
  const [channel, setChannel] = useState<string>("");
  const [threads, setThreads] = useState<Thread[] | null>(null);

  // A saved thread is checked once: if it's gone, the post goes to the channel and the buyer sees why
  const savedThread = value?.thread ?? null;
  const savedChannel = value?.channel ?? null;
  useEffect(() => {
    if (!savedThread || !savedChannel) return;
    let live = true;
    void slackTargetDetails(reportId, { target: { channel: savedChannel, thread: savedThread } }).then((r) => {
      if (live && r.ok) setGone(!r.threadOk);
    });
    return () => {
      live = false;
    };
  }, [reportId, savedThread, savedChannel]);

  const openPicker = async () => {
    setOpen(true);
    setNote(null);
    if (channels) return;
    const r = await slackChannelsFor(reportId);
    if (r.ok) setChannels(r.channels);
    else setNote(r.error);
  };
  const pickChannel = async (id: string) => {
    setChannel(id);
    setThreads(null);
    if (!id) return;
    const r = await slackThreadsIn(reportId, id);
    if (r.ok) setThreads(r.threads);
    else setNote(r.error);
  };
  const applyLink = async () => {
    if (!link.trim()) return;
    setBusy(true);
    setNote(null);
    const r = await slackTargetDetails(reportId, { link: link.trim(), target: { broadcast: value?.broadcast } });
    setBusy(false);
    if (!r.ok) return setNote(r.error);
    if (!r.threadOk) return setNote("Slack can't find that thread (deleted, or you're not in that channel).");
    onChange(r.target);
    setGone(false);
    setLink("");
    setOpen(false);
  };
  const name = channels?.find((c) => c.id === channel)?.name ?? null;

  return (
    <section className="grid gap-2.5 rounded-[18px] border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 text-[13px] text-fg">
          <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Slack · </span>
          {value ? slackWhere(value, null) : "Posting in the client's channel, as a new message"}
        </p>
        <span className="flex shrink-0 gap-1.5">
          {value && (
            <button type="button" disabled={disabled} onClick={() => onChange(null)} className="h-11 rounded-full px-3 text-[12.5px] text-muted hover:text-fg disabled:opacity-40 md:h-8">
              Use the client&rsquo;s channel
            </button>
          )}
          <button type="button" disabled={disabled} onClick={() => (open ? setOpen(false) : void openPicker())} className="h-11 rounded-full border border-line px-3.5 text-[12.5px] text-fg hover:border-faint disabled:opacity-40 md:h-8">
            {open ? "Done" : "Change"}
          </button>
        </span>
      </div>
      {gone && <p className="rounded-[10px] bg-warn-soft px-3 py-2 text-[12px] text-warn">The saved thread is gone in Slack, so this one posts in the channel itself. Pick the new thread to keep them together.</p>}
      {value?.thread && (
        <label className="flex items-center gap-2 text-[12.5px] text-muted">
          <input type="checkbox" checked={Boolean(value.broadcast)} disabled={disabled} onChange={(e) => onChange({ ...value, broadcast: e.target.checked })} className="h-4 w-4 accent-[var(--color-brand)]" />
          Also send to the channel
        </label>
      )}
      {open && (
        <div className="grid gap-3 border-t border-line pt-3">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void applyLink();
            }}
            className="grid gap-1.5"
          >
            <span className="text-[11.5px] text-faint">Paste the thread&rsquo;s link (in Slack: the thread&rsquo;s first message › Copy link)</span>
            <div className="flex gap-1.5">
              <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://….slack.com/archives/C…/p…" inputMode="url" className="h-11 min-w-0 flex-1 rounded-[10px] border border-line bg-bg px-3 text-sm outline-none focus:border-brand-text/60 md:h-9" />
              <button type="submit" disabled={busy || !link.trim()} className="h-11 shrink-0 rounded-[10px] bg-fg px-3.5 text-[13px] text-bg disabled:opacity-40 md:h-9">
                {busy ? "Checking…" : "Use it"}
              </button>
            </div>
          </form>
          <div className="grid gap-1.5">
            <span className="text-[11.5px] text-faint">Or pick a channel, then a thread in it</span>
            <select value={channel} onChange={(e) => void pickChannel(e.target.value)} disabled={!channels} className="h-11 rounded-[10px] border border-line bg-bg px-2 text-sm md:h-9">
              <option value="">{channels ? "Pick a channel…" : "Loading your channels…"}</option>
              {(channels ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  #{c.name}
                </option>
              ))}
            </select>
            {channel && (
              <div className="grid max-h-72 gap-1 overflow-y-auto">
                <button
                  type="button"
                  onClick={() => {
                    onChange({ channel, channelName: name, thread: null });
                    setOpen(false);
                  }}
                  className="rounded-[10px] border border-line px-3 py-2 text-left text-[13px] hover:border-faint"
                >
                  A new message in #{name ?? "this channel"}
                </button>
                {threads === null ? (
                  <p className="px-1 text-[12px] text-faint">Reading the channel…</p>
                ) : (
                  threads.map((t) => (
                    <button
                      key={t.ts}
                      type="button"
                      onClick={() => {
                        onChange({ channel, channelName: name, thread: t.ts, threadLabel: t.label, broadcast: value?.broadcast ?? false });
                        setGone(false);
                        setOpen(false);
                      }}
                      className="grid gap-0.5 rounded-[10px] border border-line px-3 py-2 text-left hover:border-faint"
                    >
                      <span className="truncate text-[13px] text-fg">{t.label}</span>
                      <span className="text-[11px] text-faint">
                        {new Date(t.at).toLocaleDateString("en-US", { month: "short", day: "numeric" })} · {t.replies ? `${t.replies} ${t.replies === 1 ? "reply" : "replies"}` : "no replies yet"}
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
          {note && <p className="text-[12px] text-bad">{note}</p>}
        </div>
      )}
    </section>
  );
}
