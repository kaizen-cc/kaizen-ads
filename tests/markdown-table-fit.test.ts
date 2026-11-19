import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "@/components/markdown";

const table = ["| Issue | Who | Where | When | Fix |", "|---|---|---|---|---|", "| **Launch date** not confirmed | Lubin | Email 1 | Nov 18 | Don't schedule yet |"].join("\n");

describe("Markdown tables", () => {
  it("in Kaizen AI answers (fitColumn) fit the column on desktop and only scroll sideways on phones", () => {
    const html = renderToStaticMarkup(createElement(Markdown, { text: table, fitColumn: true }));
    expect(html).toContain("max-md:min-w-[760px]");
    expect(html).not.toMatch(/(^|[\s"])min-w-\[760px\]/);
  });

  it("elsewhere (Brand Bible) keep their minimum width and scroll", () => {
    const html = renderToStaticMarkup(createElement(Markdown, { text: table }));
    expect(html).toMatch(/(^|[\s"])min-w-\[760px\]/);
    expect(html).not.toContain("max-md:");
  });
});
