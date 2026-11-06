// Claude's newer exports (a member's, or an organization's) don't email a ZIP: they email a small JSON manifest that
// lists the export's parts, each with a download link that needs the person's Claude login, expires 24 hours after
// the export was made and may stop working once used. Kaizen AI reads the manifest in the browser, shows the parts
// the import needs with their links (opened by the person, on their device), and then reads the parts they
// downloaded. The links are never sent to the server, fetched by it, or stored.
// Pure, so it's tested with the manifest's real shape.

export type ManifestRole = "chats" | "people" | "projects" | "other";
export type ManifestFile = { filename: string; url: string; category: string; part: number; role: ManifestRole; label: string; required: boolean };
export type Manifest = { createdAt: string | null; expiresAt: string | null; files: ManifestFile[] };

/** How long Claude's links last after the export is made */
export const LINK_HOURS = 24;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** A file name that looks like Claude's export manifest (member-manifest-...json) */
export const looksLikeManifestName = (name: string) => /manifest[^/\\]*\.json$/i.test(name);

function roleOf(category: string, filename: string): ManifestRole {
  const s = `${category} ${filename}`.toLowerCase();
  // design_chats are Claude's design canvas, not the person's chats
  if (/design/.test(s)) return "other";
  if (/(^|[^a-z])conversations?/.test(s)) return "chats";
  if (/light_metadata|users|members|metadata/.test(s)) return "people";
  if (/projects?/.test(s)) return "projects";
  return "other";
}

const humanize = (category: string) => {
  const s = category.replace(/[_-]+/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : "Other data";
};

/** The manifest, or null when this isn't one (no data_files with export links) */
export function parseManifest(raw: unknown): Manifest | null {
  const m = obj(raw);
  const list = Array.isArray(m?.data_files) ? (m!.data_files as unknown[]).map(obj).filter((f): f is Obj => Boolean(f)) : [];
  const files = list.flatMap((f) => {
    const url = str(f.export_url);
    if (!/^https:\/\//i.test(url)) return [];
    const category = str(f.category);
    const part = typeof f.part === "number" && Number.isFinite(f.part) ? f.part : 0;
    const filename = (str(f.filename) || `${category || "part"}-${String(part).padStart(3, "0")}.zip`).split(/[/\\]/).pop()!;
    return [{ filename, url, category, part, role: roleOf(category, filename) }];
  });
  if (!files.length) return null;
  const chats = files.filter((f) => f.role === "chats").sort((a, b) => a.part - b.part || a.filename.localeCompare(b.filename));
  const labelled: ManifestFile[] = files.map((f) => {
    if (f.role === "chats") {
      const i = chats.indexOf(f);
      return { ...f, required: true, label: chats.length > 1 ? `Your chats, part ${i + 1} of ${chats.length}` : "Your chats" };
    }
    if (f.role === "people") return { ...f, required: true, label: "Who's who (needed to keep only your chats)" };
    if (f.role === "projects") return { ...f, required: false, label: "Projects (optional)" };
    return { ...f, required: false, label: humanize(f.category) };
  });
  const order: Record<ManifestRole, number> = { chats: 0, people: 1, projects: 2, other: 3 };
  labelled.sort((a, b) => order[a.role] - order[b.role] || a.part - b.part || a.filename.localeCompare(b.filename));
  const created = Date.parse(str(m!.created_at));
  return {
    createdAt: Number.isFinite(created) ? new Date(created).toISOString() : null,
    expiresAt: Number.isFinite(created) ? new Date(created + LINK_HOURS * 3_600_000).toISOString() : null,
    files: labelled,
  };
}

/** The parts the import reads: chats, who's who, and projects (the rest isn't needed) */
export const wantedFiles = (m: Manifest) => m.files.filter((f) => f.role !== "other");

/** A downloaded file's name as the manifest gives it ("conversations-001 (1).zip" from a second download counts) */
export function sameFile(picked: string, listed: string) {
  const norm = (s: string) =>
    (s.split(/[/\\]/).pop() ?? "")
      .toLowerCase()
      .replace(/\s*\(\d+\)(?=\.[a-z0-9]+$)/, "")
      .replace(/\s+/g, "");
  return norm(picked) === norm(listed);
}

/** The needed parts not among the picked files */
export function missingFiles(m: Manifest, picked: string[]): ManifestFile[] {
  return m.files.filter((f) => f.required && !picked.some((p) => sameFile(p, f.filename)));
}

/** True once the links are past their 24 hours */
export const linksExpired = (m: Manifest, now = Date.now()) => Boolean(m.expiresAt && Date.parse(m.expiresAt) <= now);
