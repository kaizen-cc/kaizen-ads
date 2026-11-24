// The Sales agent's plain helpers (no server imports, so screens and tests can use them): who works sales, the
// prospect stages, website and name clean-up, and the prospect brief as text.

export const PROSPECT_STATUSES = ["new", "researched", "contacted", "talking", "proposal", "won", "lost"] as const;
export type ProspectStatus = (typeof PROSPECT_STATUSES)[number];

export const STATUS_LABEL: Record<ProspectStatus, string> = {
  new: "New",
  researched: "Researched",
  contacted: "Contacted",
  talking: "Talking",
  proposal: "Proposal",
  won: "Won",
  lost: "Lost",
};

export const isProspectStatus = (v: unknown): v is ProspectStatus => typeof v === "string" && (PROSPECT_STATUSES as readonly string[]).includes(v);

/** The open stages (still being worked), in pipeline order */
export const OPEN_STATUSES: readonly ProspectStatus[] = ["new", "researched", "contacted", "talking", "proposal"];

/** Sales is internal for now: the executives and the leads (line heads) only */
export const worksSales = (me: { isExec?: boolean | null; isLead?: boolean | null } | null | undefined) => Boolean(me && (me.isExec || me.isLead));

/** A website as one canonical form ("https://example.com"), or null when it isn't a site */
export function cleanSite(v: unknown): string | null {
  const raw = String(v ?? "").trim();
  if (!raw) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!u.hostname.includes(".") || /\s/.test(u.hostname)) return null;
    return `https://${u.hostname.replace(/^www\./i, "").toLowerCase()}`;
  } catch {
    return null;
  }
}

/** The host of a site, for matching ("example.com") */
export const siteHost = (v: unknown) => cleanSite(v)?.replace(/^https:\/\//, "") ?? null;

/** A name for matching a prospect to a client: letters and digits only */
export const nameKey = (s: string) => s.toLowerCase().replace(/&/g, "and").replace(/\b(llc|inc|co|corp|ltd|the)\b/g, "").replace(/[^a-z0-9]/g, "");

/** Whether a client is the won prospect: the same site, or the same name (loosely) */
export function sameBusiness(p: { name: string; website?: string | null }, c: { name: string; website?: string | null }) {
  const a = siteHost(p.website);
  const b = siteHost(c.website);
  if (a && b) return a === b;
  const x = nameKey(p.name);
  const y = nameKey(c.name);
  return x.length >= 4 && (x === y || (Math.min(x.length, y.length) >= 6 && (x.includes(y) || y.includes(x))));
}

/** A fit score kept in 0..100, or null */
export function clampScore(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
}

export const fitBand = (s: number | null | undefined) => (s == null ? "unscored" : s >= 75 ? "strong" : s >= 50 ? "possible" : "weak");

export type ProspectBrief = {
  summary: string;
  sells: string;
  locations: string[];
  positioning: string;
  marketing: {
    site: string;
    offers: string;
    reviews: string;
    social: string;
    meta_ads: string;
    google_ads: string;
    email_capture: string;
  };
  gaps: string[];
  fit_score: number | null;
  fit_reason: string;
  strategy: {
    services: { service: string; why: string; price: string }[];
    angle: string;
    proof: string[];
    talking_points: string[];
  };
  contacts: { name: string; role: string; where: string }[];
  sources: string[];
};

const s = (v: unknown, n = 2000) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const list = (v: unknown, n = 12, len = 600) => (Array.isArray(v) ? v.map((x) => s(x, len)).filter(Boolean).slice(0, n) : []);

/** The brief as the model returned it, made safe to keep and show */
export function cleanBrief(raw: unknown): ProspectBrief {
  const r = (raw ?? {}) as Record<string, unknown>;
  const m = (r.marketing ?? {}) as Record<string, unknown>;
  const st = (r.strategy ?? {}) as Record<string, unknown>;
  return {
    summary: s(r.summary, 1200),
    sells: s(r.sells, 1200),
    locations: list(r.locations, 20, 200),
    positioning: s(r.positioning, 1200),
    marketing: { site: s(m.site, 800), offers: s(m.offers, 800), reviews: s(m.reviews, 800), social: s(m.social, 800), meta_ads: s(m.meta_ads, 800), google_ads: s(m.google_ads, 800), email_capture: s(m.email_capture, 800) },
    gaps: list(r.gaps),
    fit_score: clampScore(r.fit_score),
    fit_reason: s(r.fit_reason, 800),
    strategy: {
      services: (Array.isArray(st.services) ? st.services : []).slice(0, 8).map((x) => {
        const o = (x ?? {}) as Record<string, unknown>;
        return { service: s(o.service, 120), why: s(o.why, 500), price: s(o.price, 200) };
      }).filter((x) => x.service),
      angle: s(st.angle, 1000),
      proof: list(st.proof, 6),
      talking_points: list(st.talking_points, 8),
    },
    contacts: (Array.isArray(r.contacts) ? r.contacts : []).slice(0, 10).map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      return { name: s(o.name, 120), role: s(o.role, 120), where: s(o.where, 300) };
    }).filter((x) => x.name),
    sources: list(r.sources, 20, 400),
  };
}

