import { Document, Font } from "@react-pdf/renderer";
import type { ReportMetrics } from "./metrics";
import type { Sections } from "./write";
import { scrubAgency, scrubName, scrubSections } from "./white-label";
import { EDIT_HOST, WeeklyReport, type WeeklyBrand } from "./weekly-doc";
import type { ReportLayout } from "./format";

// The client report as a PDF document. Every kind (the weekly, the monthly recap, a report from the report builder) is
// drawn in one design (weekly-doc.tsx), after the hand-made report the team loved: Kaizen's header and red leading, the
// client's logo and colour beside them, a section per platform. A white label client's carries only the client's brand:
// no agency name, mark, red or link anywhere, the file's own properties included, so the partner can pass it on as their
// own. The narrative (what we did, what we're doing, what's next) is never printed: it goes in the message that carries
// the report. The same document on the server (the PDF the client gets) and in the studio's browser (the preview, drawn
// as the buyer edits, so a change shows at once); ad images come in ready-made.

/** extra: a built report's other date ranges (the first range is metrics) */
/** layout: the metrics the buyer chose (null: the defaults) */
export type ReportPart = { platform: "meta" | "google" | "tiktok"; buyer: string | null; metrics: ReportMetrics; sections: Sections; extras: string | null; extra?: ReportMetrics[] | null; layout?: ReportLayout | null };
/** built: a report from the report builder (one design: a section per service, its other ranges after its own numbers) */
/** edit: the studio's preview, with an invisible link over every metric, row and column the buyer can change (never sent) */
/** dashboard: the client's live dashboard in their portal, linked at the end (when their portal is open) */
/** whiteLabel: a white label client's report: their brand alone, with no agency name, mark, red or link anywhere */
/** brand: the client's logo and colour (and Kaizen's logo), filled on the server before the document is drawn */
/** clientId: whose brand to read (never drawn) */
export type ReportPdfInput = { client: string; kind: "weekly" | "monthly" | "built"; periodLabel: string; parts: ReportPart[]; edit?: boolean; dashboard?: string | null; /** The monthly recap's ask: next cycle's shot list (clients on a creative package) */ shots?: { month: string; items: string[]; url: string | null } | null; whiteLabel?: boolean; brand?: WeeklyBrand | null; clientId?: string | null };

// Words wrap whole: no "APPLICA-TION" in a tile label or a column header
Font.registerHyphenationCallback((word) => [word]);

export { EDIT_HOST };

/** The agency's name on the file's own properties (a white label report names none) */
const AGENCY = "Kaizen Marketing";

/** A link a white label report may carry: never one to the agency's site or portal */
const clean = (url: string | null | undefined) => (url && !/kaizen/i.test(url) ? url : null);

/** The file's title: "OceanBox · Weekly report · Nov 2 – Nov 8" */
export const documentTitle = (input: Pick<ReportPdfInput, "client" | "kind" | "periodLabel">) => `${input.client} · ${input.kind === "weekly" ? "Weekly report" : input.kind === "built" ? "Report" : "Monthly recap"} · ${input.periodLabel}`;

/** A white label client's numbers with the agency out of every name the page shows (campaigns, ads, ad groups) and its links gone */
function scrubMetrics(m: ReportMetrics): ReportMetrics {
  return {
    ...m,
    campaigns: m.campaigns.map((c) => ({ ...c, name: scrubName(c.name) })),
    topAds: m.topAds.map((a) => ({ ...a, name: scrubName(a.name), campaign: a.campaign ? scrubName(a.campaign) : a.campaign, link: clean(a.link) })),
    ...(m.googleUnits ? { googleUnits: m.googleUnits.map((u) => ({ ...u, name: scrubName(u.name), campaign: scrubName(u.campaign), headline: u.headline ? scrubAgency(u.headline) : u.headline })) } : {}),
  };
}

/** The whole document. images: each part's ad pictures as data URIs (null where none could be fetched) */
export function ReportDocument({ input: given, images }: { input: ReportPdfInput; images: (string | null)[][] }) {
  // White label: every written line and name cleaned of the agency too (whatever the AI, the buyer or the ad account
  // says), and no portal links
  const input: ReportPdfInput = given.whiteLabel
    ? {
        ...given,
        dashboard: null,
        brand: given.brand ? { ...given.brand, agencyLogo: null } : given.brand,
        shots: given.shots ? { ...given.shots, url: clean(given.shots.url), items: given.shots.items.map(scrubAgency) } : given.shots,
        parts: given.parts.map((p) => ({
          ...p,
          buyer: null,
          metrics: scrubMetrics(p.metrics),
          extra: p.extra?.map(scrubMetrics) ?? p.extra,
          layout: p.layout?.campaigns?.hide ? { ...p.layout, campaigns: { ...p.layout.campaigns, hide: p.layout.campaigns.hide.map(scrubName) } } : p.layout,
          sections: scrubSections(p.sections),
          extras: p.extras ? scrubAgency(p.extras) : p.extras,
        })),
      }
    : given;
  // The file's own properties too: a white label report names no agency there either
  const by = input.whiteLabel ? input.client : AGENCY;
  return (
    <Document title={documentTitle(input)} author={by} creator={by} producer={by}>
      <WeeklyReport input={input} images={images} />
    </Document>
  );
}
