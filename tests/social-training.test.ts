import { describe, expect, it } from "vitest";
import { cleanLessons, isSocialCandidate, socialExcerpt, socialTopics } from "@/lib/social-training-core";

describe("the social training criteria", () => {
  it("finds each criterion", () => {
    expect(socialTopics("Can we see the content calendar for December?")).toContain("calendar");
    expect(socialTopics("Let's keep the three content pillars: menu, team, events")).toContain("pillars");
    expect(socialTopics("More reels and IG stories this month")).toContain("reels_stories");
    expect(socialTopics("Engagement rate dropped and followers are flat")).toContain("engagement");
    expect(socialTopics("Who is responding to comments and DMs?")).toContain("community");
    expect(socialTopics("Please boost the Friday post")).toContain("boosting");
    expect(socialTopics("They want LinkedIn and Google Business too")).toContain("platforms");
    expect(socialTopics("We love the post about the patio, change the caption though")).toContain("post_feedback");
  });

  it("keeps messages plainly about organic social, skips the rest", () => {
    expect(isSocialCandidate({ source: "slack_external", title: null, body: "Can we post more reels on Instagram? The last carousel did great.", author: "client" }).ok).toBe(true);
    expect(isSocialCandidate({ source: "call", title: "Weekly ads sync", body: "ROAS is down, we moved budget to the prospecting ad set and paused two campaigns.", author: null }).ok).toBe(false);
    expect(isSocialCandidate({ source: "gmail", title: "Your Instagram insights digest", body: "Your reels reached 2,000 followers this week. Engagement up.", author: "no-reply@business.facebook.com" }).ok).toBe(false);
    expect(isSocialCandidate({ source: "gmail", title: "Re: posts", body: "ok", author: "client@x.com" }).ok).toBe(false);
  });

  it("reads the passages around the social words in a long call", () => {
    const filler = "We talked about the ad account and budgets for a while. ".repeat(80);
    const text = `${filler} For organic social they want two reels a week and the content calendar by the 25th. ${filler}`;
    const ex = socialExcerpt(text, 800);
    expect(ex.length).toBeLessThanOrEqual(800);
    expect(ex).toContain("two reels a week");
  });

  it("cleans the AI's lessons", () => {
    const out = cleanLessons([
      { topic: "calendar", kind: "prefer", text: "Post the weekly special every Monday", when: "Slack, Oct 2026" },
      { topic: "calendar", kind: "prefer", text: "post the weekly special every monday", when: "" },
      { topic: "made_up", kind: "weird", text: "Never show staff faces without asking", when: "" },
      { topic: "pillars", kind: "note", text: "short", when: "" },
    ]);
    expect(out).toEqual([
      { topic: "calendar", kind: "prefer", text: "Post the weekly special every Monday", when: "Slack, Oct 2026" },
      { topic: "post_feedback", kind: "note", text: "Never show staff faces without asking", when: "" },
    ]);
  });
});
