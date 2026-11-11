import { describe, expect, it } from "vitest";
import { applyBriefPatch, stateOf, type BriefChange } from "@/lib/brief-patch";
import { lintBrief } from "@/lib/brief-lint";
import { checkPayoff } from "@/lib/brief-payoff";
import {
  SPEC_RULE,
  beatLine,
  beatOf,
  beatRows,
  cleanSpec,
  composeBrief,
  copyOf,
  emptySpec,
  exportLineFor,
  frameOf,
  hookOf,
  pacing,
  parseBrief,
  slideOf,
  slideRows,
  structureBrief,
  type BriefSpec,
} from "@/lib/brief-spec";

// One brief structure for video, carousel and single image (the lead video editor's brief, with Kaizen's additions):
// the idea and its payoff, why it works, who it's for, the build by format (beats, slides, the frame), the versions,
// Must, Never, Your call, assets, copy, what to confirm and the export line. Each format round-trips through the text.

const spec = (p: Partial<BriefSpec>): BriefSpec => ({ ...emptySpec(), ...p });

const video = spec({
  stage: "Evergreen TOF",
  insight: "Asked why people should buy from them, the owner says one word: convenience. A real local team and more than one way to buy.",
  insightSource: "Owner interview, Drive",
  who: "Fans who want good seats from people they trust",
  length: "~30s",
  beats: [
    'Hook | On screen: The owner on camera, logo from frame 1 | Text: "This is the detail most people miss when buying tickets" | Says: "Convenience." (Source: Owner interview 0:00-0:04)',
    "0:05-0:09 | The team | On screen: Staff at work | Says: \"Come by and see us.\" (Source: Owner interview 0:12-0:16)",
    "0:09-0:15 | Your way | On screen: Seat view with the site on screen",
    "0:27-0:30 | End card | On screen: Seat view, logo and the site",
  ].map((x) => beatLine(beatOf(x))),
  audio: "Music only, low under the owner.",
  versions: ["This is the detail most people miss when buying tickets", "Why buy from a local team?", "One word: convenience"],
  dos: ["Logo on screen in the first 3 seconds", "Captions burned in on every spoken line"],
  donts: ["Don't use: 'two great offices', the VIP lounge", "No price, deals or urgency"],
  yourCall: "Edit style, cut points, transitions and which clips within the folders are yours.",
  assets: [{ item: "Owner interview (Drive: Interviews), the full answer", status: "have" }, { item: "Seat views without dates or scoreboards", status: "need" }],
  copy: ["Primary: Real seats, real people who know the venue.", "Headline: Best Seats, Best Service", "CTA: Shop Now"],
  confirm: [{ question: "Is checkout working again?", answer: "", source: "" }],
});

