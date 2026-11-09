import { describe, expect, it } from "vitest";
import { YOUR_CALL_DEFAULT, cleanSpec, composeBrief, emptySpec, parseBrief, renderSpec, withSpec, type BriefSpec } from "@/lib/brief-spec";
import { answerFact, detectClientFacts, factCovered, openFacts, withDetectedFacts } from "@/lib/brief-facts";
import { applyTextFix, hardIssues, lintBrief } from "@/lib/brief-lint";
import { assetGate, businessDaysBetween, driveLinks } from "@/lib/brief-assets";
import { applyBriefPatch, briefOf, diffStates, stateOf, type BriefChange } from "@/lib/brief-patch";
import { blockedLine, canOverride, stampLine, summarizeGate } from "@/lib/brief-gate";

// The lead video editor's test brief (Best Tickets, "The Seat Most Fans Miss"): a reveal with no reveal, Drive links
// marked MISSING, "9:16 only" next to 4x5 file names, "show Best Tickets in the first 3s" next to "no logo / no
// domains", "use the Oct 21 event footage" next to "no event-specific content". Each of those is caught here.

const spec = (p: Partial<BriefSpec>): BriefSpec => ({ ...emptySpec(), ...p });
const change = (c: Partial<BriefChange> & Pick<BriefChange, "field" | "op">): BriefChange => ({ value: "", index: -1, status: "", answer: "", source: "", ...c });

describe("the brief's shape (what and why, the how left to the maker)", () => {
  const sp = spec({
    insight: "Section 112 sits behind the bench: you hear the coaches",
    insightSource: "Brand Bible",
    keyMessage: "The best seat isn't the priciest one",
    hook: "The seat most fans miss",
    proof: ["4.8 stars from 2,000 buyers"],
    slides: ["The myth", "The seat", "Where to buy"],
    constraints: ["4:5 and 9:16 only", "Keep text out of the top 270 px on 9:16"],
    dos: ["Show the view"],
    donts: ["No prices"],
    assets: [{ item: "Arena photos (Drive: Venues)", status: "have" }, { item: "Phone clip from Section 112", status: "shoot" }],
    kpi: "Cost per purchase",
    success: "Under $18 per purchase in the first week",
    yourCall: YOUR_CALL_DEFAULT,
    confirm: [{ question: "Which seat, at which venue, and why?", answer: "Section 112 at the Arena, behind the bench", source: "the team" }, { question: "Is the 4.8 rating current?", answer: "", source: "" }],
  });

  it("renders with fixed headings and reads back to the same spec", () => {
    const text = composeBrief("A carousel that reveals the seat most fans skip.", sp);
    expect(text).toMatch(/^A carousel/);
    expect(text).toContain("Insight: Section 112 sits behind the bench: you hear the coaches (Source: Brand Bible)");
    expect(text).toContain("Assets:\n- Have: Arena photos (Drive: Venues)\n- Client to shoot: Phone clip from Section 112");
    expect(text).toContain("Confirm with client:\n- Which seat, at which venue, and why? Answer: Section 112 at the Arena, behind the bench (Source: the team)\n- Is the 4.8 rating current?");
    const back = parseBrief(text);
    expect(back.structured).toBe(true);
    expect(back.overview).toBe("A carousel that reveals the seat most fans skip.");
    expect(back.spec).toEqual(sp);
  });

  it("folds a spec into a brief once, however often it's cleaned", () => {
    const once = withSpec("The idea in two lines.", sp);
    expect(withSpec(withSpec(once, sp), sp)).toBe(once);
  });

  it("keeps a heading it doesn't know with the overview", () => {
    const p = parseBrief("Idea line.\n\nHooks to try:\n- One\n- Two\n\nHook: The seat most fans miss\n\nYour call: Yours.");
    expect(p.overview).toContain("Hooks to try:\n- One");
    expect(p.spec.hook).toBe("The seat most fans miss");
  });

  it("cleans a writer's spec: no em dashes, Your call always said, statuses kept to the four", () => {
    const c = cleanSpec({ insight: "A \u2014 B", assets: [{ item: "x", status: "weird" as never }], yourCall: "" });
    expect(c.insight).toBe("A, B");
    expect(c.yourCall).toBe(YOUR_CALL_DEFAULT);
    expect(c.assets[0].status).toBe("need");
  });

  it("reads an old brief with no spec as unstructured", () => {
    expect(parseBrief("Show the patio at sunset. Bright, warm.").structured).toBe(false);
  });
});

