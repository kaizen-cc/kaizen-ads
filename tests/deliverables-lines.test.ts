import { describe, expect, it } from "vitest";
import { applyPatch, approved, newRun, nextStep, readAsk, tasksFor, type LineConfig, type RunState, type TaskInput } from "@/lib/deliverables/engine";
import { LINES, lineForAsk, lineOf } from "@/lib/deliverables/lines";
import { CREATIVE_LINE, creativeBriefText, creativeDraft, creativeRefs, creativeTaskName, MAX_VERSIONS } from "@/lib/deliverables/lines/creative";
import { SOCIAL_LINE, SOCIAL_PROJECT_GID, postDateLabel, slidesOfPost, socialDescription, socialTaskName } from "@/lib/deliverables/lines/social";
import { mapAsanaFields, normalizeCopy, copyDocHtml, type AsanaFieldSetting } from "@/lib/copy-docs/core";
import { planAsanaRequest } from "@/lib/asana-request";
import { directSpecialist } from "@/lib/assistant/team";

const client = { id: "c1", name: "Tejas Brewery" };
const topic = (title: string, send = "") => ({ title, angle: "Fresh pours for the holidays", offer: "", include: [], exclude: [], send });

function run(cfg: LineConfig, ...patches: Parameters<typeof applyPatch>[2][]): RunState {
  let s = newRun(cfg.line, client);
  for (const p of patches) {
    const r = applyPatch(cfg, s, p);
    if (!r.ok) throw new Error(r.why);
    s = r.state;
  }
  return s;
}
const toReview = (kind: string, count: number) => [{ kind, count }, { contextPulled: true }, { topics: [topic("A", "2026-11-12")], agreed: true }, { doc: { id: "d1", version: 1 } }] as Parameters<typeof applyPatch>[2][];

describe("both lines are registered", () => {
  it("runs email, creative and social, each with its lead and the Copywriter", () => {
    expect(LINES.map((l) => l.line)).toEqual(["email", "creative", "social"]);
    expect(CREATIVE_LINE).toMatchObject({ lead: "creative_director", writer: "copywriter", followerSeat: "meta_buyer", collaborators: ["head_of_creative"], kaizenRequests: false });
    expect(SOCIAL_LINE).toMatchObject({ lead: "social_strategist", writer: "copywriter", followerSeat: "social_manager", kaizenRequests: false });
    expect(lineOf("social")).toBe(SOCIAL_LINE);
  });

  it("routes each ask to its own line and lead, and leaves email alone", () => {
    expect(lineForAsk("I need to create campaigns for Candy Cloud")?.line).toBe("email");
    expect(lineForAsk("I need a new creative request for Tejas Brewery, a carousel")?.line).toBe("creative");
    expect(lineForAsk("let's make 3 video ads for Ocean Box")?.line).toBe("creative");
    expect(lineForAsk("can you plan organic posts for Tejas Brewery")?.line).toBe("social");
    expect(lineForAsk("write a carousel post for Tejas Brewery")?.line).toBe("social");
    expect(lineForAsk("what's on my plate today")).toBeNull();
    expect(directSpecialist("I need to create organic posts for Tejas Brewery")).toEqual({ key: "social_strategist", why: "deliverable" });
    expect(directSpecialist("let's create a new ad creative for Ocean Box")).toEqual({ key: "creative_director", why: "deliverable" });
  });
});

