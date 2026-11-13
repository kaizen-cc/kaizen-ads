import { describe, expect, it } from "vitest";
import { narrativeIssues } from "@/lib/brief-narrative";
import { lintBrief } from "@/lib/brief-lint";
import { CONFIRM_HEAD, confirmItems, imageVersionNote, versionChange, versionLines } from "@/lib/brief-derive";
import { composeBrief, emptySpec, type BriefSpec } from "@/lib/brief-spec";
import { NARRATIVE_RULE, SWAP_RULE } from "@/lib/brief-craft";

// The narrative QA pass (does the story work: the hook answered in time, versions that match the body, the strongest
// visual placed where it works, claims flagged, a concept that's this client's), and the headings read from the content
// (a blocker shown as one, "only the hook changes" only when it's true). From the lead strategist's notes on the
// CrowdSync video brief. Every finding is a soft flag with a fix, never a hold.

const spec = (p: Partial<BriefSpec>): BriefSpec => ({ ...emptySpec(), yourCall: "Yours.", ...p });
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

const good = spec({
  stage: "Evergreen TOF",
  insight: "At the Oct 18 show CrowdSync took gate lines from 40 minutes to under 5; the venue manager says it on camera.",
  insightSource: "Client call Oct 21",
  who: "Venue operations leads",
  beats: [
    '0:00-0:03 | Hook | On screen: the line outside | Text: "Why did 2,000 fans miss the first song?" | Says: "Because the gate took 40 minutes." (Source: manager 0:02)',
    "0:03-0:09 | The fix | On screen: the scanner turning green",
    "0:09-0:15 | The reveal | On screen: the full floor before the first song",
    "0:15-0:20 | End card | On screen: logo and Book a demo",
  ],
  versions: ["Why did 2,000 fans miss the first song?", "40 minutes at the gate. Not anymore."],
  confirm: [{ question: "Blocker: Can we say 2,000 fans?", answer: "", source: "" }],
});

describe("the video's story", () => {
  it("passes a brief whose hook is answered in time and whose proof is the client's own", () => {
    expect(ids(narrativeIssues({ text: composeBrief("CrowdSync took the Oct 18 gate lines from 40 minutes to under 5.", good), formats: ["video"], client: "CrowdSync" }))).toEqual([]);
  });

  it("flags a hook whose answer only comes at 6 seconds", () => {
    const late = spec({
      ...good,
      beats: ['0:00-0:06 | Hook | On screen: the line outside | Text: "What do 2,000 fans miss every opening night?"', "0:06-0:14 | The answer | On screen: the empty floor | Text: \"The first song\"", "0:14-0:20 | End card | On screen: logo"],
    });
    const xs = narrativeIssues({ text: composeBrief("CrowdSync took the Oct 18 gate lines from 40 minutes to under 5.", late), formats: ["video"] });
    const hook = xs.find((x) => x.id === "hook-answer-late");
    expect(hook?.message).toMatch(/0:06/);
    expect(hook?.severity).toBe("soft");
    expect(hook?.fixes[0].instruction).toMatch(/first 3 seconds/);
  });

  it("flags the strongest visual spent right after the hook", () => {
    const early = spec({ ...good, beats: ['0:00-0:02 | Hook | On screen: the line | Text: "Opening night."', "0:02-0:04 | The reveal | On screen: the full floor", "0:04-0:10 | Team | On screen: staff", "0:10-0:15 | Proof | On screen: the dashboard", "0:15-0:20 | End card | On screen: logo"] });
    expect(ids(narrativeIssues({ text: composeBrief("CrowdSync took the Oct 18 gate lines from 40 minutes to under 5.", early), formats: ["video"] }))).toContain("strongest-early");
  });

  it("flags a version that states what the body never shows, and a claim nobody sourced", () => {
    const off = spec({ ...good, versions: [...good.versions, "Lines 73% shorter, every night."] });
    const xs = narrativeIssues({ text: composeBrief("CrowdSync took the Oct 18 gate lines from 40 minutes to under 5.", off), formats: ["video"] });
    expect(ids(xs)).toContain("version-claim-3");
    expect(xs.some((x) => /73%/.test(x.message) && x.id.startsWith("claim-"))).toBe(true);
  });

  it("flags fewer versions or slides than asked for", () => {
    expect(ids(narrativeIssues({ text: composeBrief("CrowdSync took the Oct 18 gate lines from 40 minutes to under 5.", good), formats: ["video"], versionsAsked: 4 }))).toContain("versions-short");
  });
});

