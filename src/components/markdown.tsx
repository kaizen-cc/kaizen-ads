import { Fragment } from "react";

// A small Markdown renderer for AI-written documents (Brand Bibles): headings, paragraphs, bullet and numbered
// lists, pipe tables, bold, italics and links. Text only; never injects HTML.

// Links: [text](https://…) and bare https:// addresses, opened in a new tab (only http and https)
const LINK = /(\[[^\]]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<>()|]+[^\s<>()|.,;:!?'"”])/g;

function links(text: string, key: string) {
  return text.split(LINK).map((p, i) => {
    const md = p.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
    const href = md ? md[2] : /^https?:\/\//.test(p) ? p : null;
    if (!href) return <Fragment key={`${key}-${i}`}>{p}</Fragment>;
    const label = md ? md[1] : p.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
    return (
      <a key={`${key}-${i}`} href={href} target="_blank" rel="noopener noreferrer" className="break-words text-brand-text underline decoration-brand-text/30 underline-offset-2 hover:decoration-brand-text">
        {label}
      </a>
    );
  });
}

function inline(text: string, key: string) {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g);
  return parts.map((p, i) =>
    p.startsWith("**") && p.endsWith("**") ? (
      <strong key={`${key}-${i}`} className="font-semibold text-fg">
        {links(p.slice(2, -2), `${key}-${i}`)}
      </strong>
    ) : p.startsWith("*") && p.endsWith("*") && p.length > 2 && !/https?:\/\//.test(p) ? (
      <em key={`${key}-${i}`}>{p.slice(1, -1)}</em>
    ) : (
      <Fragment key={`${key}-${i}`}>{links(p, `${key}-${i}`)}</Fragment>
    ),
  );
}

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r/g, "").split("\n");
  const out: React.ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    if (!t || /^-{3,}$/.test(t)) {
      i++;
      continue;
    }
    const h = t.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const cls = level === 1 ? "font-heading text-[22px] mt-2" : level === 2 ? "font-heading text-[18px] mt-6 border-t border-line pt-5" : "text-sm font-semibold mt-3";
      out.push(
        <p key={i} className={cls}>
          {inline(h[2], `h${i}`)}
        </p>,
      );
      i++;
      continue;
    }
    if (t.startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        const r = lines[i].trim();
        if (!/^\|[\s:|-]+\|?$/.test(r)) rows.push(cells(r));
        i++;
      }
      const [head, ...body] = rows;
      const cols = head?.length ?? 0;
      // Each column gets room by how much it holds (a date column stays narrow, a notes column gets the space), and
      // every row has as many cells as the header (extra pipes in a cell join back into its last column)
      const len = (c: string) => c.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").length;
      const weight = Array.from({ length: cols }, (_, j) => Math.max(len(head?.[j] ?? ""), ...body.map((r) => len(r[j] ?? ""))));
      const total = weight.reduce((a, b) => a + Math.min(b, 120), 0) || 1;
      const fit = (r: string[]) => (r.length > cols && cols > 0 ? [...r.slice(0, cols - 1), r.slice(cols - 1).join(" | ")] : [...r, ...Array(Math.max(0, cols - r.length)).fill("")]);
      out.push(
        <div key={`t${i}`} className="my-1 overflow-x-auto rounded-[12px] border border-line [overflow-wrap:normal]">
          <table className={`w-full table-fixed border-collapse text-left text-[12.5px] ${cols > 4 ? "min-w-[760px]" : cols > 2 ? "min-w-[560px]" : ""}`}>
            <colgroup>
              {weight.map((w, j) => (
                <col key={j} style={{ width: `${Math.max(9, Math.round((Math.min(w, 120) / total) * 100))}%` }} />
              ))}
            </colgroup>
            <thead className="bg-surface-2/70">
              <tr>
                {head?.map((c, j) => (
                  <th key={j} className="px-4 py-2.5 align-bottom text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">
                    {inline(c, `th${i}${j}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((r, k) => (
                <tr key={k} className="border-t border-line/70 align-top even:bg-surface-2/25">
                  {fit(r).map((c, j) => (
                    <td key={j} className={`px-4 py-3 leading-relaxed [word-break:normal] [overflow-wrap:break-word] ${j === 0 ? "font-medium text-fg" : "text-muted"}`}>
                      {inline(c, `td${i}${k}${j}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^([-*•]|\d+[.)])\s+/.test(t)) {
      const ordered = /^\d/.test(t);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) {
        items.push(lines[i].trim().replace(/^([-*•]|\d+[.)])\s+/, ""));
        i++;
      }
      const List = ordered ? "ol" : "ul";
      out.push(
        <List key={`l${i}`} className={`grid gap-1 pl-5 text-sm leading-relaxed text-muted ${ordered ? "list-decimal" : "list-disc"}`}>
          {items.map((it, k) => (
            <li key={k}>{inline(it, `li${i}${k}`)}</li>
          ))}
        </List>,
      );
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\||([-*•]|\d+[.)])\s)/.test(lines[i].trim())) {
      para.push(lines[i].trim());
      i++;
    }
    out.push(
      <p key={`p${i}`} className="text-sm leading-relaxed text-muted">
        {inline(para.join(" "), `p${i}`)}
      </p>,
    );
  }
  return <div className="grid gap-3 [overflow-wrap:anywhere]">{out}</div>;
}
