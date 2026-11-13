// The report studio's steps, worked out from the report and the address: review the report, the message, send, sent.
// Which ways it can go out (Slack, email, and Drive for a month's report), and which of them this buyer used last time
// for this client. Plain functions, shared by the studio and its page and tested.

export type StudioStep = "report" | "message" | "send" | "done";
export type SendOption = "slack" | "email" | "drive";

type Shape = { kind: string; rider: boolean; built: boolean; isBuilder: boolean };

/**
 * The steps this report has. A TikTok part riding on the Meta report, and a buyer's part of a report someone else built,
 * are reviewed and approved here but sent by someone else: just the report, then sent.
 */
export function stepsFor(r: Shape): StudioStep[] {
  if (r.rider || (r.built && !r.isBuilder)) return ["report", "done"];
  return ["report", "message", "send", "done"];
}

type State = Shape & { sent: boolean; mineDone: boolean; messageApproved: boolean };

/** Where the studio opens: sent ones on Sent; an approved part waiting on the others on Send; else the report */
export function initialStep(r: State): StudioStep {
  if (r.sent) return "done";
  const steps = stepsFor(r);
  if (r.built && r.isBuilder && r.mineDone) return r.messageApproved ? "send" : "message";
  if (r.kind === "monthly" && r.mineDone && steps.includes("send")) return "send";
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

/**
 * How it can go out: Slack and email always; saved to the client's Drive only for a month's report (the monthly recap,
 * or a built report covering a whole calendar month), never a weekly.
 */
export function sendOptions(r: { kind: string; start: string; end: string }): SendOption[] {
  const drive = r.kind === "monthly" || (r.kind === "built" && isWholeMonth(r.start, r.end));
  return drive ? ["slack", "email", "drive"] : ["slack", "email"];
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
