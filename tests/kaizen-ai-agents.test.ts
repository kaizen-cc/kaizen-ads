import { describe, expect, it } from "vitest";
import { pickAgent } from "@/lib/kaizen-ai/agents";

describe("pickAgent", () => {
  it("keeps Google Docs, Drive and Sheets requests with the person's own agent", () => {
    expect(pickAgent("put this in a google doc", "head_of_email").key).toBe("strategist");
    expect(pickAgent("Save it to Google Drive please", "head_of_email").key).toBe("strategist");
    expect(pickAgent("export that to google sheets", "copywriter").key).toBe("copy");
    expect(pickAgent("make a Google Docs version", "media_buyer").key).toBe("auditor");
  });

  it("still sends Google Ads questions to the Google buyer", () => {
    expect(pickAgent("how is google doing this week?", "head_of_email").key).toBe("google_auditor");
    expect(pickAgent("check the google ads campaigns", "head_of_email").key).toBe("google_auditor");
    expect(pickAgent("review the search terms", "media_buyer").key).toBe("google_auditor");
  });
});
