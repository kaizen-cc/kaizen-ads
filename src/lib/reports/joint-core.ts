// Meta and TikTok in one weekly report: for a client running both, the TikTok part rides with the Meta report (the
// Meta buyer prepares it and sends it once: one PDF with both, one Slack message, one email). On by default; a client's
// report prefs can send them separately (client_report_prefs.tiktok_separate). Pure, so it's tested.

export type QueueTarget = { id: string; client_id: string; platform: string; owner_id: string | null };

/** Each TikTok target that joins a Meta report: the Meta target it rides with, and who owns it (the Meta report's owner) */
export function tiktokJoins(targets: readonly QueueTarget[], separate: ReadonlySet<string>): Map<string, { metaTargetId: string; owner: string | null }> {
  const out = new Map<string, { metaTargetId: string; owner: string | null }>();
  for (const t of targets) {
    if (t.platform !== "tiktok" || separate.has(t.client_id)) continue;
    const meta = targets.find((m) => m.platform === "meta" && m.client_id === t.client_id);
    if (meta) out.set(t.id, { metaTargetId: meta.id, owner: meta.owner_id ?? t.owner_id });
  }
  return out;
}

/** A weekly report's place in a Meta + TikTok report: the Meta report a TikTok part goes with, or the TikTok parts riding on a Meta report */
export type JointInfo = { goesWith: { id: string; owner: string | null; status: string } | null; riders: { id: string; platform: string; status: string }[] };
export type JointNote = { tone: "info" | "warn" | "ok"; title: string; detail: string; link: { href: string; label: string } | null };

const ready = (status: string) => !["queued", "drafting", "failed"].includes(status);
const statusWord = (status: string) => (status === "posted" ? "sent" : status === "submitted" ? "approved" : status === "draft" ? "ready to review" : status === "failed" ? "couldn't be written" : status === "skipped" ? "left out" : "being written");

/**
 * What the report studio says about a joint report, instead of an error when someone tries to send the TikTok part on
 * its own: on the TikTok part, that it goes out with the Meta report and who sends it; on the Meta report, that it
 * includes TikTok (and whether that part is ready). null when the report isn't part of one.
 */
export function jointNote(j: JointInfo | null | undefined): JointNote | null {
  if (!j) return null;
  if (j.goesWith) {
    const who = j.goesWith.owner ?? "the Meta buyer";
    const sent = j.goesWith.status === "posted";
    return {
      tone: sent ? "ok" : "info",
      title: sent ? "Sent with the Meta report" : `Goes out with the Meta report, sent by ${who}`,
      detail: sent
        ? `This TikTok part went to the client inside ${who}'s Meta report: one PDF, one Slack message, one email.`
        : `Review and edit this TikTok part here; it isn't sent on its own. ${who} sends it with the Meta report as one PDF, one Slack message and one email. To send TikTok separately, switch it in the client's report settings.`,
      link: { href: `/reports/${j.goesWith.id}`, label: "Open the Meta report →" },
    };
  }
  const riders = j.riders.filter((r) => r.status !== "skipped");
  if (!riders.length) return null;
  const tiktok = riders.find((r) => r.platform === "tiktok") ?? riders[0];
  const waiting = !ready(tiktok.status);
  return {
    tone: waiting ? "warn" : "info",
    title: "Includes TikTok",
    detail: waiting
      ? `The TikTok part is ${statusWord(tiktok.status)}. It goes out inside this report, so this one can be sent once it's ready.`
      : `The TikTok part (${statusWord(tiktok.status)}) goes out inside this report: one PDF with both, one Slack message, one email.`,
    link: { href: `/reports/${tiktok.id}`, label: "Open the TikTok part →" },
  };
}

/** The one Slack message for a joint report: the Meta buyer's message, then the TikTok part's under its own name */
export function jointMessage(main: string | null | undefined, parts: { platform: string; message: string | null | undefined }[]): string {
  const head = (main ?? "").trim();
  const more = parts
    .map((p) => ({ name: p.platform === "tiktok" ? "TikTok Ads" : p.platform === "google" ? "Google Ads" : "Meta Ads", text: (p.message ?? "").trim() }))
    .filter((p) => p.text)
    .map((p) => `*${p.name}*\n${p.text}`);
  return [head, ...more].filter(Boolean).join("\n\n");
}