describe("facts only the client knows", () => {
  it("asks which seat, at which venue, and why", () => {
    const f = detectClientFacts("The Seat Most Fans Miss");
    expect(f[0]).toMatchObject({ kind: "reveal", key: "seat", question: "Which seat, at which venue, and why?" });
  });

  it("finds tips, secrets, stats, offers and dates, and nothing in a plain line", () => {
    const kinds = (s: string) => detectClientFacts(s).map((x) => x.kind);
    expect(kinds("3 tips for better sleep")).toContain("list");
    expect(kinds("The secret to a crispy crust")).toContain("secret");
    expect(kinds("Trusted by 10,000 families")).toContain("stat");
    expect(kinds("20% off everything this weekend")).toEqual(expect.arrayContaining(["offer", "date"]));
    expect(kinds("The dish everyone overlooks")).toContain("reveal");
    expect(detectClientFacts("Fresh pasta made in house every morning")).toEqual([]);
  });

  it("is covered by an answer, or by an insight from the context with its source", () => {
    const [seat] = detectClientFacts("The seat most fans miss");
    expect(factCovered(seat, { confirm: [], insight: "", insightSource: "" })).toBe(false);
    expect(factCovered(seat, { confirm: [{ question: "Which seat, at which venue, and why?", answer: "Section 112", source: "the team" }], insight: "", insightSource: "" })).toBe(true);
    expect(factCovered(seat, { confirm: [], insight: "Section 112 sits right behind the home bench at the Arena", insightSource: "Brand Bible" })).toBe(true);
    // An insight with no source is the AI's guess, not a fact
    expect(factCovered(seat, { confirm: [], insight: "Section 112 sits right behind the home bench at the Arena", insightSource: "" })).toBe(false);
  });

  it("adds what isn't covered to Confirm with client, never an answer, and only once", () => {
    const sp = withDetectedFacts(spec({ hook: "The seat most fans miss" }), "Best Tickets: the seat most fans miss");
    expect(openFacts(sp)).toEqual([{ question: "Which seat, at which venue, and why?", answer: "", source: "" }]);
    expect(withDetectedFacts(sp, "Best Tickets: the seat most fans miss").confirm).toHaveLength(1);
    const answered = answerFact(sp, "Which seat, at which venue, and why?", "Section 112", "the team");
    expect(openFacts(answered)).toEqual([]);
    expect(withDetectedFacts(answered, "Best Tickets: the seat most fans miss").confirm).toHaveLength(1);
  });
});

describe("contradictions inside a brief", () => {
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

  it("catches 9:16 only next to 4x5 file names, and fixes it either way", () => {
    const issues = lintBrief({ text: "Constraints:\n- 9:16 only\n\nFile names: BT_Seat_V1_4x5", sizes: ["9x16"], formats: ["video"] });
    const only = issues.find((x) => x.id === "size-only")!;
    expect(only.severity).toBe("hard");
    expect(only.fixes.map((f) => f.kind)).toEqual(["replace", "sizes"]);
    const f = only.fixes[0];
    if (f.kind === "replace") expect(applyTextFix("Constraints:\n- 9:16 only", f.from, f.to)).toBe("Constraints:\n- 4:5 and 9:16");
  });

  it("catches 9:16 only when the request also makes 4:5", () => {
    expect(ids(lintBrief({ text: "Deliver 9:16 only.", sizes: ["4x5", "9x16"], formats: ["video"] }))).toContain("size-only");
  });

  it("catches 1:1 and landscape: Kaizen makes 4:5 and 9:16 only", () => {
    const xs = lintBrief({ text: "Also a 1:1 cut and a 16:9 version.", sizes: ["4x5", "9x16"], formats: ["video"] });
    expect(ids(xs)).toEqual(expect.arrayContaining(["size-1x1", "size-16x9"]));
    expect(hardIssues(xs).length).toBeGreaterThanOrEqual(2);
  });

  it("catches showing the brand in the first 3s against no logo, no domains", () => {
    const xs = lintBrief({ text: "Hook: show Best Tickets in the first 3s.\n\nDon't:\n- No logo / no domains", sizes: ["9x16"], formats: ["video"], client: "Best Tickets" });
    expect(ids(xs)).toContain("brand-vs-hook");
  });

  it("catches event footage against no event-specific content", () => {
    const xs = lintBrief({ text: "Use the Oct 21 event footage.\n\nConstraints:\n- No event-specific content", sizes: ["9x16"], formats: ["video"] });
    expect(ids(xs)).toContain("event-vs-footage");
  });

  it("flags durations past what Reels and Stories run, a placeholder, and beat-by-beat direction", () => {
    expect(ids(lintBrief({ text: "A 120 seconds walkthrough.", sizes: ["9x16"], formats: ["video"] }))).toContain("duration-long");
    expect(ids(lintBrief({ text: "Drive: MISSING", sizes: ["9x16"], formats: ["video"] }))).toContain("placeholder");
    const beats = lintBrief({ text: "0-3s: hook\n3-6s: the seat\n6-10s: the view\n10-15s: CTA", sizes: ["9x16"], formats: ["video"] });
    expect(beats.find((x) => x.id === "beats")?.severity).toBe("soft");
  });

  it("finds nothing in a brief that agrees with itself", () => {
    expect(lintBrief({ text: "Insight: the seat behind the bench.\n\nConstraints:\n- 4:5 and 9:16\n- No logo in the hook", sizes: ["4x5", "9x16"], formats: ["image"] })).toEqual([]);
  });
});

