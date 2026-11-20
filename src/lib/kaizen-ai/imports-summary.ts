// What someone has imported into Kaizen AI from Claude, and how it reads on the Team page.

export type ImportCounts = { chats: number; projects: number; docs: number };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** True when they've brought anything over */
export const hasImported = (c: ImportCounts | null | undefined) => Boolean(c && c.chats + c.projects + c.docs > 0);

/** "12 chats · 2 projects · 5 docs" (only what they have), or null when nothing */
export function importSummary(c: ImportCounts | null | undefined): string | null {
  if (!hasImported(c)) return null;
  const parts = [c!.chats && plural(c!.chats, "chat", "chats"), c!.projects && plural(c!.projects, "project", "projects"), c!.docs && plural(c!.docs, "doc", "docs")].filter(Boolean);
  return parts.join(" · ");
}
