import { ASSET_WORD, composeBrief, emptySpec, parseBrief, type AssetStatus, type BriefSpec } from "./brief-spec";

// The revise chat's edits, as data. Under a brief, the creative (or the lead) types a correction ("the seat is
// Section 112 at MSG, and it's because of the view of the bench"); the AI answers with a structured patch (set a field,
// add to a list, replace or remove an item) instead of a rewrite, so only what was asked changes, the person sees
// exactly what changed, and undo puts it back. Who may change what follows the brief permissions: the creative team,
// buyers and execs any field; the copywriter only the copy lines. Pure: tested in tests/brief-patch.test.ts.

/** The brief as one thing the chat edits: the request's own lines and the brief's spec */
export type BriefState = { title: string; angle: string; audience: string; sizes: string[]; overview: string; spec: BriefSpec };

export const TEXT_FIELDS = ["title", "angle", "audience", "overview", "insight", "insightSource", "keyMessage", "hook", "kpi", "success", "yourCall", "script"] as const;
export const LIST_FIELDS = ["proof", "slides", "constraints", "dos", "donts", "assets", "confirm", "sizes"] as const;
export type PatchField = (typeof TEXT_FIELDS)[number] | (typeof LIST_FIELDS)[number];
export type BriefChange = {
  field: PatchField;
  op: "set" | "add" | "replace" | "remove";
  /** The new text (a list item's text; for assets the item, for confirm the question) */
  value: string;
  /** A list item's position (0 first), -1 when not used */
  index: number;
  /** assets only: the item's status */
  status: AssetStatus | "";
  /** confirm only: the answer and where it came from */
  answer: string;
  source: string;
};

export const FIELD_LABEL: Record<PatchField, string> = {
  title: "Title",
  angle: "Angle",
  audience: "Audience",
  overview: "The idea",
  insight: "Insight",
  insightSource: "Insight source",
  keyMessage: "Key message",
  hook: "Hook",
  kpi: "KPI",
  success: "Success looks like",
  yourCall: "Your call",
  script: "Script",
  proof: "Proof",
  slides: "Slides",
  constraints: "Constraints",
  dos: "Do",
  donts: "Don't",
  assets: "Assets",
  confirm: "Confirm with client",
  sizes: "Sizes",
};

/** The lines a copywriter may correct (copy, never the brief's direction) */
export const COPY_FIELDS: PatchField[] = ["hook", "keyMessage"];

export const stateOf = (r: { title: string; angle: string; audience: string; sizes: string[]; brief: string }): BriefState => {
  const p = parseBrief(r.brief);
  return { title: r.title, angle: r.angle, audience: r.audience, sizes: [...r.sizes], overview: p.overview, spec: p.spec };
};
export const briefOf = (s: BriefState) => composeBrief(s.overview, s.spec);

const SIZES = ["4x5", "9x16"];
const FIELDS = [...TEXT_FIELDS, ...LIST_FIELDS] as const;
const OPS: string[] = ["set", "add", "replace", "remove"];
const clip = (s: string, n = 600) => s.replace(/\s*\u2014\s*/g, ", ").trim().slice(0, n);

function editList<T>(xs: T[], c: BriefChange, item: T | null): T[] {
  const at = c.index >= 0 && c.index < xs.length ? c.index : -1;
  switch (c.op) {
    case "set":
      return item === null ? [] : [item];
    case "add":
      return item === null ? xs : [...xs, item];
    case "replace":
      if (at < 0 || item === null) return xs;
      return xs.map((x, i) => (i === at ? item : x));
    case "remove":
      return at < 0 ? xs : xs.filter((_, i) => i !== at);
  }
}

/**
 * The changes applied in order. allowed: the fields this person may change (refused ones are returned, not applied).
 * A change that doesn't fit (a list index that isn't there, a size Kaizen doesn't make) is skipped as refused too.
 */
