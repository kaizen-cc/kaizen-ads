import { Fragment } from "react";

// A small Markdown renderer for AI-written documents (Brand Bibles): headings, paragraphs, bullet and numbered
// lists, pipe tables, bold and italics. Text only; never injects HTML.

function inline(text: string, key: string) {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g);
  return parts.map((p, i) =>
    p.startsWith("**") && p.endsWith("**") ? (
      <strong key={`${key}-${i}`} className="font-semibold text-fg">
        {p.slice(2, -2)}
      </strong>
    ) : p.startsWith("*") && p.endsWith("*") && p.length > 2 ? (
      <em key={`${key}-${i}`}>{p.slice(1, -1)}</em>
    ) : (
      <Fragment key={`${key}-${i}`}>{p}</Fragment>
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
      out.push(
        <div key={`t${i}`} className="overflow-x-auto rounded-[10px] border border-line">
          <table className="w-full min-w-[480px] text-left text-xs">
            <thead className="bg-surface-2/60">
              <tr>
                {head?.map((c, j) => (
                  <th key={j} className="px-3 py-2 font-medium text-muted">
                    {inline(c, `th${i}${j}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((r, k) => (
                <tr key={k} className="border-t border-line/70 align-top">
                  {r.map((c, j) => (
                    <td key={j} className="px-3 py-2 leading-relaxed text-muted">
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
