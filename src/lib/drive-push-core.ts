// Putting what Kaizen OS made (a case study, an SOW, a deck) into a Google Drive folder the person points to: by its
// link, or by its path as they'd say it ("00-Business Manifesto/08-Kaizen Content"), the first part a shared drive or a
// folder anywhere they can reach. Pure parts: reading the folder they meant, and Drive's query quoting.

export type FolderRef = { id: string } | { path: string[] };

/** A Drive folder link (or a bare id) or a path of folder names */
export function parseFolderRef(input: string): FolderRef | null {
  const s = String(input ?? "").trim();
  if (!s) return null;
  const link = s.match(/drive\.google\.com\/(?:drive\/(?:u\/\d+\/)?folders\/|open\?id=|folderview\?id=)([A-Za-z0-9_-]{10,})/);
  if (link) return { id: link[1] };
  // A folder or shared drive by its id, as code passes it ("id:0AFx…")
  const tagged = s.match(/^id:([A-Za-z0-9_-]{10,})$/);
  if (tagged) return { id: tagged[1] };
  if (/^[A-Za-z0-9_-]{25,}$/.test(s)) return { id: s };
  const path = s
    .replace(/^(my drive|shared drives?)\s*[/>]\s*/i, "")
    .split(/\s*[/>]\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  return path.length ? { path } : null;
}

/** A name inside a Drive query, quoted ("Kaizen's Content" → 'Kaizen\'s Content') */
export const driveQuote = (name: string) => `'${name.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/** The multipart body Drive's upload takes: the file's details, then its bytes */
export function multipartBody(meta: Record<string, unknown>, bytes: Uint8Array, mime: string, boundary: string): Uint8Array {
  const enc = new TextEncoder();
  const head = enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`);
  const tail = enc.encode(`\r\n--${boundary}--`);
  const out = new Uint8Array(head.length + bytes.length + tail.length);
  out.set(head, 0);
  out.set(bytes, head.length);
  out.set(tail, head.length + bytes.length);
  return out;
}
