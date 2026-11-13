import { describe, expect, it } from "vitest";
import { channelsFor, defaultSendOption, furthestStep, initialStep, previewFormat, isWholeMonth, lastUsed, resolveStep, sendOptions, stepsFor, type PastSend, previewFormatsFor } from "@/lib/reports/studio-steps";

const base = { kind: "weekly", rider: false, built: false, isBuilder: false, sent: false, mineDone: false, messageApproved: false };

describe("the studio's steps", () => {
  it("a weekly or built report has Report, Message, Send, Sent", () => {
    expect(stepsFor(base)).toEqual(["report", "message", "send", "done"]);
    expect(stepsFor({ ...base, kind: "built", built: true, isBuilder: true })).toEqual(["report", "message", "send", "done"]);
  });

  it("a monthly recap is the report (its write-up under it, saved to Drive there) and then Saved: no Message or Send", () => {
    const m = { ...base, kind: "monthly" };
    expect(stepsFor(m)).toEqual(["report", "done"]);
    expect(resolveStep("message", m)).toBe("report");
    expect(resolveStep("send", m)).toBe("report");
    expect(furthestStep(m)).toBe("report");
    expect(resolveStep("report", { ...m, sent: true })).toBe("done");
  });

  it("a TikTok part riding on the Meta report, and another buyer's part of a built one, only review", () => {
    expect(stepsFor({ ...base, rider: true })).toEqual(["report", "done"]);
    expect(stepsFor({ ...base, kind: "built", built: true, isBuilder: false })).toEqual(["report", "done"]);
  });

  it("follows the address, back and forward", () => {
    expect(resolveStep(null, base)).toBe("report");
    expect(resolveStep("message", base)).toBe("message");
    expect(resolveStep("send", base)).toBe("send");
    expect(resolveStep("report", base)).toBe("report");
  });

  it("ignores a step the report doesn't have, or Sent before it's sent", () => {
    expect(resolveStep("nonsense", base)).toBe("report");
    expect(resolveStep("done", base)).toBe("report");
    expect(resolveStep("message", { ...base, rider: true })).toBe("report");
  });

  it("always shows Sent once it's sent", () => {
    expect(resolveStep("report", { ...base, sent: true })).toBe("done");
    expect(initialStep({ ...base, sent: true })).toBe("done");
    expect(furthestStep({ ...base, sent: true })).toBe("done");
  });

  it("a built report's message waits for the builder's own part", () => {
    const b = { ...base, kind: "built", built: true, isBuilder: true };
    expect(resolveStep("message", b)).toBe("report");
    expect(resolveStep("send", b)).toBe("report");
    expect(initialStep({ ...b, mineDone: true })).toBe("message");
    expect(initialStep({ ...b, mineDone: true, messageApproved: true })).toBe("send");
    expect(resolveStep("send", { ...b, mineDone: true })).toBe("send");
  });

  it("an approved monthly part stays on its report, the one place it's saved from", () => {
    const m = { ...base, kind: "monthly", mineDone: true };
    expect(initialStep(m)).toBe("report");
    expect(resolveStep(null, m)).toBe("report");
    expect(resolveStep("send", m)).toBe("report");
  });
});

