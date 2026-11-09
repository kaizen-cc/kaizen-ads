// The brief as the maker reads it: precise on WHAT and WHY, and leaving the HOW to them (the lead video editor's
// feedback, Nov 2026, agreed by the owner). Insight, angle, hook, key message, cleared proof, constraints, assets (each
// with its status), the KPI and what success looks like, then a short "Your call" that hands style, pacing, music and
// edit structure to the editor or designer. A beat-by-beat script only when the request asked for one; a carousel's
// slides as messages, not designs. Anything only the client can tell us sits in "Confirm with client" until answered.
//
// The brief stays text everywhere it travels (tickets, Asana, the PDF), written with fixed headings, so this module
// renders a spec to that text and reads it back. Pure: safe in the browser and on the server, tested in
// tests/brief-spec.test.ts.

export type AssetStatus = "have" | "need" | "shoot" | "missing";
export type SpecAsset = { item: string; status: AssetStatus };
/** A fact only the client knows (the reveal, the tip, the stat, the offer's terms, the date): never invented */
export type ClientFact = { question: string; answer: string; source: string };

export type BriefSpec = {
  /** The specific, true thing the ad says or shows */
  insight: string;
  /** Where the insight comes from (Brand Bible, a call, client memory), when it's from the context */
  insightSource: string;
  keyMessage: string;
  /** The opening line or visual idea, not a shot list */
  hook: string;
  /** Only claims the client cleared */
  proof: string[];
  /** A carousel's slides, as the message each one carries */
  slides: string[];
  /** Formats, legal and consent, safe zones, platform rules */
  constraints: string[];
  dos: string[];
  donts: string[];
  assets: SpecAsset[];
  kpi: string;
  success: string;
  /** What's left to the maker: style, pacing, music, edit structure */
  yourCall: string;
  /** Only when the request asked for a script */
  script: string;
  confirm: ClientFact[];
};

export const emptySpec = (): BriefSpec => ({ insight: "", insightSource: "", keyMessage: "", hook: "", proof: [], slides: [], constraints: [], dos: [], donts: [], assets: [], kpi: "", success: "", yourCall: "", script: "", confirm: [] });

/** What the maker decides, said the same way on every brief unless the writer narrows it */
export const YOUR_CALL_DEFAULT = "Style, pacing, music, edit structure and the exact beats are yours. Hit the insight, the hook and the constraints; everything else is your craft.";

export const ASSET_WORD: Record<AssetStatus, string> = { have: "Have", need: "Need", shoot: "Client to shoot", missing: "Missing" };

/** The headings the brief is written with, in order (the text a maker reads, and what's parsed back) */
export const SPEC_HEADINGS = ["Insight", "Key message", "Hook", "Proof", "Slides", "Constraints", "Do", "Don't", "Assets", "KPI", "Success looks like", "Your call", "Script", "Confirm with client"] as const;

const one = (s: string) => s.replace(/\s*\u2014\s*/g, ", ").replace(/\s+/g, " ").trim();
const list = (xs: string[]) => xs.map(one).filter(Boolean);

/** The confirm line: "Which seat, at which venue, and why? Answer: ... (Source: ...)" */
export function factLine(f: ClientFact) {
  const q = one(f.question);
  const a = one(f.answer);
  const s = one(f.source);
  return `${q}${a ? ` Answer: ${a}` : ""}${a && s ? ` (Source: ${s})` : ""}`;
}

export function parseFactLine(line: string): ClientFact {
  const t = line.replace(/^[-•*]\s+/, "").trim();
  const m = /^(.*?)(?:\s+Answer:\s*(.*?))?(?:\s+\(Source:\s*([^)]*)\))?\s*$/.exec(t);
  return { question: (m?.[1] ?? t).trim(), answer: (m?.[2] ?? "").trim(), source: (m?.[3] ?? "").trim() };
}

