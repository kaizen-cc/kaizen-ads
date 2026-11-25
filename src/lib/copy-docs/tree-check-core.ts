// Where a client's approved email copy should sit in Drive: Clients › "<ID> - <Client>" › "<Client> - Headquarters" ›
// "Email Marketing" (src/lib/copy-docs/hq-path.ts). This checks the folders the client's copy Docs actually went into
// and plans the fix for any outside that tree (an older run made an Email Marketing folder elsewhere): its Docs move into
// the right Email Marketing folder, or, when the Headquarters has none yet, the folder itself moves under the
// Headquarters. Nothing moves without a yes: the plan is listed first. Pure: tested.

export type FolderInfo = { id: string; name: string; path: string[]; link: string; ancestors: string[] };
export type Misplaced = { folder: FolderInfo; docs: number; action: "move_docs" | "move_folder" };
export type TreePlan = { hq: FolderInfo; email: FolderInfo | null; right: number; misplaced: Misplaced[]; unreadable: string[] };

export const isEmailMarketing = (name: string) => /^\s*(\d+\s*[-.)]?\s*)?email\s*marketing\s*$/i.test(name);

/**
 * The plan: every folder the client's copy Docs are in, sorted into the right one (the Headquarters' Email Marketing,
 * or anything inside the Headquarters) and the misplaced ones (outside it), each with what the fix does.
 */
export function planTree(o: { hq: FolderInfo; email: FolderInfo | null; docFolders: { folderId: string; docs: number }[]; info: Record<string, FolderInfo | null> }): TreePlan {
  const misplaced: Misplaced[] = [];
  const unreadable: string[] = [];
  let right = 0;
  for (const f of o.docFolders) {
    const at = o.info[f.folderId];
    if (!at) {
      unreadable.push(f.folderId);
      continue;
    }
    const inside = at.id === o.hq.id || at.ancestors.includes(o.hq.id);
    if (inside) right += f.docs;
    else misplaced.push({ folder: at, docs: f.docs, action: o.email ? "move_docs" : "move_folder" });
  }
  return { hq: o.hq, email: o.email, right, misplaced, unreadable };
}

const pathText = (p: readonly string[]) => p.filter(Boolean).join(" › ");

/** What to say before fixing (listed first, then a yes) */
export function planLines(p: TreePlan): string[] {
  if (!p.misplaced.length) return [`Every copy Doc is inside ${pathText(p.hq.path)}${p.email ? ` (${p.email.name})` : ""}. Nothing to move.`];
  return p.misplaced.map((m) =>
    m.action === "move_docs" ? `"${pathText(m.folder.path)}" (${m.docs} Doc${m.docs === 1 ? "" : "s"}): move its files into ${pathText(p.email!.path)}` : `"${pathText(m.folder.path)}" (${m.docs} Doc${m.docs === 1 ? "" : "s"}): move the folder under ${pathText(p.hq.path)}`,
  );
}
