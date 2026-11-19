import "server-only";
import type { ChatTool, ToolCtx } from "./tools";
import { PRIVATE_WHILE_VIEWING, textAnswer, viewingAs } from "./my-tools";

// Figma in Kaizen AI (and the assistant), read with the person's own personal access token, saved once from the
// connector menu (Figma's hosted connector admits only apps Figma approved). Read only: a file or a frame's pages,
// frames and every text layer, rendered images of frames, and the comments.

const HOW = "Figma isn't connected yet. An exec adds one team token in Settings, Connections, Team connectors, Figma (Team token), and everyone can read Figma. Or connect your own: in Figma, Settings, Security, Personal access tokens, make one with File content read, Comments read and Current user read, and paste it in Kaizen AI's connector menu under Figma.";

export function figmaTools(ctx: ToolCtx): ChatTool[] {
  const token = async () => {
    const { personalTokenFor } = await import("@/lib/connectors/server");
    return personalTokenFor(ctx.admin, ctx.me.id, "figma");
  };
  return [
    {
      name: "read_figma",
      description:
        "Opens a Figma link (a design file, a FigJam board, or one frame: figma.com/design/<key>/…?node-id=…) as the person, with their own Figma access, and reads it: its pages and frames (with sizes and node ids) and every text layer's words, a part at a time or the passages matching a search. images: true also returns rendered PNG links of the frames read (or of node_ids), to look at or share; comments: true adds the file's comments. Use it whenever they share or mention a Figma link; never ask them for screenshots first.",
      input_schema: {
        type: "object",
        properties: {
          url: { type: "string", description: "The figma.com link" },
          node_ids: { type: "array", items: { type: "string" }, description: "Frames to render, from an earlier read (e.g. 12:34)" },
          images: { type: "boolean" },
          comments: { type: "boolean" },
          part: { type: "integer", minimum: 1 },
          search: { type: "string" },
        },
        required: ["url"],
        additionalProperties: false,
      },
      status: () => "Opening the Figma file…",
      run: async (input) => {
        if (viewingAs(ctx)) return { error: PRIVATE_WHILE_VIEWING };
        const { parseFigmaLink, readFigma, figmaImages, figmaComments } = await import("@/lib/figma");
        const link = parseFigmaLink(String(input.url ?? ""));
        if (!link) return { error: "That isn't a Figma file or frame link (figma.com/design/…, /file/…, /board/…)." };
        const t = await token();
        if (!t) return { connected: false, how: HOW };
        const read = await readFigma(t, link);
        if (!read.ok) return { error: read.error, ...(read.status === 401 || read.status === 403 ? { how: HOW } : {}) };
        const ids = Array.isArray(input.node_ids) && input.node_ids.length ? (input.node_ids as string[]).map(String) : link.node ? [link.node] : read.frames.slice(0, 6).map((f) => f.id);
        const [imgs, notes] = await Promise.all([input.images === true && ids.length ? figmaImages(t, link.key, ids) : null, input.comments === true ? figmaComments(t, link.key) : null]);
        return {
          file: read.file,
          changed: read.modified?.slice(0, 10) ?? null,
          frames: read.frames.slice(0, 60),
          ...(imgs ? (imgs.ok ? { images: imgs.images } : { images_error: imgs.error }) : {}),
          ...(notes ? (notes.ok ? { comments: notes.comments } : { comments_error: notes.error }) : {}),
          ...textAnswer(read.text || "(no text layers)", input),
        };
      },
    },
  ];
}
