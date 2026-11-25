// Where a file goes in Google Drive, one rule for every assistant, Kaizen AI and agent tool that creates or moves a
// file there (the owner, Nov 24 2026): before saving, say the exact destination (its full path and link) and get a
// yes, or use the folder the person named or linked in this conversation. Never guess a folder, never fall back to
// the root of My Drive. When the folder is ambiguous (several match) or isn't found, ask with the candidates. After
// saving, give the file's link and the folder's path. A confirmed folder is remembered per person, client and kind of
// document, so the next time it's one quick "Saving to <path>, OK?". The pure parts; the Drive side is
// src/lib/drive-destination.ts.

/** A folder in Drive with its whole path. willCreate: the last name of the path isn't there yet (a preview): it's made
 * under parentId only after the yes (ensureDestination), and the confirm says "(new folder)" */
/** root: the top level of their own My Drive (allowed only when they ask for it, and always confirmed once) */
export type Destination = { id: string; path: string[]; link: string | null; made?: boolean; willCreate?: { parentId: string; name: string }; root?: boolean };
/** Remembered per person, client (or prospect, by name, before they're a client) and kind of document */
export type DestinationKey = { profileId: string; clientId: string | null; prospect?: string | null; docType: string };

/** "Shared drives › Kaizen HQ › Case Studies" */
export const pathText = (path: readonly string[]) => (path.length === 1 && path[0] === "My Drive" ? "My Drive (top level)" : path.filter(Boolean).join(" › "));

/** The one quick confirm for a remembered (or proposed) folder */
export const confirmLine = (d: Destination) => `Saving to ${pathText(d.path)}${d.willCreate ? " (new folder)" : ""}${d.link ? ` (${d.link})` : ""}, OK?`;

/** After saving: the file and where it is */
export const savedLine = (fileLink: string | null, d: Destination) => `Saved${fileLink ? `: ${fileLink}` : ""} in ${pathText(d.path)}${d.made ? " (a new folder)" : ""}.`;

/** Several folders match what they said: each with its whole path, to pick one */
export const candidatesLine = (c: readonly Destination[]) => `More than one folder matches: ${c.map((d, i) => `${i + 1}) ${pathText(d.path)}${d.link ? ` (${d.link})` : ""}`).join("; ")}. Which one?`;

export type DestinationStep =
  | { step: "resolve_named" } // the folder they named or linked in this conversation: save there once it's found (no second yes)
  | { step: "confirm_remembered"; dest: Destination } // say "Saving to <path>, OK?" and wait for the yes
  | { step: "use_remembered"; dest: Destination } // they said yes to that folder
  | { step: "ask_folder" }; // nothing named and nothing remembered: ask which folder, never guess

/** What to do before saving: the folder they named wins, then the remembered one with a confirm, else ask */
export function nextStep(o: { named: string | null | undefined; remembered: Destination | null; confirmed: boolean }): DestinationStep {
  if (String(o.named ?? "").trim()) return { step: "resolve_named" };
  if (o.remembered) return o.confirmed ? { step: "use_remembered", dest: o.remembered } : { step: "confirm_remembered", dest: o.remembered };
  return { step: "ask_folder" };
}

/** A subfolder path under the named folder ("08-Kaizen Content/Case Studies"), as folder names */
export const subPath = (s: string | null | undefined) =>
  String(s ?? "")
    .split(/\s*[/>›]\s*/)
    .map((p) => p.trim())
    .filter(Boolean)
    .slice(0, 8);

/** The key a remembered folder is stored under for its client or prospect ("" when neither) */
export const destinationClientKey = (k: Pick<DestinationKey, "clientId" | "prospect">) => (k.clientId ? k.clientId : k.prospect?.trim() ? `p:${k.prospect.trim().toLowerCase()}` : "");

/** The same folder name written differently: spacing, dashes, underscores and case set aside ("08-Kaizen Content" = "08 - Kaizen Content") */
export const sameFolderName = (a: string, b: string) => {
  const n = (x: string) => x.toLowerCase().replace(/[\s\-_–—.]+/g, "");
  return n(a) !== "" && n(a) === n(b);
};
