import { describe, expect, it } from "vitest";
import { runToolLoop, type LoopMessage } from "@/lib/agent-call/tool-loop";
import { MAX_EMAIL_IMAGES, attachmentFields, attachmentsOf, imageType, planAttachments, toolResultContent, withImages, type AttachmentPart } from "@/lib/email-attachments-core";

// Issue #159: a client's screenshots attached to an email reach the AI as pictures, every file is named, and files it
// can't open say so.

const shot = (name: string, size: number, mimeType = "image/png"): AttachmentPart => ({ mimeType, filename: name, body: { attachmentId: `att-${name}`, size } });

const email: AttachmentPart = {
  mimeType: "multipart/mixed",
  parts: [
    { mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", body: { data: "aGk", size: 2 } }, { mimeType: "text/html", body: { data: "aGk", size: 2 } }] },
    shot("desktop-1.png", 900_000),
    shot("desktop-2.jpg", 700_000, "image/jpeg"),
    shot("logo.png", 1_200),
    { mimeType: "application/pdf", filename: "brief.pdf", body: { attachmentId: "att-pdf", size: 50_000 } },
  ],
};

describe("email attachments", () => {
  it("finds every file in an email, nested parts included, and not the body", () => {
    const all = attachmentsOf("m1", "Cole <cole@client.com>", email);
    expect(all.map((a) => a.name)).toEqual(["desktop-1.png", "desktop-2.jpg", "logo.png", "brief.pdf"]);
    expect(all[0]).toMatchObject({ messageId: "m1", from: "Cole <cole@client.com>", attachmentId: "att-desktop-1.png", size: 900_000 });
  });

  it("knows which files are pictures the model can read", () => {
    expect(imageType("image/png", "a.png")).toBe("image/png");
    expect(imageType("image/jpg", "a.jpg")).toBe("image/jpeg");
    expect(imageType("application/octet-stream", "Screenshot.JPEG")).toBe("image/jpeg");
    expect(imageType("application/pdf", "a.pdf")).toBeNull();
    expect(imageType("image/heic", "a.heic")).toBeNull();
  });

  it("looks at the screenshots, skips logos, and says plainly a PDF can't be opened", () => {
    const { look, listed } = planAttachments(attachmentsOf("m1", "Cole", email));
    expect(look.map((a) => a.name)).toEqual(["desktop-1.png", "desktop-2.jpg"]);
    expect(listed.map((l) => l.name)).toEqual(["desktop-1.png", "desktop-2.jpg", "brief.pdf"]);
    expect(listed.find((l) => l.name === "brief.pdf")?.note).toMatch(/can't be opened/i);
    expect(listed.find((l) => l.name === "desktop-1.png")?.note).toBeNull();
  });

  it("shows at most a handful of pictures, the biggest, and says why the rest weren't looked at", () => {
    const many = Array.from({ length: MAX_EMAIL_IMAGES + 2 }, (_, i) => shot(`s${i}.png`, 10_000 * (i + 1)));
    const { look, listed } = planAttachments(attachmentsOf("m", "x", { parts: many }));
    expect(look).toHaveLength(MAX_EMAIL_IMAGES);
    expect(look[0].name).toBe(`s${MAX_EMAIL_IMAGES + 1}.png`);
    expect(listed.filter((l) => l.note).map((l) => l.name)).toEqual(["s0.png", "s1.png"]);
  });

  it("names the files for the chat and tells the model to look", () => {
    expect(attachmentFields(null)).toEqual({});
    const f = attachmentFields({ attachments: [{ name: "desktop-1.png", from: "Cole", seen: true }, { name: "brief.pdf", from: "Cole", seen: false, note: "nope" }] });
    expect(f.attachments).toHaveLength(2);
    expect(f.attachments_note).toMatch(/picture marked seen is shown/);
  });
});

describe("pictures in a tool's answer", () => {
  const img = { name: "desktop-1.png", mediaType: "image/png" as const, data: "QUJD" };

  it("never writes the picture into the text answer", () => {
    const out = withImages({ emails: 1, text: "hi" }, [img]);
    expect(JSON.stringify(out)).toBe('{"emails":1,"text":"hi"}');
    expect(toolResultContent({ a: 1 }, "plain")).toBe("plain");
  });

  it("keeps the pictures through a spread (a wrapper around the tool)", () => {
    const out = { ...withImages({ emails: 1 }, [img]) };
    const content = toolResultContent(out, "the text");
    expect(Array.isArray(content) && content.map((b) => b.type)).toEqual(["text", "image", "text"]);
  });

  it("goes to the model as an image in the tool result on a call", async () => {
    const messages: LoopMessage[] = [{ role: "user", content: "show me her screenshots" }];
    let round = 0;
    await runToolLoop({
      tools: [{ name: "read_gmail_thread", description: "", input_schema: {}, run: async () => withImages({ emails: 1, text: "See attached" }, [img]) }],
      messages,
      maxRounds: 3,
      step: async () => (round++ === 0 ? { content: [{ type: "tool_use", id: "t1", name: "read_gmail_thread", input: {} }], stop: "tool_use" } : { content: [{ type: "text", text: "I see them." }], stop: "end_turn" }),
    });
    const result = (messages.at(-1)?.content as { content: unknown }[])[0].content as { type: string; source?: { data: string } }[];
    expect(result.find((b) => b.type === "image")?.source?.data).toBe("QUJD");
    expect(result.at(-1)).toEqual({ type: "text", text: '{"emails":1,"text":"See attached"}' });
  });
});
