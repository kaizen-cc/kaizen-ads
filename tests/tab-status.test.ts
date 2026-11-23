import { describe, expect, it } from "vitest";
import { answerState, endsWithQuestion } from "@/lib/tab-status";

describe("the tab's dot", () => {
  it("is yellow when the answer ends by asking them something", () => {
    expect(endsWithQuestion("Want me to send it?")).toBe(true);
    expect(endsWithQuestion("Which client do you mean? ")).toBe(true);
    expect(endsWithQuestion('Should I use "Black Friday?"')).toBe(true);
    expect(answerState("Which one should I book?")).toBe("question");
  });
  it("is green for a plain answer and red when it failed", () => {
    expect(endsWithQuestion("Is it working? Yes, it's live.")).toBe(false);
    expect(answerState("Done. The draft is in your Gmail.")).toBe("done");
    expect(answerState("", true)).toBe("error");
  });
});