/** The spec as the brief's text, its sections in order, empty ones left out */
export function renderSpec(sp: BriefSpec): string {
  const blocks: string[] = [];
  const line = (h: string, v: string) => v.trim() && blocks.push(`${h}: ${one(v)}`);
  const bullets = (h: string, xs: string[]) => list(xs).length && blocks.push(`${h}:\n${list(xs).map((x) => `- ${x}`).join("\n")}`);
  line("Insight", sp.insight.trim() ? `${one(sp.insight)}${sp.insightSource.trim() ? ` (Source: ${one(sp.insightSource)})` : ""}` : "");
  line("Key message", sp.keyMessage);
  line("Hook", sp.hook);
  bullets("Proof", sp.proof);
  if (list(sp.slides).length) blocks.push(`Slides:\n${list(sp.slides).map((x, i) => `${i + 1}. ${x}`).join("\n")}`);
  bullets("Constraints", sp.constraints);
  bullets("Do", sp.dos);
  bullets("Don't", sp.donts);
  const assets = sp.assets.filter((a) => one(a.item));
  if (assets.length) blocks.push(`Assets:\n${assets.map((a) => `- ${ASSET_WORD[a.status]}: ${one(a.item)}`).join("\n")}`);
  line("KPI", sp.kpi);
  line("Success looks like", sp.success);
  line("Your call", sp.yourCall);
  if (sp.script.trim()) blocks.push(`Script:\n${sp.script.trim()}`);
  const facts = sp.confirm.filter((f) => one(f.question));
  if (facts.length) blocks.push(`Confirm with client:\n${facts.map((f) => `- ${factLine(f)}`).join("\n")}`);
  return blocks.join("\n\n");
}

const HEAD_KEY: Record<string, (typeof SPEC_HEADINGS)[number]> = Object.fromEntries(SPEC_HEADINGS.map((h) => [h.toLowerCase(), h]));
// Older spellings read the same way
HEAD_KEY["dos"] = "Do";
HEAD_KEY["don'ts"] = "Don't";
HEAD_KEY["donts"] = "Don't";
HEAD_KEY["success"] = "Success looks like";

const assetOf = (raw: string): SpecAsset => {
  const t = raw.replace(/^[-•*]\s+/, "").trim();
  const m = /^(Have|Need|Client to shoot|Shoot|Missing):\s*(.+)$/i.exec(t);
  if (!m) return { item: t, status: /\bmissing\b/i.test(t) ? "missing" : "have" };
  const w = m[1].toLowerCase();
  return { item: m[2].trim(), status: w === "have" ? "have" : w === "need" ? "need" : w === "missing" ? "missing" : "shoot" };
};

/**
 * The brief's text read back into its parts: overview (the lines before the first heading, and anything under a
 * heading this doesn't know) and the spec. structured: it had at least the insight, hook or "Your call" heading.
 */
