// White label clients (Team & setup › Details › Type: "White label"): an agency partner's client. Their reports go out
// generic, with no agency name or brand anywhere (the PDF, its file name, the Slack message, the email), so the partner
// can export them and use them in their own reports. Plain functions (no server code), shared by the senders, the
// writers and the tests.

/** The client's type as stored (clients.client_type); "whitelabel" is the white label option */
export const isWhiteLabel = (clientType: string | null | undefined) => {
  const t = String(clientType ?? "").toLowerCase().replace(/[\s_-]/g, "");
  return t === "whitelabel";
};

/** What the writing AI is told for a white label client: nothing of the agency, ever */
export const WHITE_LABEL_RULE =
  "This client is white label: the report goes to an agency partner who passes it on as their own. Never write the agency's name (Kaizen, Kaizen Marketing, Kaizen Ads) or any link to its website or portal, and don't sign off with a company name. Say \"we\" or \"our team\" instead. Don't suggest any other service, channel or product.";

/** The signature and from-name used where the agency's name would go */
export const WHITE_LABEL_FROM = "Performance Report";

/**
 * The backstop on any text that goes to a white label client: every mention of the agency becomes "our team" (or goes),
 * and every link to its website or portal is taken out, with the line tidied after.
 */
export function scrubAgency(text: string): string {
  return (
    text
      // Slack links to the agency's site: <https://ads.kaizenmarketing.agency/...|label>
      .replace(/<https?:\/\/[^|>\s]*kaizen[^|>\s]*(\|[^>]*)?>/gi, "")
      // Bare links to it
      .replace(/https?:\/\/[^\s<>)]*kaizen[^\s<>)]*/gi, "")
      .replace(/\b[\w.-]*kaizenmarketing\.agency\b[^\s<>)]*/gi, "")
      // "Kaizen" in every form, possessive first
      .replace(/\bthe Kaizen( Marketing| Ads)? team\b/gi, "our team")
      .replace(/\bKaizen( Marketing| Ads)?'s\b/gi, "our")
      .replace(/\b(here )?at Kaizen( Marketing| Ads)?\b/gi, (_m, here: string | undefined) => (here ? "here on our team" : "on our team"))
      // A sign-off: "Sam, Kaizen Marketing", or the company on a line of its own
      .replace(/,[ \t]*Kaizen( Marketing| Ads)?[ \t]*$/gim, "")
      .replace(/^[ \t]*(the )?Kaizen( Marketing| Ads)?( team)?[ \t]*$/gim, "")
      .replace(/\bKaizen( Marketing| Ads)?\b/gi, "our team")
      .replace(/kaizen/gi, "")
      // Tidy what the removals left: a dangling colon or "here:", doubled spaces, empty lines piling up
      .replace(/[ \t]+([.,;!?])/g, "$1")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/[ \t]+$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/**
 * A campaign, ad set or ad name with the agency taken out ("PMax | Colossal Shrimp Offer | Kaizen" → "PMax | Colossal
 * Shrimp Offer"): the segment that's only the agency goes, any other mention is dropped from its segment.
 */
export function scrubName(name: string): string {
  if (!/kaizen|\bkzn\b/i.test(name)) return name;
  const out = name
    .split("|")
    .map((x) => x.trim())
    .filter((x) => x && !/^(kaizen( marketing| ads)?|kzn)$/i.test(x))
    .map((x) => x.replace(/\bkaizen( marketing| ads)?\b/gi, "").replace(/\bkzn\b/gi, "").replace(/kaizen/gi, "").replace(/\s{2,}/g, " ").trim())
    .filter(Boolean)
    .join(" | ");
  return out || "Campaign";
}

/** Scrubbed only when the client is white label; anyone else's text as it was */
export const forClient = (text: string, whiteLabel: boolean | null | undefined) => (whiteLabel ? scrubAgency(text) : text);

type Words = { headline: string; summary: string; did: string[]; doing: string[]; next: string[]; highlights: string[]; stories?: { title: string; see: string; why: string; next: string }[]; takeaways?: { title: string; text: string }[] };

/** A report's written sections with the agency taken out of every line (the backstop for the PDF and the report page) */
export function scrubSections<T extends Words>(s: T): T {
  const one = (t: string) => (typeof t === "string" ? scrubAgency(t) : t);
  const list = (xs: string[]) => (Array.isArray(xs) ? xs.map(one) : xs);
  return {
    ...s,
    headline: one(s.headline),
    summary: one(s.summary),
    did: list(s.did),
    doing: list(s.doing),
    next: list(s.next),
    highlights: list(s.highlights),
    ...(s.stories ? { stories: s.stories.map((st) => ({ ...st, title: one(st.title), see: one(st.see), why: one(st.why), next: one(st.next) })) } : {}),
    ...(s.takeaways ? { takeaways: s.takeaways.map((t) => ({ title: one(t.title), text: one(t.text) })) } : {}),
  };
}

const KIND: Record<string, string> = { weekly: "weekly", monthly: "monthly", custom: "performance", built: "performance" };

/** A white label report's file name: "<Client> [<Service>] <kind> report <period>.pdf", safe for every mail app */
export function whiteLabelFileName(client: string, kind: string, period: string, service?: string | null) {
  const name = [client, service?.replace(/ Ads$/, ""), `${KIND[kind] ?? "performance"} report`, period].filter(Boolean).join(" ");
  return `${scrubAgency(name)}.pdf`.replace(/[\\/:*?"<>|]/g, "-");
}