/** The brief as plain text (for the assistant to read out, and the agents' context) */
export function briefText(name: string, b: ProspectBrief): string {
  const out = [`${name}: ${b.summary}`];
  if (b.sells) out.push(`Sells: ${b.sells}`);
  if (b.locations.length) out.push(`Locations: ${b.locations.join("; ")}`);
  if (b.positioning) out.push(`Positioning: ${b.positioning}`);
  const m = b.marketing;
  const mk = ([["Site", m.site], ["Offers", m.offers], ["Reviews", m.reviews], ["Social", m.social], ["Meta ads", m.meta_ads], ["Google ads", m.google_ads], ["Email capture", m.email_capture]] as const).filter(([, v]) => v);
  if (mk.length) out.push(`Marketing:\n${mk.map(([k, v]) => `- ${k}: ${v}`).join("\n")}`);
  if (b.gaps.length) out.push(`Gaps:\n${b.gaps.map((g) => `- ${g}`).join("\n")}`);
  if (b.fit_score != null) out.push(`Fit: ${b.fit_score}/100 (${fitBand(b.fit_score)})${b.fit_reason ? `: ${b.fit_reason}` : ""}`);
  const st = b.strategy;
  if (st.services.length) out.push(`Services that fit:\n${st.services.map((x) => `- ${x.service}${x.price ? ` (${x.price})` : ""}: ${x.why}`).join("\n")}`);
  if (st.angle) out.push(`Angle: ${st.angle}`);
  if (st.proof.length) out.push(`Proof (internal):\n${st.proof.map((p) => `- ${p}`).join("\n")}`);
  if (st.talking_points.length) out.push(`Talking points:\n${st.talking_points.map((p) => `- ${p}`).join("\n")}`);
  if (b.contacts.length) out.push(`Contacts found: ${b.contacts.map((c) => `${c.name}${c.role ? ` (${c.role})` : ""}${c.where ? `, ${c.where}` : ""}`).join("; ")}`);
  return out.join("\n\n");
}

export type PitchDrafts = {
  call_script: { opener: string; questions: string[]; angle: string; ask: string; objections: { objection: string; answer: string }[] };
  email: { subject: string; body: string };
  linkedin: { connection_note: string; message: string };
};

export function cleanPitch(raw: unknown): PitchDrafts {
  const r = (raw ?? {}) as Record<string, unknown>;
  const c = (r.call_script ?? {}) as Record<string, unknown>;
  const e = (r.email ?? {}) as Record<string, unknown>;
  const l = (r.linkedin ?? {}) as Record<string, unknown>;
  return {
    call_script: {
      opener: s(c.opener, 800),
      questions: list(c.questions, 5, 300),
      angle: s(c.angle, 800),
      ask: s(c.ask, 400),
      objections: (Array.isArray(c.objections) ? c.objections : []).slice(0, 6).map((x) => {
        const o = (x ?? {}) as Record<string, unknown>;
        return { objection: s(o.objection, 300), answer: s(o.answer, 600) };
      }).filter((x) => x.objection),
    },
    email: { subject: s(e.subject, 160), body: String(e.body ?? "").trim().slice(0, 3000) },
    // LinkedIn's connection note is capped at 300 characters
    linkedin: { connection_note: s(l.connection_note, 300), message: String(l.message ?? "").trim().slice(0, 2000) },
  };
}

export type CallReview = {
  summary: string;
  went_well: string[];
  improve: string[];
  objections: { objection: string; how_handled: string; better_answer: string }[];
  next_steps: { step: string; who: string; when: string }[];
  proposal: { send: boolean; services: string[]; note: string };
  stage: ProspectStatus | null;
};

export function cleanReview(raw: unknown): CallReview {
  const r = (raw ?? {}) as Record<string, unknown>;
  const p = (r.proposal ?? {}) as Record<string, unknown>;
  return {
    summary: s(r.summary, 1500),
    went_well: list(r.went_well, 8),
    improve: list(r.improve, 8),
    objections: (Array.isArray(r.objections) ? r.objections : []).slice(0, 8).map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      return { objection: s(o.objection, 400), how_handled: s(o.how_handled, 600), better_answer: s(o.better_answer, 800) };
    }).filter((x) => x.objection),
    next_steps: (Array.isArray(r.next_steps) ? r.next_steps : []).slice(0, 8).map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      return { step: s(o.step, 400), who: s(o.who, 120), when: s(o.when, 120) };
    }).filter((x) => x.step),
    proposal: { send: p.send === true, services: list(p.services, 8, 200), note: s(p.note, 800) },
    stage: isProspectStatus(r.stage) ? r.stage : null,
  };
}

/** A stage only moves forward on its own (research never pulls a "talking" prospect back to "researched") */
export function forwardStatus(current: ProspectStatus, next: ProspectStatus): ProspectStatus {
  if (current === "won" || current === "lost") return current;
  if (next === "won" || next === "lost") return next;
  return PROSPECT_STATUSES.indexOf(next) > PROSPECT_STATUSES.indexOf(current) ? next : current;
}

/** The Drive folder name of a prospect (Kaizen Sales › Prospects › <name>) */
export const prospectFolderName = (name: string) => name.replace(/[\\/:*?"<>|›]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