describe("how it can go out", () => {
  it("never offers Drive for a weekly", () => {
    expect(sendOptions({ kind: "weekly", start: "2026-11-02", end: "2026-11-08" })).toEqual(["slack", "email"]);
    expect(sendOptions({ kind: "custom", start: "2026-10-01", end: "2026-10-31" })).toEqual(["slack", "email"]);
  });

  it("a monthly recap is only saved to Drive (customer success sends the month), previewed as its PDF", () => {
    expect(sendOptions({ kind: "monthly", start: "2026-10-01", end: "2026-10-31" })).toEqual(["drive"]);
    expect(previewFormatsFor({ kind: "monthly", start: "2026-10-01", end: "2026-10-31" })).toEqual(["pdf"]);
    expect(defaultSendOption(["drive"], ["slack"], true)).toBe("drive");
    expect(previewFormat("slack", ["slack"], ["pdf"])).toBe("pdf");
  });
  it("a weekly is Slack or email, previewed as Slack or email, never Drive or the PDF", () => {
    expect(sendOptions({ kind: "weekly", start: "2026-11-02", end: "2026-11-08" })).toEqual(["slack", "email"]);
    expect(previewFormatsFor({ kind: "weekly", start: "2026-11-02", end: "2026-11-08" })).toEqual(["slack", "email"]);
    expect(previewFormat("pdf", ["email"], ["slack", "email"])).toBe("email");
  });

  it("offers Drive for a built report only when it covers a whole calendar month", () => {
    expect(sendOptions({ kind: "built", start: "2026-10-01", end: "2026-10-31" })).toContain("drive");
    expect(sendOptions({ kind: "built", start: "2026-10-01", end: "2026-10-30" })).not.toContain("drive");
    expect(sendOptions({ kind: "built", start: "2026-10-05", end: "2026-11-04" })).not.toContain("drive");
  });

  it("knows a whole month, February and leap years too", () => {
    expect(isWholeMonth("2026-02-01", "2026-02-28")).toBe(true);
    expect(isWholeMonth("2028-02-01", "2028-02-28")).toBe(false);
    expect(isWholeMonth("2028-02-01", "2028-02-29")).toBe(true);
    expect(isWholeMonth("2026-09-01", "2026-09-30")).toBe(true);
    expect(isWholeMonth("2026-09-01", "2026-10-31")).toBe(false);
    expect(isWholeMonth("bad", "2026-10-31")).toBe(false);
  });
});

describe("Last used", () => {
  const now = { reportId: "r-now", bundleId: null, platform: "meta", me: "me" };
  const send = (x: Partial<PastSend>): PastSend => ({ reportId: "r-old", bundleId: null, platform: "meta", sentBy: "me", channels: ["slack"], status: "sent", ...x });

  it("is how this buyer sent their previous report for this client and platform", () => {
    expect(lastUsed([send({ channels: ["slack", "email"] })], now)).toEqual(["slack", "email"]);
    expect(lastUsed([send({ channels: ["email"] }), send({ channels: ["slack"] })], now)).toEqual(["email"]);
  });

  it("skips other buyers, other platforms, this report and failed sends", () => {
    const sends = [send({ sentBy: "someone" , channels: ["email"] }), send({ platform: "google", channels: ["email"] }), send({ reportId: "r-now", channels: ["email"] }), send({ status: "failed", channels: ["email"] }), send({ channels: ["slack"] })];
    expect(lastUsed(sends, now)).toEqual(["slack"]);
  });

  it("counts a send for several services (a recap, Meta + TikTok) for each", () => {
    expect(lastUsed([send({ platform: null, reportId: null, bundleId: "b-old", channels: ["email"] })], now)).toEqual(["email"]);
    expect(lastUsed([send({ platform: null, reportId: null, bundleId: "b-now", channels: ["email"] })], { ...now, bundleId: "b-now" })).toEqual([]);
  });

  it("starts on the one way this buyer last used, else Slack", () => {
    const monthly = ["slack", "email", "drive"] as const;
    expect(defaultSendOption(["slack", "email"], ["email"])).toBe("email");
    expect(defaultSendOption(["slack", "email"], [])).toBe("slack");
    expect(defaultSendOption(monthly, ["drive"])).toBe("drive");
    expect(defaultSendOption(["slack", "email"], ["drive"])).toBe("slack");
    expect(defaultSendOption(["slack", "email"], ["slack", "email"])).toBe("slack");
    expect(defaultSendOption(["slack", "email"], [], false)).toBe("email");
  });

  it("goes by one channel, and Drive by none", () => {
    expect(channelsFor("slack")).toEqual(["slack"]);
    expect(channelsFor("email")).toEqual(["email"]);
    expect(channelsFor("drive")).toEqual([]);
  });

  it("opens the message preview on the format last used, the address winning", () => {
    expect(previewFormat(null, [])).toBe("slack");
    expect(previewFormat(null, ["email"])).toBe("email");
    expect(previewFormat(null, ["drive"])).toBe("slack");
    expect(previewFormat("pdf", ["email"])).toBe("pdf");
    expect(previewFormat("nonsense", ["email"])).toBe("email");
  });

  it("adds Drive when the previous month's report was saved there", () => {
    expect(lastUsed([], now, true)).toEqual(["drive"]);
    expect(lastUsed([send({ channels: ["slack"] })], now, true)).toEqual(["slack", "drive"]);
    expect(lastUsed([], now)).toEqual([]);
  });
});
