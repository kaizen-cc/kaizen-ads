import { chatFile } from "@/lib/portal-chat";
import { chatAccess } from "../../../access";

// A file from the client's chat, fetched from Slack with the app's token and handed on: the browser only ever sees
// our link, never Slack's or the token. Only files in this client's own channel. ?thumb=1 gives an image's preview.
export async function GET(request: Request, ctx: RouteContext<"/api/portal-chat/[slug]/file/[id]">) {
  const { slug, id } = await ctx.params;
  const a = await chatAccess(slug);
  if (!a || !process.env.SLACK_BOT_TOKEN) return new Response("Not found", { status: 404 });
  const f = await chatFile(a.admin, a.client.id as string, id);
  const thumb = new URL(request.url).searchParams.get("thumb") === "1";
  const src = (thumb && f?.thumb) || f?.url;
  if (!f || !src || !/^https:\/\/files\.slack\.com\//.test(src)) return new Response("Not found", { status: 404 });
  const res = await fetch(src, { headers: { authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }, cache: "no-store" });
  if (!res.ok || !res.body) return new Response("Not found", { status: 404 });
  const download = new URL(request.url).searchParams.get("download") === "1";
  return new Response(res.body, {
    headers: {
      "content-type": res.headers.get("content-type") ?? f.mime,
      ...(res.headers.get("content-length") ? { "content-length": res.headers.get("content-length")! } : {}),
      "cache-control": "private, max-age=3600",
      "content-disposition": `${download ? "attachment" : "inline"}; filename="${f.name.replace(/[^\w.\- ]+/g, "_")}"`,
      "x-content-type-options": "nosniff",
    },
  });
}
