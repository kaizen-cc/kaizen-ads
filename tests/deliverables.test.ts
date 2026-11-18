import { describe, expect, it } from "vitest";
import { applyPatch, approved, canBringWriter, canRequest, followerOf, newRun, nextStep, readAsk, tasksFor, type RunState } from "@/lib/deliverables/engine";
import { EMAIL_LINE } from "@/lib/deliverables/lines/email";
import { lineForAsk } from "@/lib/deliverables/lines";
import { asanaTaskName, changedLines, copyDocHtml, emailFolderStep, emailWritingKind, folderStep, looseName, mapAsanaFields, normalizeCopy, pickOption, pickSection, urgencyFor, type AsanaFieldSetting } from "@/lib/copy-docs/core";
import { findOrCreateFolder } from "@/lib/creative-drive-paths";
import { directSpecialist } from "@/lib/assistant/team";
import { sheetDetailsOf } from "@/lib/account-sheet-channels-core";

const cfg = EMAIL_LINE;
const client = { id: "c1", name: "Candy Cloud" };
const topic = (title: string) => ({ title, angle: "Scratch to reveal a prize", offer: "Up to 30% off", include: ["Engaged 90 days"], exclude: ["Purchased in 7 days"], send: "Monday 9am" });

/** Applies patches in order, failing the test on a refusal */
function run(...patches: Parameters<typeof applyPatch>[2][]): RunState {
  let s = newRun("email", client);
  for (const p of patches) {
    const r = applyPatch(cfg, s, p);
    if (!r.ok) throw new Error(r.why);
    s = r.state;
  }
  return s;
}

