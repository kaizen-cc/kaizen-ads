// ElevenLabs voices, parsed and grouped for the pickers. Pure (no key, no network), so the same code reads every
// source (the account's own list, the default voices, the legacy list and the shared library) and a test can hold it.

export type Voice = {
  id: string;
  name: string;
  category: string; // premade, cloned, generated, professional, library
  previewUrl: string | null;
  labels: Record<string, string>; // accent, age, gender, use case, description
  description: string | null;
  /** A library voice that isn't on the account yet: its owner's id, needed to add it before it can speak */
  ownerId?: string | null;
};

export type RawVoice = {
  voice_id?: string;
  name?: string;
  category?: string;
  preview_url?: string | null;
  labels?: Record<string, unknown> | null;
  description?: string | null;
  // The shared library's flat fields
  public_owner_id?: string;
  gender?: string | null;
  age?: string | null;
  accent?: string | null;
  descriptive?: string | null;
  use_case?: string | null;
};

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** One voice from any of the API's shapes, or null when it has no id or name */
export function toVoice(v: RawVoice, fallbackCategory = "premade"): Voice | null {
  const id = text(v.voice_id);
  const name = text(v.name);
  if (!id || !name) return null;
  const labels: Record<string, string> = {};
  for (const [k, val] of Object.entries(v.labels ?? {})) {
    const t = text(val);
    if (t) labels[k] = t;
  }
  // The library lists these as plain fields rather than labels
  for (const k of ["gender", "age", "accent", "descriptive", "use_case"] as const) {
    const t = text(v[k]);
    if (t && !labels[k]) labels[k] = t;
  }
  return { id, name, category: text(v.category) ?? fallbackCategory, previewUrl: text(v.preview_url), labels, description: text(v.description), ownerId: text(v.public_owner_id) };
}

/** The voices in one API response (`voices` array), skipping anything malformed */
export function parseVoices(body: unknown, fallbackCategory = "premade"): Voice[] {
  const list = (body as { voices?: unknown } | null)?.voices;
  if (!Array.isArray(list)) return [];
  return list.flatMap((v) => {
    const out = v && typeof v === "object" ? toVoice(v as RawVoice, fallbackCategory) : null;
    return out ? [out] : [];
  });
}

/** Several lists as one, a voice once (the first list to have it wins, but a later one fills in a missing sample) */
export function mergeVoices(lists: Voice[][]): Voice[] {
  const byId = new Map<string, Voice>();
  for (const list of lists)
    for (const v of list) {
      const had = byId.get(v.id);
      if (!had) byId.set(v.id, v);
      else if (!had.previewUrl && v.previewUrl) byId.set(v.id, { ...had, previewUrl: v.previewUrl });
    }
  return [...byId.values()];
}

export type VoiceGroupKey = "yours" | "default" | "library";

/** Where a voice sits in the picker: the person's own (cloned, designed), ElevenLabs' defaults, or the shared library */
export function groupOf(v: Pick<Voice, "category" | "ownerId">): VoiceGroupKey {
  if (v.category === "library" || v.ownerId) return "library";
  if (v.category === "premade" || v.category === "default") return "default";
  return "yours";
}

const GROUP_TITLES: Record<VoiceGroupKey, string> = { yours: "Your voices", default: "Kaizen's defaults", library: "Voice library" };

/** A short line about a voice: its gender, accent, age and what it's like */
export const aboutOf = (v: Pick<Voice, "labels" | "description">): string => [v.labels.gender, v.labels.accent, v.labels.age, v.labels.descriptive ?? v.labels.description ?? v.description].filter(Boolean).join(", ");

/** What the picker lists: a voice with its group and a short line, sorted within each group by name */
export type VoiceOption = { id: string; name: string; about: string; preview: string | null; group: VoiceGroupKey; owner: string | null };

export const optionOf = (v: Voice): VoiceOption => ({ id: v.id, name: v.name, about: aboutOf(v), preview: v.previewUrl, group: groupOf(v), owner: v.ownerId ?? null });

/** The picker's groups in order (own voices, then the defaults, then the library), empty ones left out */
export function groupVoices(options: VoiceOption[]): { key: VoiceGroupKey; title: string; voices: VoiceOption[] }[] {
  return (["yours", "default", "library"] as const)
    .map((key) => ({ key, title: GROUP_TITLES[key], voices: options.filter((o) => o.group === key).sort((a, b) => a.name.localeCompare(b.name)) }))
    .filter((g) => g.voices.length);
}

/** Whether a voice matches what was typed in the picker's search (name, accent, gender, any word of its line) */
export function voiceMatches(o: Pick<VoiceOption, "name" | "about">, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = `${o.name} ${o.about}`.toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}

/** The short line a voice speaks for its sample, when ElevenLabs has no sample of its own to play */
export const SAMPLE_LINE = "Hi, I'm your assistant. Here's how I sound when we go through your day together.";

/**
 * The voice a person named: an exact id or name first, then a name that starts with it or holds it as a word. Returns
 * the single match, or null when there's none or more than one (the caller asks which).
 */
export function findVoice<T extends { id: string; name: string }>(options: T[], query: string): { match: T | null; candidates: T[] } {
  const q = query.trim().toLowerCase();
  if (!q) return { match: null, candidates: [] };
  const exact = options.filter((o) => o.id.toLowerCase() === q || o.name.toLowerCase() === q);
  if (exact.length === 1) return { match: exact[0], candidates: exact };
  const pool = exact.length ? exact : options.filter((o) => o.name.toLowerCase().startsWith(q) || o.name.toLowerCase().split(/[\s\-,.]+/).includes(q));
  return { match: pool.length === 1 ? pool[0] : null, candidates: pool.slice(0, 6) };
}
