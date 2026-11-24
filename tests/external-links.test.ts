import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isExternalHref } from "@/lib/external-link";

// External links never replace the Kaizen OS tab (owner, Nov 23 2026). Anchors are covered by one listener
// (src/components/external-links.tsx); this flags code that navigates the OS tab by hand, so a new one can't slip in.

describe("what leaves Kaizen OS", () => {
  const o = "https://app.kaizenmarketing.agency";
  it("another origin over http(s) is external", () => {
    expect(isExternalHref("https://kaizen.slack.com/archives/C1/p2", o)).toBe(true);
    expect(isExternalHref("https://mail.google.com/mail/u/0/#inbox/abc", o)).toBe(true);
    expect(isExternalHref("https://app.asana.com/0/1/2", o)).toBe(true);
    expect(isExternalHref("https://business.facebook.com/adsmanager", o)).toBe(true);
  });
  it("the app itself, mail and phone links are not", () => {
    expect(isExternalHref("/pipeline?block=needs", o)).toBe(false);
    expect(isExternalHref("https://app.kaizenmarketing.agency/kpis", o)).toBe(false);
    expect(isExternalHref("mailto:someone@example.com", o)).toBe(false);
    expect(isExternalHref("tel:+15555550100", o)).toBe(false);
    expect(isExternalHref("#top", o)).toBe(false);
    expect(isExternalHref(null, o)).toBe(false);
  });
});

/** Same-tab navigations by hand that are allowed: sign-in and connect flows that must come back to this tab, and
 *  fallbacks that only ever load an in-app address */
const ALLOWED: Record<string, string> = {
  "src/app/(team)/ai/connectors-ui.tsx": "connecting an AI connector signs in and returns here (an in-app route)",
  "src/app/(team)/settings/work-connection-controls.tsx": "Switch account signs in to Slack again and returns to Settings (an in-app route)",
  "src/app/(team)/pipeline/views/exec-home.tsx":"the main action's fallback loads an in-app address (external links return early)",
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(tsx?|jsx?)$/.test(f) ? [p] : [];
  });
}

describe("nothing replaces the OS tab with an outside page", () => {
  it("navigating this tab by hand only where it's known to stay in the app", () => {
    const offenders: string[] = [];
    for (const f of files("src")) {
      const rel = f.replace(/\\/g, "/");
      const text = readFileSync(f, "utf8");
      const lines = text.split("\n");
      lines.forEach((l, i) => {
        if (/\bwindow\.location\.(href\s*=[^=]|assign\(|replace\()/.test(l) && !ALLOWED[rel]) offenders.push(`${rel}:${i + 1}: ${l.trim()}`);
        if (/router\.(push|replace)\(\s*["'`]https?:/.test(l)) offenders.push(`${rel}:${i + 1}: ${l.trim()}`);
      });
    }
    expect(offenders, "Open outside links with openExternal (src/lib/external-link.ts), never in this tab").toEqual([]);
  });
});