describe("the creative line", () => {
  const cfg = CREATIVE_LINE;
  it("asks format, then versions and platform, then context, brainstorm, the writer and the draft", () => {
    expect(nextStep(cfg, newRun("creative", client)).step).toBe("ask_type");
    expect(nextStep(cfg, newRun("creative", client)).say).toMatch(/static or carousel or video/);
    const typed = run(cfg, { kind: "carousel" });
    expect(nextStep(cfg, typed)).toMatchObject({ step: "ask_count", who: "lead" });
    expect(nextStep(cfg, typed).say).toMatch(/platform/);
    expect(readAsk(cfg, "I need a video ad for Ocean Box")).toEqual({ kind: "video", count: null });
    expect(readAsk(cfg, "a carousel with 3 versions")).toEqual({ kind: "carousel", count: 3 });
    const counted = run(cfg, { kind: "image", count: 2 });
    expect(nextStep(cfg, counted).step).toBe("pull_context");
    expect(nextStep(cfg, counted).say).toMatch(/winners_and_fatigue/);
    const agreed = run(cfg, { kind: "image", count: 2 }, { contextPulled: true }, { topics: [topic("A")], agreed: true });
    expect(nextStep(cfg, agreed).step).toBe("bring_writer");
    const joined = run(cfg, { kind: "image", count: 2 }, { contextPulled: true }, { topics: [topic("A")], agreed: true }, { writerJoined: true });
    expect(nextStep(cfg, joined).say).toMatch(/4:5 and 9:16 only/);
  });

  it("holds one concept's versions: up to 1 new plus 5 variations", () => {
    expect(MAX_VERSIONS).toBe(6);
    expect(applyPatch(cfg, run(cfg, { kind: "video" }), { count: 6 }).ok).toBe(true);
    expect(applyPatch(cfg, run(cfg, { kind: "video" }), { count: 7 }).ok).toBe(false);
  });

  it("goes to Asana through the form's own path and says Kaizen OS requests are coming soon", () => {
    expect(cfg.asana.via).toBe("creative_form");
    expect(cfg.asana.section).toBe("Creative Brief");
    const s = run(cfg, ...toReview("image", 1), { approve: "lead" }, { approve: "person" });
    expect(approved(s)).toBe(true);
    expect(nextStep(cfg, s).say).toMatch(/coming soon/);
    expect(applyPatch(cfg, run(cfg, ...toReview("image", 1)), { asked: true }).ok).toBe(false);
  });

  const concept = normalizeCopy({
    kind: "creative",
    title: "Cold pour reveal",
    short_name: "Cold pour",
    emails: [
      {
        name: "Concept",
        subject: "ignored",
        sections: [
          { heading: "Hook", body: "Nobody tells you the best pour is the cold one" },
          { heading: "Concept", body: "A slow pour in the taproom, one voice, no music" },
          { heading: "Slide 1", body: "Cold pour\nWatch it settle" },
          { heading: "Slide 2", body: "Taproom only\nCome see it" },
          { heading: "Copy", body: "Primary: Pour one with us" },
          { heading: "Platform", body: "Meta" },
        ],
        cta: { label: "Visit the taproom", url: "" },
        design_notes: ["Reference: https://example.com/ref1 and https://example.com/ref2"],
      },
    ],
    brief: { goal: "Fill the taproom on weekends", audience: "Locals 25 to 45 who like craft beer", rules: ["Real photos only"] },
  });

  it("writes the concept in the brief's structure: no subject, sizes 4:5 and 9:16 only", () => {
    expect(concept.kind).toBe("creative");
    expect(concept.emails[0].subject).toBe("");
    const text = creativeBriefText(concept, { kind: "carousel" });
    expect(text).toContain("Hook: Nobody tells you");
    expect(text).toContain("Frames:");
    expect(text).toContain("- Slide 1: Cold pour / Watch it settle");
    expect(text).toContain("Call to action: Visit the taproom");
    expect(text).toContain("Platform: Meta");
    expect(text).toContain("Sizes: 4:5 and 9:16 only");
    expect(text).not.toMatch(/1:1|1x1/);
    expect(creativeRefs(concept)).toBe("https://example.com/ref1 https://example.com/ref2");
    expect(copyDocHtml(concept, { client: "Tejas Brewery" })).toContain("Ad Creative Brief");
  });

  it("maps the concept to the request form's draft: one format, versions counted, carousel cards", () => {
    const d = creativeDraft({ clientId: "c1", kind: "carousel", count: 3, content: concept, angle: "Cold pour", urgency: "high" });
    expect(d).toMatchObject({ clientId: "c1", title: "Cold pour", sizes: ["4x5", "9x16"], angle: "Cold pour", audience: "Locals 25 to 45 who like craft beer", priority: "high" });
    expect(d.formats).toEqual({ carousel: { new: 1, variations: 2, cards: 2 } });
    expect(Object.keys(creativeDraft({ clientId: "c1", kind: "video", count: 1, content: concept, angle: "", urgency: "normal" }).formats)).toEqual(["video"]);
    expect(creativeDraft({ clientId: "c1", kind: "image", count: 99, content: concept, angle: "", urgency: "normal" }).formats.image).toEqual({ new: 1, variations: 5 });
  });

  it("names the task and fills the fields exactly like the form's planned task", async () => {
    // A stub database that answers what planAsanaRequest reads
    const rows: Record<string, unknown> = {
      clients: { name: "Tejas Brewery", kaizen_id: 412, website: "https://tejas.example", drive_folder_id: "abc", creative_db: { url: "https://db.example" } },
      client_assignments: [
        { role: "meta_buyer", profile_id: "b", is_primary: true, created_at: "2026-01-01", profiles: { full_name: "Buyer One", email: "b@kaizen.test" } },
        { role: "graphic_designer", profile_id: "g", is_primary: true, created_at: "2026-01-01", profiles: { full_name: "Designer One", email: "g@kaizen.test" } },
      ],
      app_settings: null,
    };
    const q = (t: string) => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in"]) chain[m] = () => chain;
      chain.single = async () => ({ data: rows[t] });
      chain.maybeSingle = async () => ({ data: rows[t] });
      chain.then = (res: (v: unknown) => unknown) => res({ data: rows[t] });
      return chain;
    };
    const admin = { from: q } as unknown as Parameters<typeof planAsanaRequest>[0];
    const draft = creativeDraft({ clientId: "c1", kind: "carousel", count: 3, content: concept, angle: "Cold pour", urgency: "urgent" });
    const [task] = await planAsanaRequest(admin, draft);
    const input: TaskInput = { client: { name: "Tejas Brewery", kaizenId: 412, website: null, hqUrl: null, figma: null, platform: null }, kind: cfg.kinds[1], shortName: concept.shortName, count: 3, docUrl: null, purpose: "", urgency: "urgent" };
    expect(task.name).toBe(creativeTaskName(input));
    expect(task.name).toBe("URGENT: Meta Ads - Need a new creative - Tejas Brewery - Carousel (x3) - Cold pour");
    expect(task.section).toBe("Creative Brief");
    expect(task.fields).toEqual(cfg.asana.fields(input));
    expect(task.notes).toContain("Media Buyer Assigned to Account: Buyer");
    expect(task.notes).toContain("1 concept, carousel, 3 versions of 2 slides");
    expect(task.assignee?.email).toBe("g@kaizen.test");
  });
});