export function parseBrief(text: string): { overview: string; spec: BriefSpec; structured: boolean } {
  const sp = emptySpec();
  const rest: string[] = [];
  let head: (typeof SPEC_HEADINGS)[number] | null = null;
  const script: string[] = [];
  let seen = 0;
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const t = raw.trim();
    const h = /^([A-Z][A-Za-z' ]{1,30}):\s*(.*)$/.exec(t);
    const key = h ? HEAD_KEY[h[1].toLowerCase()] : undefined;
    if (h && key) {
      head = key;
      seen++;
      const v = h[2].trim();
      if (v) take(key, v, true);
      continue;
    }
    if (!t) {
      // A script keeps its blank lines; any other section ends at one
      if (head === "Script") script.push("");
      else {
        rest.push("");
        head = null;
      }
      continue;
    }
    if (head) take(head, t, false);
    else {
      // A heading this module doesn't know ("Concepts:", "Hooks to try:") stays with the overview, under its heading
      rest.push(raw.replace(/\s+$/, ""));
    }
  }
  function take(key: (typeof SPEC_HEADINGS)[number], v: string, inline: boolean) {
    const item = v.replace(/^[-•*]\s+/, "").replace(/^\d+[.)]\s+/, "").trim();
    switch (key) {
      case "Insight": {
        const m = /^(.*?)\s*\(Source:\s*([^)]*)\)\s*$/.exec(v);
        sp.insight = [sp.insight, m ? m[1] : v].filter(Boolean).join(" ");
        if (m) sp.insightSource = m[2].trim();
        return;
      }
      case "Key message":
        sp.keyMessage = [sp.keyMessage, v].filter(Boolean).join(" ");
        return;
      case "Hook":
        sp.hook = [sp.hook, v].filter(Boolean).join(" ");
        return;
      case "KPI":
        sp.kpi = [sp.kpi, v].filter(Boolean).join(" ");
        return;
      case "Success looks like":
        sp.success = [sp.success, v].filter(Boolean).join(" ");
        return;
      case "Your call":
        sp.yourCall = [sp.yourCall, v].filter(Boolean).join(" ");
        return;
      case "Script":
        script.push(inline ? v.trim() : v);
        return;
      case "Proof":
        sp.proof.push(item);
        return;
      case "Slides":
        sp.slides.push(item);
        return;
      case "Constraints":
        sp.constraints.push(item);
        return;
      case "Do":
        sp.dos.push(item);
        return;
      case "Don't":
        sp.donts.push(item);
        return;
      case "Assets":
        sp.assets.push(assetOf(v));
        return;
      case "Confirm with client":
        sp.confirm.push(parseFactLine(v));
        return;
    }
  }
  sp.script = script.join("\n").trim();
  const overview = rest.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const structured = Boolean(sp.insight || sp.hook || sp.yourCall) && seen >= 2;
  return { overview, spec: sp, structured };
}

/** A writer's spec made safe to keep: trimmed, capped, no em dashes, "Your call" always said */
export function cleanSpec(raw: Partial<BriefSpec> | null | undefined): BriefSpec {
  const t = (s: unknown, max = 600) => (typeof s === "string" ? one(s).slice(0, max) : "");
  const xs = (v: unknown, n = 8, max = 300) => (Array.isArray(v) ? v.map((x) => t(x, max)).filter(Boolean).slice(0, n) : []);
  const statuses = ["have", "need", "shoot", "missing"];
  return {
    insight: t(raw?.insight, 700),
    insightSource: t(raw?.insightSource, 160),
    keyMessage: t(raw?.keyMessage, 300),
    hook: t(raw?.hook, 300),
    proof: xs(raw?.proof, 6),
    slides: xs(raw?.slides, 10, 240),
    constraints: xs(raw?.constraints, 10),
    dos: xs(raw?.dos, 8, 200),
    donts: xs(raw?.donts, 8, 200),
    assets: (Array.isArray(raw?.assets) ? raw.assets : [])
      .map((a) => ({ item: t(a?.item, 300), status: (statuses.includes(a?.status as string) ? a.status : "need") as AssetStatus }))
      .filter((a) => a.item)
      .slice(0, 10),
    kpi: t(raw?.kpi, 200),
    success: t(raw?.success, 300),
    yourCall: t(raw?.yourCall, 400) || YOUR_CALL_DEFAULT,
    script: typeof raw?.script === "string" ? raw.script.replace(/\s*\u2014\s*/g, ", ").trim().slice(0, 4000) : "",
    confirm: (Array.isArray(raw?.confirm) ? raw.confirm : [])
      .map((c) => ({ question: t(c?.question, 300), answer: t(c?.answer, 600), source: t(c?.source, 120) }))
      .filter((c) => c.question)
      .slice(0, 6),
  };
}

/** The brief's text from its overview and spec: overview first, then the spec's sections */
export function composeBrief(overview: string, sp: BriefSpec) {
  return [overview.trim(), renderSpec(sp)].filter(Boolean).join("\n\n");
}