describe("the asset gate", () => {
  const today = new Date(2026, 10, 9); // Mon Nov 9 2026
  const base = { links: [], formats: ["video"], drive: { videos: 3, images: 10, matching: 0 }, today, due: new Date(2026, 10, 13) };

  it("is ready when everything's in", () => {
    const g = assetGate({ ...base, assets: [{ item: "Arena footage (Drive: Venues)", status: "have" }] });
    expect(g.state).toBe("ready");
    expect(g.chase).toBeNull();
  });

  it("waits on a MISSING Drive link and says who to chase", () => {
    const g = assetGate({ ...base, assets: [{ item: "Seat photos: MISSING", status: "have" }], chaser: "Sam Rivera (coordinator)" });
    expect(g.state).toBe("waiting");
    expect(g.waiting[0].status).toBe("missing");
    expect(g.chase).toBe("the client, through Sam Rivera (coordinator)");
  });

  it("waits on a Drive link Kaizen can't open", () => {
    const url = "https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWx";
    const g = assetGate({ ...base, assets: [{ item: `Footage ${url}`, status: "have" }], links: [{ url, ok: false, note: "Not shared" }] });
    expect(g.waiting[0]).toMatchObject({ status: "unreachable", note: "Not shared" });
    expect(driveLinks(`see ${url}.`)).toEqual([url]);
  });

  it("puts the due date at risk when the client has to shoot", () => {
    const g = assetGate({ ...base, assets: [{ item: "Phone clip from the seat", status: "shoot" }] });
    expect(g.shoot).toBe(true);
    expect(g.risk).toBe("Client needs to shoot; due Nov 13 is at risk");
    const later = assetGate({ ...base, due: new Date(2026, 10, 30), assets: [{ item: "Phone clip from the seat", status: "shoot" }] });
    expect(later.risk).toBeNull();
  });

  it("needs footage for a video when there's none on Drive", () => {
    const g = assetGate({ ...base, drive: { videos: 0, images: 4, matching: 0 }, assets: [] });
    expect(g.waiting.map((x) => x.label)).toEqual(["Footage for the video"]);
    expect(assetGate({ ...base, formats: ["image"], drive: { videos: 0, images: 4, matching: 0 }, assets: [] }).state).toBe("ready");
  });

  it("counts business days", () => {
    expect(businessDaysBetween(new Date(2026, 10, 6), new Date(2026, 10, 9))).toBe(1); // Fri to Mon
    expect(businessDaysBetween(today, new Date(2026, 10, 16))).toBe(5);
  });
});

