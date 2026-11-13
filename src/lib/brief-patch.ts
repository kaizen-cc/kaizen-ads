import { ASSET_WORD, beatLine, beatOf, composeBrief, emptySpec, parseBrief, slideLine, slideOf, type AssetStatus, type BriefSpec } from "./brief-spec";

// The revise chat's edits, as data. Under a brief, the creative (or the lead) types a correction ("the seat is
// Section 112 at MSG, and it's because of the view of the bench"); the AI answers with a structured patch (set a field,
// add to a list, replace or remove an item) instead of a rewrite, so only what was asked changes, the person sees
// exactly what changed, and undo puts it back. Who may change what follows the brief permissions: the creative team,
// buyers and execs any field; the copywriter only the copy lines. Pure: tested in tests/brief-patch.test.ts.

/** The brief as one thing the chat edits: the request's own lines and the brief's spec */
export type BriefState = { title: string; angle: string; audience: string; sizes: string[]; overview: string; spec: BriefSpec };

export const TEXT_FIELDS = ["title", "angle", "audience", "overview", "stage", "insight", "insightSource", "who", "keyMessage", "hook", "length", "audio", "kpi", "success", "yourCall", "script", "exportLine"] as const;
export const LIST_FIELDS = ["proof", "beats", "slides", "frame", "versions", "constraints", "dos", "donts", "assets", "copy", "confirm", "sizes"] as const;
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
  stage: "Stage",
  insight: "Why it works",
  insightSource: "Insight source",
  who: "Who it's for",
  keyMessage: "Key message",
  hook: "Hook",
  length: "Length",
  audio: "Audio",
  kpi: "KPI",
  success: "Success looks like",
  yourCall: "Your call",
  script: "Script",
  exportLine: "Export",
  proof: "Proof",
  beats: "Beats",
  slides: "Slides",
  frame: "Frame",
  versions: "Versions",
  constraints: "Constraints",
  dos: "Must",
  donts: "Never",
  assets: "Assets",
  copy: "Copy",
  confirm: "Confirm with client",
  sizes: "Sizes",
};

/** The lines a copywriter may correct (copy and the hook lines, never the brief's direction) */
export const COPY_FIELDS: PatchField[] = ["hook", "keyMessage", "versions", "copy"];

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
      const f = c.field as "proof" | "beats" | "slides" | "frame" | "versions" | "constraints" | "dos" | "donts" | "copy";
      // A beat or a slide is kept as its one line (src/lib/brief-spec.ts beatLine, slideLine); a version without its "V2:"
      const v = !value ? "" : f === "beats" ? beatLine(beatOf(value)) : f === "slides" ? slideLine(slideOf(value)) : f === "versions" ? value.replace(/^V\d{1,2}\s*[:.)-]\s*/i, "") : value;
      next = { ...next, spec: { ...next.spec, [f]: editList(next.spec[f], c, v || null) } };
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
    case "beats":
    case "slides":
    case "frame":
    case "versions":
    case "constraints":
    case "dos":
    case "donts":
    case "copy":
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

// ─── Accountable revisions: the checklist and the change log ─────────────────────────────────

/** One change the correction asked for, as the AI listed it: done or not, where, why not, and the changes that did it */
export type AskItem = { ask: string; done: boolean; where: string; why: string; changes: number[] };
/** The change log a correction keeps: every ask, done (with where) or not done (with why), checked against the patch */
export type ChangeLogItem = { ask: string; done: boolean; where: string; why: string };

const validIdx = (xs: unknown, n: number) => (Array.isArray(xs) ? [...new Set(xs.filter((i): i is number => Number.isInteger(i) && i >= 0 && i < n))] : []);

/**
 * Patch, don't rewrite: only the changes an ask points to are applied (a change that keeps the brief consistent belongs
 * to the ask it serves). A change no ask points to is left out, so nothing the person didn't ask about moves. An answer
 * with no checklist at all (an older answer) keeps every change.
 */
export function askedChanges(items: AskItem[] | null | undefined, changes: BriefChange[]): { keep: BriefChange[]; unasked: BriefChange[] } {
  const list = (items ?? []).filter((x) => x && typeof x.ask === "string" && x.ask.trim());
  if (!list.length) return { keep: changes, unasked: [] };
  const pointed = new Set(list.flatMap((x) => validIdx(x.changes, changes.length)));
  return { keep: changes.filter((_, i) => pointed.has(i)), unasked: changes.filter((_, i) => !pointed.has(i)) };
}

const placeOf = (c: BriefChange) => `${FIELD_LABEL[c.field] ?? c.field}${c.index >= 0 && c.op !== "add" && c.op !== "set" ? ` (item ${c.index + 1})` : c.op === "add" ? " (added)" : ""}`;

/**
 * The change log, held to what really happened: an ask marked done counts as done only when one of its changes was
 * applied (otherwise it's "not done", with why); an ask the AI couldn't do keeps its reason. With no checklist, each
 * applied change is its own line. Nothing is ever silently skipped: every ask is on the log.
 */
export function changeLog(items: AskItem[] | null | undefined, changes: BriefChange[], applied: BriefChange[], refused: BriefChange[]): ChangeLogItem[] {
  const list = (items ?? []).filter((x) => x && typeof x.ask === "string" && x.ask.trim());
  const one = (s: unknown, n = 300) => (typeof s === "string" ? s.replace(/\s*—\s*/g, ", ").replace(/\s+/g, " ").trim().slice(0, n) : "");
  if (!list.length) return applied.map((c) => ({ ask: `Change ${FIELD_LABEL[c.field] ?? c.field}`, done: true, where: placeOf(c), why: "" }));
  return list.map((x) => {
    const idx = validIdx(x.changes, changes.length);
    const did = idx.filter((i) => applied.includes(changes[i]));
    const not = idx.filter((i) => refused.includes(changes[i]));
    const ask = one(x.ask, 400);
    if (did.length && x.done !== false) return { ask, done: true, where: one(x.where) || [...new Set(did.map((i) => placeOf(changes[i])))].join(", "), why: "" };
    if (x.done && !did.length)
      return { ask, done: false, where: "", why: not.length ? `The change couldn't be made (${[...new Set(not.map((i) => FIELD_LABEL[changes[i].field] ?? changes[i].field))].join(", ")}: not yours to change, or that item isn't there).` : "Marked done, but nothing in the brief changed for it." };
    return { ask, done: false, where: "", why: one(x.why) || "Not done." };
  });
}

/** The JSON shape the revise chat answers in */
export const PATCH_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    checklist: {
      type: "array",
      items: {
        type: "object",
        properties: { ask: { type: "string" }, done: { type: "boolean" }, where: { type: "string" }, why: { type: "string" }, changes: { type: "array", items: { type: "integer" } } },
        required: ["ask", "done", "where", "why", "changes"],
        additionalProperties: false,
      },
    },
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
  required: ["reply", "checklist", "changes"],
  additionalProperties: false,
} as const;

/** A blank state (a brief with nothing in it yet) */
export const blankState = (): BriefState => ({ title: "", angle: "", audience: "", sizes: [...SIZES], overview: "", spec: emptySpec() });
