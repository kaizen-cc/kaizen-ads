// Is this turn a sales ask? (plain module: no server imports; shared by the assistant's turn and the tests)
// The owner's rule (Nov 24 2026): when an exec or line head talks to their assistant, in chat or on a call, about new
// business (researching a business, a prospect, a pitch, a discovery call), the Sales agent is brought in at once, the
// way strategy questions go straight to the line's specialist. This reads the ask's intent, not single keywords:
//   1. the kind of ask (research / look at a site / pitch / what Kaizen would do / find businesses like / go after /
//      sales strategy / review a sales or discovery call / follow up after one), each a verb + object shape;
//   2. who it's about: a website or domain that isn't a current client's is a prospect; a current client (named, or
//      their site) stays with the line specialists unless the ask is upsell or new business;
//   3. who's asking: only those who may use Sales (worksSales: execs and leads); everyone else gets the assistant.

export type SalesClient = { name: string; website?: string | null };
export type SalesIntent = { sales: boolean; why: string | null; about: string | null };

const NO: SalesIntent = { sales: false, why: null, about: null };

/** Domains in the text ("glowmedspa.com", "https://www.example.co/x"), lower-case, without www */
export function domainsIn(text: string): string[] {
  const out = new Set<string>();
  const re = /\b(?:https?:\/\/)?(?:www\.)?((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|co|io|us|biz|info|ai|app|shop|store|agency|health|clinic|dental|law|realty|restaurant|spa|salon|fitness|studio|design|media|marketing|online|site|xyz|ca|uk|au|mx|es|de|fr|it|nl|me|tv|club|life|care|pro|world|group|tech|solutions|services|company|homes|auto|vegas|nyc|miami|la)(?:\.[a-z]{2})?)\b(?![@\w])/gi;
  for (const m of text.matchAll(re)) {
    const before = text.slice(Math.max(0, (m.index ?? 0) - 1), m.index ?? 0);
    if (before === "@") continue; // an email address
    out.add(m[1].toLowerCase());
  }
  return [...out];
}

const hostOf = (site: string | null | undefined) => {
  const s = String(site ?? "").trim().toLowerCase();
  if (!s) return null;
  return s.replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0] || null;
};
const key = (s: string) => s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");

/** The current client a text names (by name or their site), or null */
export function clientIn(text: string, clients: readonly SalesClient[]): SalesClient | null {
  const hosts = domainsIn(text);
  const flat = key(text);
  for (const c of clients) {
    const h = hostOf(c.website);
    if (h && hosts.some((d) => d === h || d.endsWith(`.${h}`) || h.endsWith(`.${d}`))) return c;
  }
  for (const c of clients) {
    const k = key(c.name);
    // Whole-name match only for names long enough not to be a common word ("Glow" alone doesn't count)
    if (k.length >= 6 && flat.includes(k)) return c;
  }
  return null;
}

// Upsell or new business with a current client: still the Sales agent's
const UPSELL = /\b(?:upsell|up-sell|cross[- ]?sell|sell (?:them|him|her) (?:on|more)|add(?:-| )?on services?|expand (?:the|their) (?:account|scope|retainer)|new business|more services|pitch (?:them|him|her) (?:on|email|social|google|meta|seo|a)|grow the account)\b/i;