/**
 * A writer's brief with its spec folded in, idempotent: any spec sections already in the brief are replaced by the
 * spec's (so a draft cleaned twice never doubles them).
 */
export function withSpec(brief: string, sp: BriefSpec | null | undefined) {
  if (!sp) return brief;
  return composeBrief(parseBrief(brief).overview, sp);
}

/** The JSON shape the brief writers fill (inside draft.spec) */
export const SPEC_SCHEMA = {
  type: "object",
  properties: {
    insight: { type: "string" },
    insightSource: { type: "string" },
    keyMessage: { type: "string" },
    hook: { type: "string" },
    proof: { type: "array", items: { type: "string" } },
    slides: { type: "array", items: { type: "string" } },
    constraints: { type: "array", items: { type: "string" } },
    dos: { type: "array", items: { type: "string" } },
    donts: { type: "array", items: { type: "string" } },
    assets: {
      type: "array",
      items: { type: "object", properties: { item: { type: "string" }, status: { type: "string", enum: ["have", "need", "shoot", "missing"] } }, required: ["item", "status"], additionalProperties: false },
    },
    kpi: { type: "string" },
    success: { type: "string" },
    yourCall: { type: "string" },
    script: { type: "string" },
    confirm: {
      type: "array",
      items: { type: "object", properties: { question: { type: "string" }, answer: { type: "string" }, source: { type: "string" } }, required: ["question", "answer", "source"], additionalProperties: false },
    },
  },
  required: ["insight", "insightSource", "keyMessage", "hook", "proof", "slides", "constraints", "dos", "donts", "assets", "kpi", "success", "yourCall", "script", "confirm"],
  additionalProperties: false,
} as const;

/** How the writers fill the spec: the same words for every writer (roles, never names; no em dashes) */
export const SPEC_RULE = `THE BRIEF'S SHAPE (precise on WHAT and WHY; the HOW belongs to the editor or designer):
- brief: two to four plain lines, the idea in words a maker gets in ten seconds. Everything else goes in spec.
- spec.insight: the specific, true thing the ad says or shows (the reveal, the tip, the fact). Say exactly which one. spec.insightSource: where it comes from in the context (Brand Bible, client memory, a call and its date, the intake, a document), "" when it isn't in the context.
- spec.keyMessage: the one thing people should take away. spec.hook: the opening line or visual idea, not a shot list.
- spec.proof: only claims the client cleared (in the Brand Bible, client memory or a document they sent). Nothing else.
- spec.constraints: sizes 4:5 and 9:16 only (never 1:1, never one size alone unless the request says so), safe zones, legal and consent (people on camera, testimonials, music rights), platform limits. Every constraint must agree with every other line: no logo rule against a hook that shows the logo, no "evergreen" rule against event footage, no size rule against the file names.
- spec.dos and spec.donts: the client's rules that matter here, each short.
- spec.slides: a carousel's slides as the message each one carries (not how it looks); [] otherwise.
- spec.assets: each asset with its status: have (on Drive, say which folder), need (we must get it), shoot (the client has to film or photograph it), missing (a link we were given doesn't open). Never write a placeholder like MISSING or TBD in place of a link.
- spec.kpi: the metric this is judged on (from the client's KPIs); spec.success: what a win looks like in numbers or behaviour.
- spec.yourCall: one or two lines handing style, pacing, music, edit structure and exact beats to the maker. Never direct those yourself.
- spec.script: "" unless the request explicitly asked for a script or voiceover text.
- spec.confirm: every fact the concept depends on that only the client knows (which seat or spot, the tip, the stat, the offer's terms, a date) and that the context doesn't answer: the question to ask them, short and specific ("Which seat, at which venue, and why?"), answer "". When the context does answer it, use it, put it in answer and name the source. NEVER invent such a fact: an ad that promises a reveal without the reveal is not ready, and saying so is the right answer.`;