describe("the brief's one structure", () => {
  it("round-trips a video brief: beats, audio, length, versions, must, never, copy", () => {
    const text = composeBrief("The owner's answer, Convenience, is the detail: a real local team and more than one way to buy.", video);
    expect(text).toContain("Why it works: Asked why");
    expect(text).toContain("Beats:\n- Hook | On screen: The owner on camera");
    expect(text).toContain("Versions:\n- V1: This is the detail most people miss when buying tickets\n- V2:");
    expect(text).toContain("Must:\n- Logo on screen");
    expect(text).toContain("Never:\n- Don't use:");
    expect(text).not.toMatch(/\u2014/);
    const back = parseBrief(text);
    expect(back.structured).toBe(true);
    expect(back.spec).toEqual(video);
    expect(composeBrief(back.overview, back.spec)).toBe(text);
    const rows = beatRows(back.spec);
    expect(rows[0]).toMatchObject({ name: "Hook", text: '"This is the detail most people miss when buying tickets"', says: '"Convenience."', source: "Owner interview 0:00-0:04" });
    expect(rows[1]).toMatchObject({ time: "0:05-0:09", name: "The team" });
  });

  it("round-trips a carousel brief: one line per slide, a flow top to bottom", () => {
    const sp = spec({
      insight: "Section 112 sits behind the bench: you hear the coaches.",
      insightSource: "Brand Bible",
      slides: ["Hook | Headline: The seat most fans skip | Shows: The arena from the upper deck", "Proof | Headline: You hear the coaches | Shows: The view from 112", "CTA | Headline: Find your seat | Shows: The logo and the site"],
      versions: ["The seat most fans skip", "Hear the coaches from your seat"],
      dos: ["Each slide works on its own"],
    });
    const text = composeBrief("Section 112 is the payoff: behind the bench, where you hear the coaches.", sp);
    expect(text).toContain("Slides:\n1. Hook | Headline: The seat most fans skip | Shows: The arena from the upper deck\n2. Proof");
    const back = parseBrief(text);
    expect(back.spec).toEqual(sp);
    expect(slideRows(back.spec).map((s) => s.job)).toEqual(["Hook", "Proof", "CTA"]);
  });

  it("round-trips a single image brief: the frame", () => {
    const sp = spec({
      insight: "Their patio ads beat food-only ads on cost per reservation.",
      frame: ["Headline: Fridays on the patio", "Subline: Fire pits lit from 5pm", "Shows: The full patio at golden hour, a flight up front", "Reads first: Headline, then the flight, then the button", "CTA: Book a table"],
      versions: ["Fridays on the patio", "The best seat in town is outside"],
    });
    const text = composeBrief("Golden hour on the patio sells the Friday plan.", sp);
    const back = parseBrief(text);
    expect(back.spec).toEqual(sp);
    expect(frameOf(back.spec.frame)).toEqual({ headline: "Fridays on the patio", subline: "Fire pits lit from 5pm", shows: "The full patio at golden hour, a flight up front", readsFirst: "Headline, then the flight, then the button", cta: "Book a table" });
  });

  it("still reads an older brief: Insight, Do, Don't, Constraints and plain slides", () => {
    const old = "Reveal the seat.\n\nInsight: Section 112 sits behind the bench (Source: Brand Bible)\n\nHook: The seat most fans miss\n\nSlides:\n1. The myth\n2. The seat\n\nConstraints:\n- 9:16 only\n\nDo:\n- Show the view\n\nDon't:\n- No prices\n\nYour call: Yours.";
    const p = parseBrief(old);
    expect(p.structured).toBe(true);
    expect(p.spec).toMatchObject({ insight: "Section 112 sits behind the bench", insightSource: "Brand Bible", hook: "The seat most fans miss", dos: ["Show the view"], donts: ["No prices"], constraints: ["9:16 only"] });
    expect(slideOf(p.spec.slides[0])).toEqual({ job: "", headline: "The myth", shows: "" });
    expect(hookOf(p.spec)).toBe("The seat most fans miss");
    // Rendered again it reads under today's headings, nothing lost
    expect(parseBrief(composeBrief(p.overview, p.spec)).spec).toEqual(p.spec);
  });

  it("takes V1's line as the hook when there's no Hook line, for the payoff check", () => {
    const sp = spec({ versions: ["The hack most people miss when buying seats"] });
    expect(hookOf(sp)).toBe("The hack most people miss when buying seats");
    expect(checkPayoff({ overview: "", spec: sp }).promise).toMatch(/hack/i);
  });

  it("holds a writer's brief to two pages: 5 Must, 5 Never, 6 beats, 5 assets, 2 primary texts", () => {
    const c = cleanSpec({
      dos: Array.from({ length: 8 }, (_, i) => `Must ${i}`),
      donts: Array.from({ length: 8 }, (_, i) => `Never ${i}`),
      beats: Array.from({ length: 9 }, (_, i) => `0:0${i}-0:0${i + 1} | Beat ${i} | On screen: x`),
      assets: Array.from({ length: 9 }, (_, i) => ({ item: `Folder ${i}`, status: "have" as const })),
      copy: ["Primary: a", "Primary: b", "Primary: c", "Headline: h1", "Headline: h2", "Headline: h3", "CTA: Shop"],
    });
    expect([c.dos.length, c.donts.length, c.beats.length, c.assets.length]).toEqual([5, 5, 6, 5]);
    expect(copyOf(c.copy)).toEqual({ primary: ["a", "b"], headlines: ["h1", "h2"], cta: "Shop" });
  });

  it("reads beats written loosely, and paces them", () => {
    expect(beatOf("0-3s: the opening line")).toMatchObject({ time: "0-3s", onScreen: "the opening line" });
    const p = pacing(beatRows(video));
    expect(p.parts).toHaveLength(4);
    expect(p.parts.reduce((n, x) => n + x.share, 0)).toBeGreaterThan(0.99);
  });

  it("writes the export line from the request: 4:5 and 9:16 only, carousel slides 1080x1350, MP4 with captions", () => {
    const v = exportLineFor(["video"], ["9x16"], "Best Tickets", "The Detail Most People Miss");
    expect(v).toContain("MP4 H.264, 1080x1920 (9:16), captions burned in");
    expect(v).toContain("top 270 px");
    expect(v).toContain("Best_Tickets_The_Detail_Most_People_Mi");
    const c = exportLineFor(["carousel"], ["4x5", "9x16"], "Casa Verde", "Patio");
    expect(c).toContain("Carousel slides: 1080x1350 (4:5)");
    expect(c).not.toContain("9x16");
    expect(exportLineFor(["image"], ["1x1"], "A", "B")).not.toMatch(/1:1|1x1|1080x1080/);
  });

  it("tells every writer the shape, and the shape drops the old boilerplate", () => {
    for (const h of ["Why it works:", "Who it's for:", "Beats:", "Slides:", "Frame:", "Versions:", "Must:", "Never:", "Your call:", "Assets:", "Copy:", "Confirm with client:"]) expect(SPEC_RULE).toContain(h);
    expect(SPEC_RULE).not.toMatch(/\u2014/);
    expect(SPEC_RULE).toMatch(/Never write specs, sizes, safe zones or file names/);
  });

  it("structures a writer's brief written in the new sections, and keeps free text as written", () => {
    const text = composeBrief("The idea.", video);
    expect(structureBrief(text, "The Detail")).toBe(composeBrief("The idea.", cleanSpec(video)));
    expect(structureBrief("Just some words.", "t")).toBe("Just some words.");
  });
});

