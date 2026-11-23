// External links never replace the Kaizen OS tab (owner, Nov 23 2026): Slack, Gmail, Asana, Google Docs and Drive,
// the ad managers, Klaviyo, Figma, client sites all open in a new tab; links inside the app stay in it. Every anchor
// is covered by one listener (src/components/external-links.tsx); code that navigates by hand uses openExternal.
// Pure enough for tests (tests/external-links.test.ts also flags new same-tab navigations in the code).

/** Whether a link leaves Kaizen OS (http or https to another origin) */
export function isExternalHref(href: string | null | undefined, origin: string): boolean {
  if (!href) return false;
  let u: URL;
  try {
    u = new URL(href, origin);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  return u.origin !== new URL(origin).origin;
}

/** Opens a link outside Kaizen OS in a new tab, never this one */
export function openExternal(href: string) {
  window.open(href, "_blank", "noopener,noreferrer");
}

/** The attributes for an anchor that leaves the app */
export const EXTERNAL = { target: "_blank", rel: "noopener noreferrer" } as const;