describe("the gate and its status", () => {
  const assets = assetGate({ assets: [{ item: "Seat photos: MISSING", status: "have" }], links: [], formats: ["image"], drive: { videos: 0, images: 0, matching: 0 }, today: new Date(2026, 10, 9), due: null });

  it("needs client input first, then assets, then contradictions; ready, then reviewed", () => {
    const fact = [{ question: "Which seat, at which venue, and why?", answer: "", source: "" }];
    const lint = lintBrief({ text: "9:16 only", sizes: ["4x5", "9x16"], formats: ["image"] });
    expect(summarizeGate({ openFacts: fact, lint, assets }).status).toBe("needs_client_input");
    expect(summarizeGate({ openFacts: [], lint, assets }).status).toBe("waiting_on_assets");
    expect(summarizeGate({ openFacts: [], lint, assets: null }).status).toBe("has_conflicts");
    expect(summarizeGate({ openFacts: [], lint: [], assets: null }).status).toBe("ready");
    expect(summarizeGate({ openFacts: [], lint: [], assets: null, stamp: { by: "A Lead", at: "2026-11-09T15:00:00Z" } }).status).toBe("reviewed");
  });

  it("lets a lead's override through, gate by gate, and says what blocks it otherwise", () => {
    const g = summarizeGate({ openFacts: [], lint: [], assets, override: { gates: ["assets"], reason: "Footage lands Monday", by: "A Lead", at: "" } });
    expect(g.blocking).toEqual([]);
    expect(g.overridden).toEqual(["assets"]);
    expect(blockedLine(g)).toBeNull();
    expect(blockedLine(summarizeGate({ openFacts: [], lint: [], assets }))).toMatch(/waiting on assets \(Seat photos\)/);
    expect(canOverride({ isLead: true })).toBe(true);
    expect(canOverride({ role: "video_editor" })).toBe(false);
  });

  it("stamps the brief with the reviewer's name", () => {
    expect(stampLine({ by: "Dana Lee", at: "2026-11-09T15:00:00Z" })).toBe("Generated by Kaizen Ads · reviewed by Dana Lee, Nov 9, 2026");
  });
});

describe("the revise chat's patches", () => {
  const brief = composeBrief("Reveal the seat.", spec({ hook: "The seat most fans miss", constraints: ["9:16 only"], confirm: [{ question: "Which seat, at which venue, and why?", answer: "", source: "" }], assets: [{ item: "Seat photos", status: "need" }] }));
  const before = stateOf({ title: "The Seat Most Fans Miss", angle: "Insider knowledge", audience: "Fans", sizes: ["9x16"], brief });

  it("sets, adds, replaces and removes, and the brief follows", () => {
    const { state, applied, refused } = applyBriefPatch(before, [
      change({ field: "insight", op: "set", value: "Section 112 is behind the bench" }),
      change({ field: "constraints", op: "replace", index: 0, value: "4:5 and 9:16" }),
      change({ field: "sizes", op: "add", value: "4x5" }),
      change({ field: "confirm", op: "replace", index: 0, answer: "Section 112 at the Arena", source: "the team" }),
      change({ field: "assets", op: "replace", index: 0, status: "have" }),
      change({ field: "dos", op: "add", value: "Show the view from the seat" }),
    ]);
    expect(refused).toEqual([]);
    expect(applied).toHaveLength(6);
    expect(state.sizes).toEqual(["4x5", "9x16"]);
    expect(state.spec.confirm[0]).toEqual({ question: "Which seat, at which venue, and why?", answer: "Section 112 at the Arena", source: "the team" });
    expect(state.spec.assets[0]).toEqual({ item: "Seat photos", status: "have" });
    expect(briefOf(state)).toContain("Insight: Section 112 is behind the bench");
    expect(diffStates(before, state).map((d) => d.field)).toEqual(["insight", "constraints", "dos", "assets", "confirm", "sizes"]);
  });

  it("refuses what the person may not change, sizes Kaizen doesn't make, and items that aren't there", () => {
    const { applied, refused } = applyBriefPatch(
      before,
      [change({ field: "hook", op: "set", value: "Your seat, upgraded" }), change({ field: "insight", op: "set", value: "x" }), change({ field: "sizes", op: "add", value: "1x1" }), change({ field: "proof", op: "remove", index: 4 })],
      ["hook", "keyMessage", "sizes", "proof"],
    );
    expect(applied.map((c) => c.field)).toEqual(["hook"]);
    expect(refused.map((c) => c.field)).toEqual(["insight", "sizes", "proof"]);
  });

  it("undo is the state before (a round trip through the text loses nothing)", () => {
    const { state } = applyBriefPatch(before, [change({ field: "hook", op: "set", value: "Sit where the coaches talk" })]);
    expect(stateOf({ ...before, brief: briefOf(state) }).spec.hook).toBe("Sit where the coaches talk");
    expect(stateOf({ ...before, brief: briefOf(before) })).toEqual(before);
  });

  it("renders a spec without empty sections", () => {
    expect(renderSpec(spec({ hook: "Hi" }))).toBe("Hook: Hi");
  });
});
