import { describe, expect, it } from "vitest";
import { askSource, dedupeAsks, sameAsk } from "@/lib/agent-asks-core";
import { safetySub } from "@/lib/exec-overview-core";

const a = (title: string, at: string, over: Partial<{ owner_id: string; asked_by: string | null }> = {}) => ({ owner_id: "owner", asked_by: "asker", title, created_at: at, ...over });

describe("asks saved twice", () => {
  it("the same asker, owner and near-identical title within minutes is one ask", () => {
    const x = a("Build a way to push assets from Kaizen OS into Google Drive (folders and uploads)", "2026-11-21T06:28:01Z");
    const y = a("Build a way to push assets from Kaizen OS into Google Drive (folders and files, like case studies)", "2026-11-21T06:28:03Z");
    expect(sameAsk(x, y)).toBe(true);
    expect(dedupeAsks([y, x])).toEqual([x]);
  });
  it("a different asker, owner, title or a later save stays its own", () => {
    const x = a("Integrate Shopify into Kaizen OS as soon as possible", "2026-11-21T06:28:01Z");
    expect(sameAsk(x, a(x.title, "2026-11-21T06:28:05Z", { asked_by: "someone else" }))).toBe(false);
    expect(sameAsk(x, a(x.title, "2026-11-21T06:28:05Z", { owner_id: "another" }))).toBe(false);
    expect(sameAsk(x, a("Build a way to push assets into Drive", "2026-11-21T06:28:05Z"))).toBe(false);
    expect(sameAsk(x, a(x.title, "2026-11-21T07:00:00Z"))).toBe(false);
    expect(dedupeAsks([x, a("Fix it", "2026-11-21T06:28:02Z"), a("Fix it", "2026-11-21T06:28:03Z")])).toHaveLength(3);
  });
});

describe("where an ask came from", () => {
  it("a call opens the call, a chat the assistant", () => {
    expect(askSource({ call_id: "c1", role_key: "assistant" })).toEqual({ label: "From a call", href: "/assistant?call=c1" });
    expect(askSource({ call_id: null, role_key: null }).label).toBe("From a chat");
  });
});

describe("each flagged call on its own", () => {
  it("carries the caller's role and name, when, what, how serious, and the first moment", () => {
    const s = safetySub(
      { call_id: "k1", severity: "high", distress: false, categories: ["harassment", "self_harm"], reviewed_at: "2026-11-22T12:00:00Z", moments: [{ at_seconds: 200, category: "x", note: "later" }, { at_seconds: 75, category: "harassment", note: "first thing" }] },
      { started_at: "2026-11-22T11:00:00Z", profiles: { full_name: "Pat Doe", role: "media_buyer" } },
    );
    expect(s.key).toBe("safety:k1");
    expect(s.href).toBe("/safety/k1");
    expect(s.title).toBe("Media buyer · Pat Doe: harassment, self harm");
    expect(s.meta).toContain("high severity");
    expect(s.detail).toBe("At 1:15: first thing");
  });
  it("without the call or moments it still reads", () => {
    const s = safetySub({ call_id: "k2", severity: null, distress: true, categories: null, reviewed_at: null, summary: "Raised voices" }, null);
    expect(s.title).toBe("Someone: flagged");
    expect(s.meta).toBe("distress");
    expect(s.detail).toBe("Raised voices");
  });
});
