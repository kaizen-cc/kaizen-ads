import { describe, expect, it } from "vitest";
import { HERE, mentionLabel, openWithHere, withoutMentions } from "@/lib/reports/slack-text";

// A report's Slack message always opens with @here (<!here>), never a person's mention: the raw "<@U085HHFG535>" shows as
// that code in the studio's preview and may not resolve for a client in a shared channel.

describe("openWithHere", () => {
  it("turns a person's mention at the start into @here", () => {
    expect(openWithHere("<@U085HHFG535> Hi team, here's the week.")).toBe("<!here> Hi team, here's the week.");
    expect(openWithHere("<@U085HHFG535>, Hi team!")).toBe("<!here> Hi team!");
    expect(openWithHere("<@U085HHFG535|sam>: Hi team")).toBe("<!here> Hi team");
  });

  it("opens a message that had no mention with @here", () => {
    expect(openWithHere("Hi team, here's the week.")).toBe(`${HERE} Hi team, here's the week.`);
    expect(openWithHere("*Weekly report*\n• Leads up 12%")).toBe("<!here> *Weekly report*\n• Leads up 12%");
  });

  it("turns @channel and @everyone at the start into @here, and never doubles @here", () => {
    expect(openWithHere("<!channel> Hi team")).toBe("<!here> Hi team");
    expect(openWithHere("<!everyone> Hi team")).toBe("<!here> Hi team");
    expect(openWithHere("<!here> Hi team")).toBe("<!here> Hi team");
    expect(openWithHere(openWithHere("<@U085HHFG535> Hi team"))).toBe("<!here> Hi team");
    expect(openWithHere("<@U085HHFG535> <@U0ABCDEF12> Hi team")).toBe("<!here> Hi team");
  });

  it("takes a person tagged further in out of the message and tidies the sentence", () => {
    expect(openWithHere("Hi team. Thanks <@U085HHFG535>, we hit the target.\nSecond line <@U0ABCDEF12> here.")).toBe("<!here> Hi team. Thanks, we hit the target.\nSecond line here.");
  });

  it("leaves links, bold and numbers alone", () => {
    const text = "<!here> *Leads* were 38 at $30.56 (1.81 to 1.38). <https://x.test/r|See the report>";
    expect(openWithHere(text)).toBe(text);
  });

  it("handles an empty message", () => {
    expect(openWithHere("")).toBe("");
    expect(openWithHere(null)).toBe("");
    expect(openWithHere("<@U085HHFG535>")).toBe(HERE);
  });
});

describe("the preview and the writer's examples", () => {
  it("draws a mention the way Slack shows it", () => {
    expect(mentionLabel("<!here>")).toBe("@here");
    expect(mentionLabel("<!channel>")).toBe("@channel");
    expect(mentionLabel("<@U085HHFG535>")).toBe("@someone");
    expect(mentionLabel("<@U085HHFG535|sam>")).toBe("@sam");
  });

  it("takes the mentions out of a buyer's past recaps the writer learns from", () => {
    expect(withoutMentions("<@U085HHFG535> Hi team,\nLeads were up.")).toBe("Hi team,\nLeads were up.");
  });
});