describe("the deliverable flow's steps", () => {
  it("asks the type and how many only when they're missing", () => {
    expect(nextStep(cfg, newRun("email", client)).step).toBe("ask_type");
    expect(nextStep(cfg, run({ kind: "campaign" })).step).toBe("ask_count");
    expect(nextStep(cfg, run({ kind: "campaign", count: 3 })).step).toBe("pull_context");
    // Said up front: neither is asked
    const said = readAsk(cfg, "I need to create 3 campaigns for Candy Cloud");
    expect(said).toEqual({ kind: "campaign", count: 3 });
    expect(nextStep(cfg, run({ kind: said.kind, count: said.count })).step).toBe("pull_context");
    expect(readAsk(cfg, "a 4 email welcome flow for them")).toEqual({ kind: "flow", count: 4 });
    expect(readAsk(cfg, "I need to create campaigns for Candy Cloud")).toEqual({ kind: "campaign", count: null });
  });

  it("keeps the Email Board's limits: a batch up to 5 campaigns, a flow up to 6 emails", () => {
    expect(applyPatch(cfg, run({ kind: "campaign" }), { count: 6 }).ok).toBe(false);
    expect(applyPatch(cfg, run({ kind: "flow" }), { count: 6 }).ok).toBe(true);
    expect(applyPatch(cfg, run({ kind: "flow" }), { count: 7 }).ok).toBe(false);
    expect(applyPatch(cfg, run(), { kind: "podcast" }).ok).toBe(false);
  });

  it("pulls context, then brainstorms until the topics are agreed", () => {
    const s = run({ kind: "campaign", count: 2 }, { contextPulled: true });
    expect(nextStep(cfg, s)).toMatchObject({ step: "brainstorm", who: "lead" });
    expect(nextStep(cfg, s).say).toMatch(/holidays/);
    const proposed = run({ kind: "campaign", count: 2 }, { contextPulled: true }, { topics: [topic("Scratch to Win"), topic("Last chance")] });
    expect(nextStep(cfg, proposed).step).toBe("brainstorm");
    expect(applyPatch(cfg, run(), { agreed: true }).ok).toBe(false);
  });

  it("brings the writer in only after the topics are agreed", () => {
    const proposed = run({ kind: "campaign", count: 1 }, { contextPulled: true }, { topics: [topic("Scratch to Win")] });
    expect(canBringWriter(proposed)).toBe(false);
    expect(applyPatch(cfg, proposed, { writerJoined: true }).ok).toBe(false);
    expect(applyPatch(cfg, proposed, { doc: { id: "d1", version: 1 } }).ok).toBe(false);
    const agreed = run({ kind: "campaign", count: 1 }, { contextPulled: true }, { topics: [topic("Scratch to Win")], agreed: true });
    expect(nextStep(cfg, agreed)).toMatchObject({ step: "bring_writer", who: "lead" });
    const joined = run({ kind: "campaign", count: 1 }, { contextPulled: true }, { topics: [topic("Scratch to Win")], agreed: true }, { writerJoined: true });
    expect(nextStep(cfg, joined)).toMatchObject({ step: "draft", who: "writer" });
    // New topics need agreeing again
    const changed = applyPatch(cfg, agreed, { topics: [topic("Other")] });
    expect(changed.ok && changed.state.topicsAgreed).toBe(false);
  });

  it("reviews until the person and the lead approve the same version", () => {
    const drafted = run({ kind: "campaign", count: 1 }, { contextPulled: true }, { topics: [topic("Scratch to Win")], agreed: true }, { doc: { id: "d1", version: 1 } });
    expect(nextStep(cfg, drafted)).toMatchObject({ step: "review", who: "lead" });
    const leadOk = applyPatch(cfg, drafted, { approve: "lead" });
    expect(leadOk.ok && approved(leadOk.state)).toBe(false);
    // A new version after the lead's approval needs both again
    const revised = run({ kind: "campaign", count: 1 }, { contextPulled: true }, { topics: [topic("Scratch to Win")], agreed: true }, { doc: { id: "d1", version: 1 } }, { approve: "lead" }, { approve: "person" }, { doc: { id: "d1", version: 2 } });
    expect(approved(revised)).toBe(false);
    const both = run({ kind: "campaign", count: 1 }, { contextPulled: true }, { topics: [topic("Scratch to Win")], agreed: true }, { doc: { id: "d1", version: 2 } }, { approve: "lead" }, { approve: "person" });
    expect(approved(both)).toBe(true);
    expect(nextStep(cfg, both)).toMatchObject({ step: "ask_requests", who: "lead" });
  });

  it("creates the requests only after approval and the ask, then the assistant wraps up", () => {
    const drafted = run({ kind: "campaign", count: 1 }, { contextPulled: true }, { topics: [topic("Scratch to Win")], agreed: true }, { doc: { id: "d1", version: 1 } });
    expect(applyPatch(cfg, drafted, { asked: true }).ok).toBe(false);
    expect(applyPatch(cfg, drafted, { requests: [{ name: "x", url: "u", gid: "1", follower: null, followerMissing: null }] }).ok).toBe(false);
    expect(canRequest(drafted)).toBe(false);
    const asked = run({ kind: "campaign", count: 1 }, { contextPulled: true }, { topics: [topic("Scratch to Win")], agreed: true }, { doc: { id: "d1", version: 1 } }, { approve: "lead" }, { approve: "person" }, { asked: true });
    expect(canRequest(asked)).toBe(true);
    expect(nextStep(cfg, asked).step).toBe("create_requests");
    const made = run({ kind: "campaign", count: 1 }, { contextPulled: true }, { topics: [topic("Scratch to Win")], agreed: true }, { doc: { id: "d1", version: 1 } }, { approve: "lead" }, { approve: "person" }, { asked: true }, { requests: [{ name: "x", url: "u", gid: "1", follower: "9", followerMissing: null }] });
    expect(nextStep(cfg, made)).toMatchObject({ step: "wrap_up", who: "host" });
    expect(nextStep(cfg, { ...made, wrapped: true }).step).toBe("done");
  });

  it("says Kaizen OS requests are coming soon for email", () => {
    expect(cfg.kaizenRequests).toBe(false);
    const s = run({ kind: "campaign", count: 1 }, { contextPulled: true }, { topics: [topic("A")], agreed: true }, { doc: { id: "d", version: 1 } }, { approve: "lead" }, { approve: "person" });
    expect(nextStep(cfg, s).say).toMatch(/coming soon/);
  });
});

describe("routing an ask", () => {
  it("brings in the Email Strategist for campaigns and campaign copy", () => {
    expect(directSpecialist("I need to create campaigns for Candy Cloud")).toEqual({ key: "email_strategist", why: "deliverable" });
    expect(directSpecialist("write copy for a campaign email for Candy Cloud announcing their scratch-to-win campaign, going out Monday morning, to send to the designer")?.key).toBe("email_strategist");
    expect(lineForAsk("can you build a welcome flow for Ocean Box")?.line).toBe("email");
    expect(directSpecialist("reply to the partner's email about the campaign")).toBeNull();
  });

  it("tells campaign copy from a message to someone", () => {
    expect(emailWritingKind("write copy for a campaign email for Candy Cloud, to send to the designer")).toBe("campaign");
    expect(emailWritingKind("draft a 3 email welcome flow")).toBe("flow");
    expect(emailWritingKind("an SMS for the weekend sale")).toBe("sms");
    expect(emailWritingKind("reply to Dana about the campaign results")).toBe("message");
    expect(emailWritingKind("draft an email to Jordan about the invoice")).toBe("message");
    expect(emailWritingKind("what's on my plate today")).toBeNull();
  });
});

