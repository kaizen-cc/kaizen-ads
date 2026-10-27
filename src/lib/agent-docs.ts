import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readDoc } from "@/lib/client-docs";
import type { RefImage } from "@/lib/references";

// Material shared with an agent while training it on Settings: files dropped in the agent or skill chat (in the
// private agent-docs bucket, under that agent's or skill's key) and links pasted in the message. Read the same way the
// client desk reads documents: PDFs and pictures go to the model as they are, Office and text files as their text,
// links as the page's text.

export const AGENT_DOCS_BUCKET = "agent-docs";
export type AgentFile = { path: string; name: string; mime: string; bytes: number };
/** What a chat message keeps of what was shared with it */
export type Attachment = { kind: "file" | "link"; name: string; note: string | null };

const LINK = /https?:\/\/[^\s<>"')\]]+/g;

/** Reads the files (only those under this folder) and the links in the message. */
export async function readShared(admin: SupabaseClient, folder: string, files: AgentFile[], message: string) {
  const mine = files.filter((f) => f.path.startsWith(`${folder}/`)).slice(0, 6);
  const links = [...new Set(message.match(LINK) ?? [])].slice(0, 6);
  const reads = await Promise.all([
    ...mine.map((f) => readDoc(admin, { id: f.path, kind: "file", name: f.name, path: f.path, url: null, mime: f.mime }, AGENT_DOCS_BUCKET)),
    ...links.map((u) => readDoc(admin, { id: u, kind: "link", name: u, path: null, url: u, mime: null })),
  ]);
  const images: RefImage[] = [];
  const pdfs: { data: string; title: string }[] = [];
  const parts: string[] = [];
  const attachments: Attachment[] = reads.map((r, i) => {
    const kind = i < mine.length ? ("file" as const) : ("link" as const);
    if (r.pdf) pdfs.push({ data: r.pdf, title: r.label });
    if (r.image) images.push(r.image);
    parts.push(
      r.text
        ? `<document ${kind}="${r.label.replace(/"/g, "'")}">\n${r.text}\n</document>`
        : r.pdf || r.image
          ? `<document ${kind}="${r.label.replace(/"/g, "'")}">(attached as ${r.pdf ? "a PDF" : "a picture"})</document>`
          : `<document ${kind}="${r.label.replace(/"/g, "'")}" unreadable="true">${r.note ?? "Couldn't be read"}</document>`,
    );
    return { kind, name: kind === "file" ? mine[i].name : r.label, note: r.text || r.pdf || r.image ? null : r.note };
  });
  const block = parts.length ? `<shared_by_exec>\n${parts.join("\n")}\n</shared_by_exec>` : "";
  return { block, images, pdfs, attachments };
}

/** What every training chat is told about shared material */
export const SHARED_RULES = `The exec may share material with a message: files (playbooks, SOPs, examples of great work, call notes, decks) and links, inside <shared_by_exec>, with PDFs and pictures attached. Read all of it. Say in a sentence what you took from each, then turn what should change how you work into proposed edits exactly as with any feedback: Kaizen standards written in roles, never people's names; a client's specifics belong in that client's memory, not in a playbook, so say so instead of proposing them. A good example of the work becomes an example item. A document marked unreadable: say you couldn't open it and ask for it another way.`;