describe("the single image's and the carousel's story", () => {
  it("flags a headline question the image never answers, and a frame that reads the logo first", () => {
    const img = spec({ ...good, beats: [], frame: ["Headline: Still waiting at the gate?", "Shows: the line outside", "Reads first: the logo, then the headline"], versions: ["Still waiting at the gate?"] });
    const xs = ids(narrativeIssues({ text: composeBrief("CrowdSync took the Oct 18 gate lines from 40 minutes to under 5.", img), formats: ["image"] }));
    expect(xs).toEqual(expect.arrayContaining(["headline-open", "reads-first"]));
    const answered = spec({ ...good, beats: [], frame: ["Headline: Still waiting at the gate?", "Subline: Not with CrowdSync: under 5 minutes at the Oct 18 show", "Reads first: the headline, then the scanner"], versions: ["Still waiting at the gate?"] });
    expect(ids(narrativeIssues({ text: composeBrief("CrowdSync took the Oct 18 gate lines from 40 minutes to under 5.", answered), formats: ["image"] }))).not.toContain("headline-open");
  });

  it("flags a carousel that doesn't hook first, puts the CTA mid-flow and doesn't end on the click", () => {
    const car = spec({ ...good, beats: [], slides: ["Proof | Headline: 12,000 fans | Shows: crowd", "CTA | Headline: Book a demo | Shows: button", "Payoff | Headline: Under 5 minutes | Shows: scanner"] });
    const xs = ids(narrativeIssues({ text: composeBrief("CrowdSync took the Oct 18 gate lines from 40 minutes to under 5.", car), formats: ["carousel"], slidesAsked: 5 }));
    expect(xs).toEqual(expect.arrayContaining(["slide1-hook", "slide-order", "last-cta", "slides-short"]));
    const fine = spec({ ...good, beats: [], slides: ["Hook | Headline: 40 minutes at the gate? | Shows: the line", "Proof | Headline: Under 5 at the Oct 18 show | Shows: scanner", "CTA | Headline: Book a demo | Shows: button"] });
    const ok = ids(narrativeIssues({ text: composeBrief("CrowdSync took the Oct 18 gate lines from 40 minutes to under 5.", fine), formats: ["carousel"], slidesAsked: 3 }));
    expect(ok.filter((x) => x.startsWith("slide") || x === "last-cta")).toEqual([]);
  });
});