describe("the revise chat edits the build", () => {
  const change = (c: Partial<BriefChange> & Pick<BriefChange, "field" | "op">): BriefChange => ({ value: "", index: -1, status: "", answer: "", source: "", ...c });
  const before = stateOf({ title: "The Detail", angle: "Convenience", audience: "Fans", sizes: ["9x16"], brief: composeBrief("The idea.", video) });

  it("adds a beat as its line, replaces a version without its V2:, and sets who it's for", () => {
    const { state, refused } = applyBriefPatch(before, [
      change({ field: "beats", op: "add", value: "0:21-0:27 | The difference | On screen: Crowd, then the owner | Says: \"A lot different than a ticket website.\"" }),
      change({ field: "versions", op: "replace", index: 1, value: "V2: Local experts, your seats" }),
      change({ field: "who", op: "set", value: "Locals who want help choosing seats" }),
    ]);
    expect(refused).toEqual([]);
    expect(state.spec.beats[4]).toBe('0:21-0:27 | The difference | On screen: Crowd, then the owner | Says: "A lot different than a ticket website."');
    expect(state.spec.versions[1]).toBe("Local experts, your seats");
    expect(state.spec.who).toBe("Locals who want help choosing seats");
  });
});

describe("the lint under the new structure", () => {
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
  const text = composeBrief("The owner's answer is the detail.", video);

  it("leaves a video's beats alone: they're its spine", () => {
    expect(ids(lintBrief({ text, sizes: ["9x16"], formats: ["video"] }))).toEqual([]);
  });

  it("flags edit-level direction: transitions, exact cuts, camera moves, a named track", () => {
    const over = composeBrief("The idea.", { ...video, beats: [...video.beats.slice(0, 3), "0:15-0:21 | Start to finish | On screen: whip transition to the aisle, slow motion on the crowd"], audio: 'Track: "Levels" by Avicii' });
    const issue = lintBrief({ text: over, sizes: ["9x16"], formats: ["video"] }).find((x) => x.id === "over-direction");
    expect(issue?.severity).toBe("soft");
    // Handing it to the maker in Your call or ruling it out in Never isn't directing it
    const handed = composeBrief("The idea.", { ...video, yourCall: "Transitions, slow motion and the track are yours.", donts: ["No whip transition to the logo"] });
    expect(ids(lintBrief({ text: handed, sizes: ["9x16"], formats: ["video"] }))).not.toContain("over-direction");
  });

  it("flags the new limits, softly: more than 5 Must or Never, no beats, no slide flow, no headline", () => {
    const long = composeBrief("The idea.", { ...video, dos: Array.from({ length: 7 }, (_, i) => `Must ${i}`), donts: Array.from({ length: 6 }, (_, i) => `Never ${i}`) });
    const xs = lintBrief({ text: long, sizes: ["9x16"], formats: ["video"] });
    expect(ids(xs)).toEqual(expect.arrayContaining(["must-many", "never-many"]));
    expect(xs.every((x) => x.severity === "soft")).toBe(true);
    expect(ids(lintBrief({ text: composeBrief("The idea.", { ...video, beats: [] }), sizes: ["9x16"], formats: ["video"] }))).toContain("video-no-beats");
    expect(ids(lintBrief({ text: composeBrief("The idea.", { ...video, beats: [] }), sizes: ["4x5"], formats: ["carousel"] }))).toContain("carousel-no-slides");
    expect(ids(lintBrief({ text: composeBrief("The idea.", { ...video, beats: [], versions: [], frame: ["Shows: the patio"] }), sizes: ["4x5"], formats: ["image"] }))).toContain("frame-no-headline");
  });

  it("doesn't ask an older brief for beats it was never meant to have", () => {
    expect(ids(lintBrief({ text: "Insight: the seat behind the bench.\n\nHook: The seat\n\nConstraints:\n- 4:5 and 9:16", sizes: ["9x16"], formats: ["video"] }))).toEqual([]);
  });
});