describe("the Asana request", () => {
  const settings: AsanaFieldSetting[] = [
    { gid: "f1", name: "CLIENT ID", type: "text", options: [] },
    { gid: "f2", name: "Request Type", type: "enum", options: [{ gid: "o1", name: "Email Campaign" }, { gid: "o2", name: "Email Flow" }, { gid: "o3", name: "SMS" }] },
    { gid: "f3", name: "Platform", type: "enum", options: [{ gid: "p1", name: "Klaviyo" }, { gid: "p2", name: "Brevo" }, { gid: "p3", name: "Customer.io" }] },
    { gid: "f4", name: "Priority", type: "enum", options: [{ gid: "r1", name: "Low" }, { gid: "r2", name: "Medium" }, { gid: "r3", name: "High" }, { gid: "r4", name: "Urgent", enabled: false }] },
    { gid: "f5", name: "Client HQ - ASSETS", type: "text", options: [] },
    { gid: "f6", name: "Purpose", type: "text", options: [] },
    { gid: "f7", name: "Figma Board", type: "text", options: [] },
    { gid: "f8", name: "Copy", type: "text", options: [] },
    { gid: "f9", name: "Revision Stage", type: "enum", options: [{ gid: "v1", name: "R1" }] },
    { gid: "f10", name: "Client Website", type: "text", options: [] },
  ];
  const base = { client: { name: "Candy Cloud", kaizenId: 412, website: "https://candycloud.com", hqUrl: "https://drive.google.com/drive/folders/abc1234567", figma: null, platform: "Customer.io" }, urgency: "urgent" as const };

  it("fills the fields by name and enum option, with no assignee, due date or revision stage", () => {
    const s = run({ kind: "campaign", count: 2 }, { contextPulled: true }, { topics: [topic("Scratch to Win"), topic("Last Call")], agreed: true });
    const tasks = tasksFor(cfg, s, [{ shortName: "Scratch to Win", docUrl: "https://docs.google.com/document/d/1", purpose: "Launch the game" }, { shortName: "Last Call", docUrl: null, purpose: "Close it out" }], base, "Scratch to Win", "https://docs.google.com/document/d/1", "x");
    expect(tasks.map((t) => t.name)).toEqual(["KZN x Candy Cloud | Email Campaign - Scratch to Win", "KZN x Candy Cloud | Email Campaign - Last Call"]);
    const { custom_fields, missing, set } = mapAsanaFields(settings, tasks[0].fields);
    expect(custom_fields).toMatchObject({ f1: "412", f2: "o1", f3: "p3", f5: base.client.hqUrl, f6: "Launch the game", f8: "https://docs.google.com/document/d/1", f10: "https://candycloud.com" });
    // Urgent is switched off in the project: the next best, High
    expect(custom_fields.f4).toBe("r3");
    expect(custom_fields.f9).toBeUndefined();
    expect(custom_fields.f7).toBeUndefined();
    expect(missing).toEqual([]);
    expect(set).not.toContain("Revision Stage");
    expect(tasks[0].fields.some((f) => /assignee|due/i.test(f.name))).toBe(false);
    expect(cfg.asana.section).toBe("Email Requests");
  });

  it("makes one task for a flow, with its email count, and lists fields the project lacks", () => {
    const s = run({ kind: "flow", count: 3 }, { contextPulled: true }, { topics: [topic("Welcome")], agreed: true });
    const tasks = tasksFor(cfg, s, [1, 2, 3].map((i) => ({ shortName: `Email ${i}`, docUrl: null, purpose: "" })), base, "Welcome Series", "https://docs.google.com/document/d/2", "Welcome new subscribers");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].name).toBe("KZN x Candy Cloud | Email Flow - Welcome Series (3)");
    const { custom_fields, missing } = mapAsanaFields(settings.slice(0, 2), tasks[0].fields);
    expect(custom_fields.f2).toBe("o2");
    expect(missing.map((m) => m.name)).toContain("Purpose");
  });

  it("names tasks the way the team does", () => {
    expect(asanaTaskName({ client: "Candy Cloud", kind: "campaign", shortName: "Scratch to Win", count: 1 })).toBe("KZN x Candy Cloud | Email Campaign - Scratch to Win");
    expect(asanaTaskName({ client: "Ocean Box", kind: "flow", shortName: "Welcome Series (2)", count: 3 })).toBe("KZN x Ocean Box | Email Flow - Welcome Series (3)");
  });

  it("matches options and columns loosely", () => {
    expect(pickOption([{ gid: "a", name: "Normal" }], "normal")?.gid).toBe("a");
    expect(pickOption([{ gid: "a", name: "Medium" }], "normal")?.gid).toBe("a");
    expect(pickOption([{ gid: "a", name: "Klaviyo" }], "Brevo")).toBeNull();
    expect(pickSection([{ gid: "1", name: "Needs Revision" }, { gid: "2", name: "EMAIL REQUESTS" }], "Email Requests")?.gid).toBe("2");
  });

  it("adds the client's strategist as a follower, and says so when they can't be matched", () => {
    expect(followerOf("email strategist", { name: "Strategist One", email: "s@kaizen.com" }, "12345")).toEqual({ follower: "12345", missing: null });
    expect(followerOf("email strategist", { name: "Strategist One", email: "s@kaizen.com" }, null).missing).toMatch(/couldn't be matched/);
    expect(followerOf("email strategist", null, null).missing).toMatch(/No email strategist/);
  });

  it("reads urgency from the words, then the send date", () => {
    expect(urgencyFor("this is urgent", null, "2026-11-18")).toBe("urgent");
    expect(urgencyFor("", "2026-11-19", "2026-11-18")).toBe("urgent");
    expect(urgencyFor("", "2026-11-23", "2026-11-18")).toBe("high");
    expect(urgencyFor("", "2026-12-10", "2026-11-18")).toBe("normal");
  });
});