export function applyBriefPatch(s: BriefState, changes: BriefChange[], allowed?: readonly PatchField[] | null): { state: BriefState; applied: BriefChange[]; refused: BriefChange[] } {
  let next: BriefState = { ...s, sizes: [...s.sizes], spec: { ...s.spec } };
  const applied: BriefChange[] = [];
  const refused: BriefChange[] = [];
  for (const c of changes) {
    // The answer's strings checked here, not by the schema (no enums: the API refuses grammars that are too large)
    if (!(FIELDS as readonly string[]).includes(c.field) || !OPS.includes(c.op)) {
      refused.push(c);
      continue;
    }
    if (allowed && !allowed.includes(c.field)) {
      refused.push(c);
      continue;
    }
    const before = JSON.stringify(next);
    const value = clip(c.value ?? "", c.field === "script" ? 4000 : 600);
    if ((TEXT_FIELDS as readonly string[]).includes(c.field)) {
      const v = c.op === "remove" ? "" : value;
      if (c.field === "title" || c.field === "angle" || c.field === "audience" || c.field === "overview") next = { ...next, [c.field]: c.field === "title" ? v.slice(0, 120) : v };
      else next = { ...next, spec: { ...next.spec, [c.field]: v } };
    } else if (c.field === "sizes") {
      const k = value.replace(":", "x").toLowerCase();
      if (c.op !== "remove" && !SIZES.includes(k)) {
        refused.push(c);
        continue;
      }
      const sizes = c.op === "set" ? [k] : c.op === "add" ? [...new Set([...next.sizes, k])] : c.op === "remove" ? next.sizes.filter((x) => x !== (SIZES.includes(k) ? k : next.sizes[c.index])) : next.sizes;
      next = { ...next, sizes: SIZES.filter((x) => sizes.includes(x)) };
    } else if (c.field === "assets") {
      const status: AssetStatus = c.status && c.status in ASSET_WORD ? (c.status as AssetStatus) : "need";
      next = { ...next, spec: { ...next.spec, assets: editList(next.spec.assets, c, value ? { item: value, status } : c.op === "replace" && c.index >= 0 && next.spec.assets[c.index] ? { ...next.spec.assets[c.index], status } : null) } };
    } else if (c.field === "confirm") {
      const was = c.index >= 0 ? next.spec.confirm[c.index] : undefined;
      const item = value || was ? { question: value || was?.question || "", answer: clip(c.answer ?? "", 600), source: clip(c.source ?? "", 120) } : null;
      next = { ...next, spec: { ...next.spec, confirm: editList(next.spec.confirm, c, item) } };
    } else {
      const f = c.field as "proof" | "slides" | "constraints" | "dos" | "donts";
      next = { ...next, spec: { ...next.spec, [f]: editList(next.spec[f], c, value || null) } };
    }
    if (JSON.stringify(next) === before) refused.push(c);
    else applied.push(c);
  }
  return { state: next, applied, refused };
}

export type FieldDiff = { field: PatchField; label: string; before: string; after: string };

const show = (s: BriefState, f: PatchField): string => {
  switch (f) {
    case "title":
    case "angle":
    case "audience":
    case "overview":
      return s[f];
    case "sizes":
      return s.sizes.map((x) => x.replace("x", ":")).join(", ");
    case "assets":
      return s.spec.assets.map((a) => `${ASSET_WORD[a.status]}: ${a.item}`).join("\n");
    case "confirm":
      return s.spec.confirm.map((c) => `${c.question}${c.answer ? ` Answer: ${c.answer}` : ""}`).join("\n");
    case "proof":
    case "slides":
    case "constraints":
    case "dos":
    case "donts":
      return s.spec[f].join("\n");
    default:
      return s.spec[f];
  }
};

/** What changed between two versions, field by field (for "what changed" under each correction) */
export function diffStates(a: BriefState, b: BriefState): FieldDiff[] {
  const fields = [...TEXT_FIELDS, ...LIST_FIELDS] as PatchField[];
  return fields.map((f) => ({ field: f, label: FIELD_LABEL[f], before: show(a, f), after: show(b, f) })).filter((d) => d.before !== d.after);
}

/** The JSON shape the revise chat answers in */
export const PATCH_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    changes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          field: { type: "string" },
          op: { type: "string" },
          value: { type: "string" },
          index: { type: "integer" },
          status: { type: "string" },
          answer: { type: "string" },
          source: { type: "string" },
        },
        required: ["field", "op", "value", "index", "status", "answer", "source"],
        additionalProperties: false,
      },
    },
  },
  required: ["reply", "changes"],
  additionalProperties: false,
} as const;

/** A blank state (a brief with nothing in it yet) */
export const blankState = (): BriefState => ({ title: "", angle: "", audience: "", sizes: [...SIZES], overview: "", spec: emptySpec() });