describe("differentiation: the competitor swap test", () => {
  it("flags a concept with no client-specific proof, and an idea that restates the intake", () => {
    const generic = spec({ insight: "People want a better experience at events.", who: "Event goers", beats: ["0:00-0:03 | Hook | On screen: a crowd | Text: \"Better events start here\"", "0:03-0:10 | End card | On screen: logo"], versions: ["Better events start here"] });
    const xs = narrativeIssues({ text: composeBrief("Better events for event goers who want a better experience.", generic), formats: ["video"], angle: "Better event experience", audience: "Event goers who want a better experience", client: "CrowdSync" });
    expect(ids(xs)).toEqual(expect.arrayContaining(["generic-concept", "restates-intake"]));
    expect(xs.find((x) => x.id === "generic-concept")?.fixes[0].instruction).toMatch(/competitor's logo/);
  });

  it("never counts the client's own name as proof (a competitor's swaps in for it)", () => {
    const named = spec({ insight: "CrowdSync makes events better.", who: "Event goers", beats: ["0:00-0:03 | Hook | On screen: a crowd | Text: \"CrowdSync makes it better\"", "0:03-0:10 | End card | On screen: logo"] });
    expect(ids(narrativeIssues({ text: composeBrief("CrowdSync makes events better.", named), formats: ["video"], client: "CrowdSync" }))).toContain("generic-concept");
  });

  it("puts the swap test and the narrative checks in every writer's rules, roles not names, no em dashes", () => {
    expect(SWAP_RULE).toMatch(/competitor's logo/);
    expect(NARRATIVE_RULE).toMatch(/first ~3 seconds/);
    expect(NARRATIVE_RULE).toMatch(/Carousel: the first slide hooks/);
    expect(`${SWAP_RULE}${NARRATIVE_RULE}`).not.toMatch(/—/);
  });

  it("comes through the brief check as soft flags with a fix, never a hold", () => {
    const generic = spec({ insight: "People want a better experience.", who: "Event goers", beats: ["0:00-0:03 | Hook | On screen: a crowd | Text: \"Better events\"", "0:03-0:10 | End card | On screen: logo"] });
    const xs = lintBrief({ text: composeBrief("Better events.", generic), sizes: ["9x16"], formats: ["video"] });
    const g = xs.find((x) => x.id === "generic-concept");
    expect(g?.severity).toBe("soft");
    expect(g?.fixes[0].kind).toBe("ai");
  });
});

describe("headings read from the content", () => {
  it("shows a question that blocks the work as a blocker, word for word", () => {
    const xs = confirmItems(
      ["Is the stadium clip cleared for paid ads? Don't start V3 until the client confirms.", "Blocker: Can we say 12,000 fans?", "Which manager can we name?", "Is the date right?", "Do the people in the clips have releases?", "Is the 40 minutes figure theirs?"],
      "40 minutes at the gate. Under 5 now.",
    );
    expect(xs.map((x) => x.blocker)).toEqual([true, true, false, false, true, false]);
    expect(xs[0].text).toBe("Is the stadium clip cleared for paid ads? Don't start V3 until the client confirms.");
    expect(xs[1].text).toBe("Can we say 12,000 fans?");
    expect(CONFIRM_HEAD.blockers).toMatch(/Blocker/);
    expect(CONFIRM_HEAD.open).toMatch(/doesn't hold the work/);
    // A claim the ad states makes its question a blocker
    expect(confirmItems(["Where does 73% come from?"], "Lines 73% shorter")[0].blocker).toBe(true);
  });

  it('says "only the hook changes" only when the versions share the body', () => {
    expect(versionChange(["Opening night.", "What if the line was gone?", "Your gate, fixed."], "video")).toMatchObject({ shared: true, note: "only the hook changes; V1 is net new" });
    const d = versionChange(["Opening night.", "What if the line was gone? | Also changes: the manager quote moves to beat 2", '"12,000 fans" with the stadium footage instead of the crowd clip'], "video");
    expect(d.shared).toBe(false);
    expect(d.note).not.toMatch(/only the hook changes/);
    expect(d.rows[1].also).toBe("the manager quote moves to beat 2");
    expect(d.rows[2].also).toMatch(/stadium footage/);
    expect(versionLines(["A | Also changes: B"])[0]).toEqual({ num: "V1", line: "A", also: "B" });
    expect(versionChange(["Same body, new line: Gate fixed", "x"], "video").shared).toBe(true);
  });

  it("says only the headline changes on a single image only when every other version keeps V1's design", () => {
    expect(imageVersionNote([{ kind: "Net new", shows: "Gate photo" }, { kind: "Variation of V1", shows: "Same design and photo as V1" }])).toMatch(/only the headline changes/);
    expect(imageVersionNote([{ kind: "Net new", shows: "Gate photo" }, { kind: "Net new", shows: "Crowd photo" }])).not.toMatch(/only the headline/);
    expect(imageVersionNote([{ kind: "Net new", shows: "Gate photo" }, { kind: "Variation of V1", shows: "The stadium photo" }])).not.toMatch(/only the headline/);
  });
});
