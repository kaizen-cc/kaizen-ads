// People's profiles: the rules for seeding one from Slack (once, never overwriting), for editing, and for tenure. Pure
// (no network, no database), so a test can hold the rules the server code (profile-slack.ts, the profile actions) runs.

export type ProfileFields = {
  display_name: string | null;
  title: string | null;
  bio: string | null;
  avatar_url: string | null;
  start_date: string | null;
};

/** What Slack knows about a person, read from users.info or users.profile.get */
export type SlackPerson = { id: string | null; name: string | null; title: string | null; status: string | null; image: string | null };

/** The profile fields that can be pulled again from Slack, one at a time */
export const SLACK_FIELDS = ["avatar_url", "display_name", "title", "bio"] as const;
export type SlackField = (typeof SLACK_FIELDS)[number];
export const isSlackField = (v: unknown): v is SlackField => (SLACK_FIELDS as readonly unknown[]).includes(v);

const clean = (v: unknown, max: number): string | null => {
  const s = String(v ?? "").replace(/[ \t]+/g, " ").trim().slice(0, max).trim();
  return s || null;
};

/**
 * A Slack user from either API's answer (`user.profile` from users.info, or `profile` from users.profile.get): the real
 * name, title, status text (the nearest thing Slack has to a bio) and picture. Slack's stand-in picture (no photo was
 * ever set) isn't a picture, so it's left out.
 */
export function parseSlackUser(body: unknown): SlackPerson | null {
  const b = body as { user?: { id?: string; real_name?: string; profile?: Record<string, unknown> }; profile?: Record<string, unknown> } | null;
  const profile = (b?.user?.profile ?? b?.profile) as Record<string, unknown> | undefined;
  if (!profile) return null;
  const custom = profile.is_custom_image !== false && Boolean(profile.is_custom_image ?? profile.image_original ?? profile.image_512);
  const image = custom ? clean(profile.image_original ?? profile.image_512 ?? profile.image_192, 600) : null;
  return {
    id: clean(b?.user?.id, 40),
    name: clean(profile.real_name ?? b?.user?.real_name ?? profile.display_name, 60),
    title: clean(profile.title, 80),
    status: clean(profile.status_text, 500),
    image: image && /^https:\/\//i.test(image) ? image : null,
  };
}

/** The value Slack gives for a profile field (the status text stands in for a bio) */
export function slackValue(person: SlackPerson, field: SlackField, image: string | null): string | null {
  if (field === "avatar_url") return image;
  if (field === "display_name") return person.name;
  if (field === "title") return person.title;
  return person.status;
}

/**
 * The first setup: what to fill from Slack. Only a field that is still empty is filled, and nothing at all once the
 * profile has been seeded (profile_seeded_at is set), so Slack never overwrites what the person has in Kaizen OS.
 * `image` is the picture as copied into Kaizen OS's storage (or Slack's own link when the copy failed).
 */
export function seedPatch(current: Partial<ProfileFields> & { profile_seeded_at?: string | null }, person: SlackPerson | null, image: string | null): Partial<ProfileFields> | null {
  if (current.profile_seeded_at) return null;
  if (!person) return {};
  const patch: Partial<ProfileFields> = {};
  for (const f of SLACK_FIELDS) {
    const v = slackValue(person, f, image);
    if (v && !current[f]) patch[f] = v;
  }
  return patch;
}

/** One field pulled again on purpose ("Import from Slack"): replaces just that field, or nothing when Slack has none */
export function reimportPatch(field: SlackField, person: SlackPerson | null, image: string | null): Partial<ProfileFields> | null {
  const v = person ? slackValue(person, field, image) : null;
  return v ? { [field]: v } : null;
}

const DAY = 86_400_000;
const isDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T12:00:00Z`)) && new Date(`${v}T12:00:00Z`).toISOString().slice(0, 10) === v;

export type ProfileEdit = { display_name?: string | null; title?: string | null; bio?: string | null; start_date?: string | null };

/** A person's own edit, checked and trimmed: only the fields given, or the reason one can't be saved */
export function cleanEdit(input: Record<string, unknown>, now = new Date()): { ok: true; patch: ProfileEdit } | { ok: false; error: string } {
  const patch: ProfileEdit = {};
  if ("display_name" in input) {
    const v = clean(input.display_name, 60);
    if (input.display_name && !v) return { ok: false, error: "Add the name you go by." };
    patch.display_name = v;
  }
  if ("title" in input) patch.title = clean(input.title, 80);
  if ("bio" in input) {
    const v = String(input.bio ?? "").replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, 500);
    patch.bio = v || null;
  }
  if ("start_date" in input) {
    const v = String(input.start_date ?? "").trim();
    if (!v) patch.start_date = null;
    else if (!isDay(v)) return { ok: false, error: "Use a real date for your start date." };
    else if (Date.parse(`${v}T12:00:00Z`) > now.getTime() + 2 * DAY) return { ok: false, error: "Your start date can't be in the future." };
    else if (v < "1990-01-01") return { ok: false, error: "That start date looks too early." };
    else patch.start_date = v;
  }
  return { ok: true, patch };
}

/** How long someone has been at Kaizen: "5 months", "2 years, 3 months", "Just joined" (null with no start date) */
export function tenureOf(start: string | null | undefined, now = new Date()): string | null {
  if (!start || !isDay(start)) return null;
  const [y, m, d] = start.split("-").map(Number);
  let months = (now.getUTCFullYear() - y) * 12 + (now.getUTCMonth() + 1 - m);
  if (now.getUTCDate() < d) months -= 1;
  if (months < 0) return "Starting soon";
  if (months < 1) return "Just joined";
  const years = Math.floor(months / 12);
  const rest = months % 12;
  const part = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (!years) return part(rest, "month");
  return rest ? `${part(years, "year")}, ${part(rest, "month")}` : part(years, "year");
}

/** The day a start date falls on, for display ("Jan 6, 2025") */
export const startLabel = (start: string | null | undefined): string | null => (start && isDay(start) ? new Date(`${start}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : null);

/** What a person goes by: the name they chose, else their full name */
export const shownName = (p: { display_name?: string | null; full_name: string }): string => p.display_name?.trim() || p.full_name;

/** The theme choices people have made, counted (unset: never chose, so they see the app's default) */
export function themeBreakdown(rows: { theme: string | null }[]): { system: number; light: number; dark: number; unset: number; total: number } {
  const out = { system: 0, light: 0, dark: 0, unset: 0, total: rows.length };
  for (const r of rows) {
    if (r.theme === "light") out.light++;
    else if (r.theme === "dark") out.dark++;
    else if (r.theme === "system") out.system++;
    else out.unset++;
  }
  return out;
}
