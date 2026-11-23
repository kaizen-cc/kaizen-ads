import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/app/(team)/requests/new/draft-store", () => ({ deleteBriefDraftAction: async () => {} }));

import { UnfinishedBriefs, ago } from "@/components/unfinished-briefs";

// The "Unfinished brief" card on /requests/new and the Overview says how long ago each draft was edited. The server
// draws it and the browser picks it up a moment later: the "how long ago" sits in its own span that tells React a
// minute's difference isn't a mismatch (React error #418 crashed the new request page, issue #117).

describe("unfinished briefs", () => {
  const now = Date.parse("2026-11-23T15:00:00Z");
  it("says how long ago", () => {
    expect(ago("2026-11-23T15:00:20Z", now)).toBe("just now");
    expect(ago("2026-11-23T14:55:00Z", now)).toBe("5 min ago");
    expect(ago("2026-11-23T13:00:00Z", now)).toBe("2 hours ago");
    expect(ago("2026-11-22T15:00:00Z", now)).toBe("yesterday");
    expect(ago("2026-11-20T15:00:00Z", now)).toBe("3 days ago");
  });

  it("puts every 'how long ago' in a span React won't flag when the minute turns before the page wakes up", () => {
    const iso = new Date(Date.now() - 5 * 60_000).toISOString();
    const html = renderToStaticMarkup(
      createElement(UnfinishedBriefs, {
        drafts: [
          { id: "a", client: "Acme", title: "First", updatedAt: iso },
          { id: "b", client: null, title: null, updatedAt: iso },
        ],
      }),
    );
    expect(html.match(/<span>\d+ min ago<\/span>/g)?.length).toBe(2);
    expect(html).toContain("Acme · edited <span>");
    // The attribute never reaches the HTML, so the source is where it's checked
    expect(readFileSync("src/components/unfinished-briefs.tsx", "utf8")).toContain("<span suppressHydrationWarning>{ago(iso, now)}</span>");
  });
});
