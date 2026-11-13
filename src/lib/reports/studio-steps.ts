// The report studio's steps, worked out from the report and the address: review the report, the message, send, sent.
// Which ways it can go out (Slack, email, and Drive for a month's report), and which of them this buyer used last time
// for this client. Plain functions, shared by the studio and its page and tested.

export type StudioStep = "report" | "message" | "send" | "done";
export type SendOption = "slack" | "email" | "drive";

type Shape = { kind: string; rider: boolean; built: boolean; isBuilder: boolean };

/**
 * The steps this report has. A TikTok part riding on the Meta report, and a buyer's part of a report someone else built,
 * are reviewed and approved here but sent by someone else: just the report, then sent. A monthly recap is the report
 * with its write-up under it, saved to the client's Drive from that same step (no message, nothing sent): the report,
 * then saved.
 */
export function stepsFor(r: Shape): StudioStep[] {
  if (r.rider || (r.built && !r.isBuilder) || r.kind === "monthly") return ["report", "done"];
  return ["report", "message", "send", "done"];
}

type State = Shape & { sent: boolean; mineDone: boolean; messageApproved: boolean };

/** Where the studio opens: sent ones on Sent; an approved part waiting on the others on Send; else the report */
export function initialStep(r: State): StudioStep {
  if (r.sent) return "done";
  if (r.built && r.isBuilder && r.mineDone) return r.messageApproved ? "send" : "message";
  return "report";
}

/** The furthest step that can be opened now: a built report's message waits for the builder's own part to be approved */
export function furthestStep(r: State): StudioStep {
  const steps = stepsFor(r);
  if (r.sent) return "done";
  if (r.built && !r.mineDone) return "report";
  return steps.includes("send") ? "send" : "report";
}

/** The step on screen: the one in the address (?step=) when it's one of this report's and can be opened, else where it opens */
export function resolveStep(asked: string | null | undefined, r: State): StudioStep {
  const initial = initialStep(r);
  if (r.sent) return "done";
  const steps = stepsFor(r);
  const at = steps.indexOf(asked as StudioStep);
  if (at < 0 || asked === "done") return initial;
  return at <= steps.indexOf(furthestStep(r)) ? (asked as StudioStep) : initial;
}

/** A whole calendar month: the 1st to the last day of the same month */
export function isWholeMonth(start: string, end: string): boolean {
  if (!/^\d{4}-\d{2}-01$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start.slice(0, 7) !== end.slice(0, 7)) return false;
  const [y, m] = start.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Number(end.slice(8, 10)) === last;
}

/** A month's report: the monthly recap, or a built report covering a whole calendar month */
export const isMonthReport = (r: { kind: string; start: string; end: string }) => r.kind === "monthly" || (r.kind === "built" && isWholeMonth(r.start, r.end));

/**
 * How it can go out. A week's report (or any other range): Slack or email. A month's report: saved to the client's
 * Drive only, with the write-up in it (customer success sends the month to the client as one email, with every team's).
 */
export function sendOptions(r: { kind: string; start: string; end: string }): SendOption[] {
  if (r.kind === "monthly") return ["drive"];
  // A built report of a whole month is the buyer's own: it can go to the client, or to Drive
  return isMonthReport(r) ? ["slack", "email", "drive"] : ["slack", "email"];
}

export type PastSend = { reportId: string | null; bundleId: string | null; platform: string | null; sentBy: string | null; channels: string[]; status?: string | null };

/**
 * "Last used": how this buyer sent their previous report for this client and platform (the newest send of theirs that
 * isn't this report, a send for several services counting for each), and Drive when the previous month's was saved there.
 * `sends` is newest first.
 */
export function lastUsed(sends: readonly PastSend[], now: { reportId: string; bundleId: string | null; platform: string; me: string }, previousDrive = false): SendOption[] {
  const prev = sends.find(
    (s) =>
      s.sentBy === now.me &&
      s.status !== "failed" &&
      s.reportId !== now.reportId &&
      !(now.bundleId && s.bundleId === now.bundleId) &&
      (s.platform === now.platform || s.platform === null) &&
      s.channels.some((c) => c === "slack" || c === "email"),
  );
  const out: SendOption[] = prev ? (["slack", "email"] as const).filter((c) => prev.channels.includes(c)) : [];
  return previousDrive ? [...out, "drive"] : out;
}

/**
 * The one way it goes out, picked to start with: how this buyer last sent one for this client (when it's offered here),
 * else Slack (or email when the client has no Slack channel to post in).
 */
export function defaultSendOption(offers: readonly SendOption[], last: readonly SendOption[], hasChannel = true): SendOption {
  const lastOne = last.find((o) => offers.includes(o));
  if (lastOne) return lastOne;
  if (!offers.includes("slack") && !offers.includes("email")) return offers[0] ?? "drive";
  return hasChannel ? "slack" : "email";
}

/** The channels a pick goes by: Slack or email alone, never both; Drive isn't a channel */
export function channelsFor(option: SendOption): ("slack" | "email")[] {
  return option === "drive" ? [] : [option];
}

export type PreviewFormat = "slack" | "email" | "pdf";
export const PREVIEW_FORMATS: PreviewFormat[] = ["slack", "email", "pdf"];

/** What the message step can preview: a week's report as Slack or email; a month's as the PDF saved to Drive */
export function previewFormatsFor(r: { kind: string; start: string; end: string }): PreviewFormat[] {
  if (r.kind === "monthly") return ["pdf"];
  return isMonthReport(r) ? ["slack", "email", "pdf"] : ["slack", "email"];
}

/** The format the message step opens on: the one in the address (if offered), else how this buyer last sent, else the first */
export function previewFormat(asked: string | null | undefined, last: readonly SendOption[], offered: readonly PreviewFormat[] = PREVIEW_FORMATS): PreviewFormat {
  if (offered.includes(asked as PreviewFormat)) return asked as PreviewFormat;
  return last.find((o): o is "slack" | "email" => (o === "slack" || o === "email") && offered.includes(o)) ?? offered[0];
}
