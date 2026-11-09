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

/** The one Slack message for a joint report: the Meta buyer's message, then the TikTok part's under its own name */
export function jointMessage(main: string | null | undefined, parts: { platform: string; message: string | null | undefined }[]): string {
  const head = (main ?? "").trim();
  const more = parts
    .map((p) => ({ name: p.platform === "tiktok" ? "TikTok Ads" : p.platform === "google" ? "Google Ads" : "Meta Ads", text: (p.message ?? "").trim() }))
    .filter((p) => p.text)
    .map((p) => `*${p.name}*\n${p.text}`);
  return [head, ...more].filter(Boolean).join("\n\n");
}
