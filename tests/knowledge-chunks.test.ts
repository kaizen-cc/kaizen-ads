import { describe, expect, it } from "vitest";
import { CHUNK_WORDS, chunkPages, chunkText } from "@/lib/knowledge-chunks";

const page = (n: number, word = "offer") => Array.from({ length: n }, () => word).join(" ");

describe("knowledge chunks", () => {
  it("groups short pages into chunks of about the target size, keeping page ranges", () => {
    const pages = Array.from({ length: 10 }, (_, i) => `Section ${i + 1}\n${page(300)}`);
    const out = chunkPages(pages);
    expect(out.length).toBeGreaterThan(1);
    expect(out[0].pageFrom).toBe(1);
    expect(out[out.length - 1].pageTo).toBe(10);
    // Every page lands in exactly one chunk, in order
    for (let i = 1; i < out.length; i++) expect(out[i].pageFrom).toBe((out[i - 1].pageTo ?? 0) + 1);
    expect(out[0].heading).toBe("Section 1");
  });

  it("skips empty pages (a scan's blank page) without breaking the ranges", () => {
    const out = chunkPages(["", `Intro\n${page(100)}`, "", `Rules\n${page(100)}`]);
    expect(out).toHaveLength(1);
    expect(out[0].pageFrom).toBe(2);
    expect(out[0].pageTo).toBe(4);
  });

  it("splits one very long page on its own, all of it on that page", () => {
    const long = Array.from({ length: 6 }, (_, i) => `Part ${i}\n${page(400)}`).join("\n\n");
    const out = chunkPages([`Cover\n${page(50)}`, long]);
    const fromLong = out.filter((c) => c.pageFrom === 2);
    expect(fromLong.length).toBeGreaterThan(1);
    expect(fromLong.every((c) => c.pageTo === 2)).toBe(true);
    expect(out[0].pageTo).toBe(1);
  });

  it("chunks text without pages on paragraph breaks", () => {
    const text = Array.from({ length: 8 }, (_, i) => `## Heading ${i}\n${page(250)}`).join("\n\n");
    const out = chunkText(text);
    expect(out.length).toBeGreaterThan(1);
    expect(out.every((c) => c.pageFrom === null)).toBe(true);
    expect(out[0].heading).toBe("Heading 0");
    expect(out.every((c) => c.text.split(/\s+/).length <= CHUNK_WORDS * 2)).toBe(true);
  });
});