describe("the social line", () => {
  const cfg = SOCIAL_LINE;
  const base: Omit<TaskInput, "kind" | "shortName" | "count" | "docUrl" | "purpose"> = { client: { name: "Tejas Brewery", kaizenId: 412, website: "https://tejas.example", hqUrl: null, figma: null, platform: null }, urgency: "high" };

  it("asks format and count with posting dates, then follows the same steps as email", () => {
    expect(nextStep(cfg, newRun("social", client)).say).toMatch(/single image or carousel or video/);
    expect(nextStep(cfg, run(cfg, { kind: "carousel" })).say).toMatch(/posting date/);
    expect(readAsk(cfg, "I need 3 carousel posts for Tejas")).toEqual({ kind: "carousel", count: 3 });
    expect(applyPatch(cfg, run(cfg, { kind: "image" }), { count: 8 }).ok).toBe(false);
    const agreed = run(cfg, { kind: "carousel", count: 2 }, { contextPulled: true }, { topics: [topic("A", "2026-11-12")], agreed: true });
    expect(nextStep(cfg, agreed)).toMatchObject({ step: "bring_writer", who: "lead" });
    expect(nextStep(cfg, run(cfg, ...toReview("carousel", 1))).step).toBe("review");
    const asked = run(cfg, ...toReview("carousel", 1), { approve: "lead" }, { approve: "person" }, { asked: true });
    expect(nextStep(cfg, asked).step).toBe("create_requests");
    expect(nextStep(cfg, run(cfg, ...toReview("carousel", 1), { approve: "lead" }, { approve: "person" })).say).toMatch(/coming soon/);
  });

  it("formats dates and titles the way the team does", () => {
    expect(postDateLabel("2026-11-12")).toBe("Nov 12 2026");
    expect(postDateLabel("2026-12-05")).toBe("Dec 05 2026");
    expect(postDateLabel(null)).toBe("TBD");
    expect(socialTaskName({ client: base.client, kind: cfg.kinds[1], postDate: "2026-11-12" })).toBe("Organic Social: Tejas Brewery- Carousel Request - Nov 12 2026");
    expect(socialTaskName({ client: base.client, kind: cfg.kinds[0], postDate: "2026-11-14" })).toBe("Organic Social: Tejas Brewery- Single Image Request - Nov 14 2026");
    expect(socialTaskName({ client: base.client, kind: cfg.kinds[2], postDate: "2026-11-15" })).toBe("Organic Social: Tejas Brewery- Video Request - Nov 15 2026");
  });

  const post = normalizeCopy({
    kind: "social",
    title: "Holiday pours",
    emails: [
      {
        name: "Post 1",
        subject: "ignored",
        sections: [
          { heading: "Slide 1: Hook", body: "Cold pours, warm nights\nOur winter lineup is here" },
          { heading: "Slide 2: Lineup", body: "Three new pours\nStout, porter, spiced ale" },
          { heading: "CTA", body: "Come taste them\nTaproom open Thursday to Sunday" },
        ],
        design_notes: ["Visual: a pint on the bar with snow behind", "Visual: three glasses side by side", "Visual: the taproom door"],
      },
    ],
    brief: { goal: "Winter lineup launch", send_date: "2026-11-12" },
  });

  it("reads a post's slides from its sections and visuals", () => {
    expect(post.kind).toBe("social");
    expect(post.emails[0].subject).toBe("");
    const slides = slidesOfPost(post.emails[0]);
    expect(slides).toHaveLength(3);
    expect(slides[0]).toEqual({ name: "Hook", headline: "Cold pours, warm nights", line: "Our winter lineup is here", visual: "a pint on the bar with snow behind" });
    expect(slides[2].visual).toBe("the taproom door");
  });

  it("builds the description in the spec's order with per-slide sections and the client's quick links", () => {
    const links = [
      { label: "Social Media Calendar", url: "https://sheet.example/cal" },
      { label: "Ad Creative Folder", url: "" },
      { label: "Client Headquarters Link", url: "https://drive.example/hq" },
      { label: "Website", url: "https://tejas.example" },
    ];
    const input: TaskInput = { ...base, kind: cfg.kinds[1], shortName: "Holiday pours", count: 1, docUrl: null, purpose: "", concept: "Winter lineup launch", postDate: "2026-11-12", slides: slidesOfPost(post.emails[0]), links };
    const d = socialDescription(input);
    const wanted = ["Format Requested: Carousel", "Date this will be posted: Nov 12 2026", "Creative Brief: TEJAS BREWERY: Holiday pours", "Format: Instagram Carousel (3 slides)", "Concept: Winter lineup launch", "Suggested posting date: Nov 12 2026", "SLIDE 1: HOOK", "Visual: a pint on the bar", "____", "SLIDE 2: LINEUP", "SLIDE 3: CTA", "Quick Links of the client:"];
    const at = wanted.map((x) => d.indexOf(x));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(d).toContain("Social Media Calendar: https://sheet.example/cal");
    expect(d).not.toContain("Ad Creative Folder");
    expect(d).not.toMatch(/[–—]/);
  });

  it("makes one task per post with no assignee or due date, in the Organic Social Creative project's Creative Brief column", () => {
    expect(cfg.asana.project.gid).toBe(SOCIAL_PROJECT_GID);
    expect(SOCIAL_PROJECT_GID).toBe("1213604282001906");
    expect(cfg.asana.section).toBe("Creative Brief");
    const s = run(cfg, { kind: "carousel", count: 2 }, { contextPulled: true }, { topics: [topic("One", "2026-11-12"), topic("Two", "2026-11-14")], agreed: true });
    const tasks = tasksFor(cfg, s, [{ shortName: "One", docUrl: null, purpose: "", extra: { postDate: "2026-11-12", concept: "A" } }, { shortName: "Two", docUrl: null, purpose: "", extra: { postDate: "2026-11-14", concept: "B" } }], base, "Doc", null, "");
    expect(tasks.map((t) => t.name)).toEqual(["Organic Social: Tejas Brewery- Carousel Request - Nov 12 2026", "Organic Social: Tejas Brewery- Carousel Request - Nov 14 2026"]);
    expect(tasks[0].fields.some((f) => /assignee|due/i.test(f.name))).toBe(false);
  });

  it("fills Client ID and Priority by name and option", () => {
    const settings: AsanaFieldSetting[] = [
      { gid: "f1", name: "Client ID", type: "text", options: [] },
      { gid: "f2", name: "Priority", type: "enum", options: [{ gid: "r1", name: "Low" }, { gid: "r2", name: "Medium" }, { gid: "r3", name: "High" }] },
    ];
    const t: TaskInput = { ...base, kind: cfg.kinds[1], shortName: "X", count: 1, docUrl: null, purpose: "" };
    const m = mapAsanaFields(settings, cfg.asana.fields(t));
    expect(m.custom_fields).toEqual({ f1: "412", f2: "r3" });
    expect(m.missing).toEqual([]);
    expect(mapAsanaFields(settings, cfg.asana.fields({ ...t, urgency: "normal" })).custom_fields.f2).toBe("r2");
  });
});