// The kinds of sales ask, each a shape of verb + object (not a single word)
const INTENTS: { why: string; re: RegExp }[] = [
  { why: "research a business", re: /\b(?:research|look into|dig into|find out about|tell me about|look up|check out|vet|profile|analy[sz]e|audit)\b[^.?!]{0,30}\b(?:this|that|the|a|these|those)?\s*(?:business(?:es)?|company|companies|brand|shop|store|practice|clinic|spa|restaurant|agency|account)\b/i },
  { why: "look at a prospect's website", re: /\b(?:scrub|scrape|crawl|look at|go through|review|check|read|audit|tear down|analy[sz]e)\b[^.?!]{0,25}\b(?:their|this|that|the|his|her)\s+(?:web ?site|site|landing page|online presence|socials?|instagram|ads?)\b/i },
  { why: "a prospect", re: /\b(?:prospects?|prospecting|potential (?:client|customer|account|lead)s?|possible (?:client|account)s?|lead lists?|new leads? for (?:us|kaizen)|warm leads?|cold (?:outreach|email|call(?:ing)?|lead))\b/i },
  { why: "how to pitch", re: /\b(?:how (?:would|should|do|can|could) (?:we|i|you) (?:pitch|sell|approach|win|land|close|reach out to|position (?:kaizen|us|ourselves) (?:to|for|with))|pitch(?:ing)? (?:them|him|her|this|that|kaizen|our services|to)|(?:a|the|our) pitch (?:for|to)|sales (?:pitch|script|deck|email|strategy|plan|angle|approach)s?|outreach (?:email|message|script|plan)s?|linkedin (?:message|note|outreach|dm))\b/i },
  { why: "what Kaizen would do for them", re: /\bwhat (?:would|could|can|should) (?:kaizen|we|you|our team) (?:do|offer|sell|bring|fix|run|propose) (?:for|to)\b/i },
  { why: "find businesses like", re: /\b(?:find|get|build|pull|make|give)\b[^.?!]{0,20}\b(?:me |us )?(?:a (?:list of |few |couple )?|some |more |\d+ )?(?:businesses|companies|brands|clinics|spas|med ?spas|restaurants|practices|shops|stores|dentists|contractors|roofers|gyms|salons|agencies)\b[^.?!]{0,40}\b(?:like|similar to|in|near|around|that|who|running|with(?:out)?)\b/i },
  { why: "go after an account", re: /\b(?:go after|go for|win|land|sign|chase|court|approach|reach out to)\b[^.?!]{0,25}\b(?:this|that|the|their|them)?\s*(?:account|business|company|brand|deal|client|lead)\b/i },
  { why: "a sales call", re: /\b(?:sales|discovery|intro|introductory|pitch|prospect|qualifying) (?:call|meeting|chat|convo|conversation)s?\b/i },
  { why: "sign them as a client", re: /\b(?:sign (?:them|him|her) (?:up|on)|turn (?:them|this) into a client|become a client|win (?:them|this) over|close (?:them|the deal|this deal))\b/i },
];

// Asks that are the assistant's own even if a sales word appears ("remind me to call the prospect at 3")
const ASSISTANT_OWN = /\b(?:remind me|set a reminder|put (?:it|that) on my (?:calendar|list)|what'?s on my (?:calendar|day|plate)|open (?:the|my) (?:sales|prospects?) (?:page|pipeline|screen))\b/i;

/**
 * Whether a turn is a sales ask for this person, and why. `clients` are the current (non-archived) clients, to tell a
 * prospect from an account we already run; pass null when they weren't loaded (then a bare client-looking URL isn't
 * treated as a prospect).
 */
export function salesIntent(text: string, me: { isExec?: boolean | null; isLead?: boolean | null } | null | undefined, clients: readonly SalesClient[] | null, opts: { onClient?: boolean } = {}): SalesIntent {
  if (!me || !(me.isExec || me.isLead)) return NO;
  const t = text.trim();
  if (!t || ASSISTANT_OWN.test(t)) return NO;
  const client = clients ? clientIn(t, clients) : null;
  const upsell = UPSELL.test(t);
  const hit = INTENTS.find((i) => i.re.test(t));
  // A current client: the line specialists' unless it's upsell or new business
  if (client && !upsell) return NO;
  if (client && upsell) return { sales: true, why: "upsell or new business with a current client", about: client.name };
  // On a client's page, "research this business" or "go after the account" is about that client (the line's), unless
  // the ask names someone else (a domain that isn't theirs) or says prospect / sales call outright
  if (hit && opts.onClient && !domainsIn(t).length && !/^(?:a prospect|how to pitch|a sales call|find businesses like)$/.test(hit.why)) return NO;
  if (hit) return { sales: true, why: hit.why, about: domainsIn(t)[0] ?? null };
  // A website or domain that isn't a current client's, with an ask about it (a bare link pasted is an ask too)
  const domains = domainsIn(t).filter((d) => !/(?:google|facebook|instagram|linkedin|youtube|tiktok|slack|asana|klaviyo|shopify|figma|loom|notion|canva|kaizenmarketing)\./i.test(d));
  if (domains.length && clients) {
    const bare = t.replace(/https?:\/\/\S+/g, "").replace(/\b\S+\.\S+\b/g, "").trim().length < 4;
    const asks = /\b(?:what do you (?:think|see|make of)|thoughts|take a look|look at|check|review|research|this (?:one|guy|place|brand|company|business)|could we|can we|would they|help them|worth (?:it|going after|a call)|good fit|fit for (?:us|kaizen))\b|\?/i.test(t);
    if (bare || asks) return { sales: true, why: "a business that isn't a client yet", about: domains[0] };
  }
  return NO;
}

/** A cheap first look (no client list needed): could this be a sales ask at all? */
export const maybeSales = (text: string) => INTENTS.some((i) => i.re.test(text)) || UPSELL.test(text) || domainsIn(text).length > 0;
