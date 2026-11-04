// Partial client approval, the same for single images, carousels and video: what the client approved goes ahead on
// its own ticket (split off, "· approved"), what they sent back stays on the original for revisions. These helpers
// decide what the client sees, what a copy-only rework launches with, and what the Board says about a ticket.

type CopyRow = { status: string } | null | undefined;

/** A ticket waiting on the client shows in their portal once its pieces are whole: designs (its own or the ones split
 *  off from it) and its copy approved, or no copy set at all (the angle's copy was approved on another ticket). */
export function readyForClient(stage: string, hasDesigns: boolean, copy: CopyRow) {
  return stage === "client_review" && hasDesigns && (!copy || copy.status === "approved");
}

type Ad = { primaryText?: string | null; headline?: string | null; linkDescription?: string | null };
const key = (a: Ad) => [a.primaryText, a.headline, a.linkDescription].map((x) => (x ?? "").trim().toLowerCase()).join("\u0001");

/** A copy-only rework (every design was approved and went ahead on the split): only the ads the split didn't already
 *  launch with, so the approved ones aren't made twice. */
export function reworkAds<T extends Ad>(own: T[], alreadyLaunched: Ad[]) {
  const done = new Set(alreadyLaunched.map(key));
  return own.filter((a) => !done.has(key(a)));
}

/** What the Board says about a ticket the client reviewed in part: "2 of 3 approved", and where the approved part went. */
export function clientProgress(designs: { client_status: string | null }[], splitNumbers: number[]) {
  const approved = designs.filter((d) => d.client_status === "approved").length;
  const changes = designs.filter((d) => d.client_status === "changes").length;
  const decided = approved + changes;
  const parts: string[] = [];
  if (approved && changes) parts.push(`${approved} of ${decided} approved by the client`);
  else if (changes && !splitNumbers.length) parts.push(`${changes} sent back by the client`);
  if (splitNumbers.length) parts.push(`Approved part went ahead as ${splitNumbers.map((n) => `#${n}`).join(", ")}`);
  return parts.length ? parts.join(" · ") : null;
}