describe("the Google Doc's folder", () => {
  const fake = (names: string[]) => {
    const made: string[] = [];
    let list = names.map((n, i) => ({ id: `f${i}`, name: n }));
    return {
      made,
      drive: {
        listFolders: async () => list,
        createFolder: async (_p: string, name: string) => {
          made.push(name);
          list = [...list, { id: `new${made.length}`, name }];
          return `new${made.length}`;
        },
      },
    };
  };

  it("finds Email Marketing whatever its case or numbering", async () => {
    for (const name of ["Email Marketing", "email marketing", "40 - Email Marketing", "EMAIL_MARKETING"]) {
      const f = fake(["Ad Creatives", name]);
      expect(await findOrCreateFolder(f.drive, "hq", emailFolderStep)).toEqual({ id: "f1", created: false });
      expect(f.made).toEqual([]);
    }
  });

  it("makes it when it's missing, and any line's folder the same way", async () => {
    const f = fake(["Ad Creatives", "Email Reports"]);
    expect(await findOrCreateFolder(f.drive, "hq", emailFolderStep)).toEqual({ id: "new1", created: true });
    expect(f.made).toEqual(["Email Marketing"]);
    expect(folderStep("Social Media").match("02 - social media")).toBe(true);
    expect(looseName("40 - Email Marketing")).toBe("emailmarketing");
  });
});

describe("the copy document", () => {
  const loose = {
    kind: "campaign",
    title: "Scratch to Win",
    short_name: "Scratch to Win",
    emails: [{ name: "Email 1", subject: "Scratch — and win", preview: "Your card is waiting", sections: [{ heading: "Scratch to reveal", body: "Up to 30% off" }], cta: { label: "Scratch now", url: "" }, design_notes: ["Real photos only"] }],
    brief: { goal: "Launch the game", send_at: "Monday 9am", send_date: "2026-11-23", rules: ["Real photos only"] },
  };

  it("keeps no em dashes and marks the lines a revision changed", () => {
    const a = normalizeCopy(loose);
    expect(a.emails[0].subject).not.toMatch(/—/);
    const b = normalizeCopy({ ...loose, emails: [{ ...loose.emails[0], subject: "Scratch, win, smile" }] });
    expect(changedLines(a, b)).toEqual(["e0.subject"]);
    expect(changedLines(null, b)).toEqual([]);
  });

  it("is never addressed to anyone in the Doc", () => {
    const html = copyDocHtml(normalizeCopy(loose), { client: "Candy Cloud" });
    expect(html).toContain("Subject:");
    expect(html).toContain("Scratch now");
    expect(html).not.toMatch(/\b(?:Hi|Dear)\b/);
  });
});

describe("the account sheet's details", () => {
  it("reads the client ID, HQ, Figma and website by column name", () => {
    const d = sheetDetailsOf({ "Client Name": "Candy Cloud", "Client ID": "412", "Client HQ - ASSETS": "https://drive.google.com/drive/folders/abc1234567", "Figma Board": "https://figma.com/file/x", Website: "candycloud.com", Strategist: "Someone" });
    expect(d).toEqual({ clientId: "412", hq: "https://drive.google.com/drive/folders/abc1234567", figma: "https://figma.com/file/x", website: "candycloud.com" });
    expect(sheetDetailsOf({ "Client Name": "X", Figma: "N/A" }).figma).toBeNull();
  });
});
