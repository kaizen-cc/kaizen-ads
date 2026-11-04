import { listMessages, listThread, loadOlder, markRead, postFromPortal, syncChannel, syncThread, type Upload } from "@/lib/portal-chat";
import { chatAccess, tooFast } from "../access";

// The portal chat, as plain requests (not server actions, which run one at a time and would queue behind the page).
// GET: the newest page, what's newer than ?after=, older history before ?before=, or a ?thread=. The channel is read
// from Slack first (at most every few seconds per channel). POST: a message from the client, with files already in
// our storage (uploaded straight from the browser, so big files never pass through here).
export const maxDuration = 60;

const NO_STORE = { "cache-control": "private, no-store" };

export async function GET(request: Request, ctx: RouteContext<"/api/portal-chat/[slug]">) {
  const { slug } = await ctx.params;
  const a = await chatAccess(slug);
  if (!a) return Response.json({ error: "Not found" }, { status: 404 });
  const channel = a.client.slack_channel_id as string | null;
  if (!channel || !process.env.SLACK_BOT_TOKEN) return Response.json({ channel: false, messages: [], hasMore: false, canPost: false, team: a.team }, { headers: NO_STORE });
  const url = new URL(request.url);
  const after = url.searchParams.get("after");
  const before = url.searchParams.get("before");
  const thread = url.searchParams.get("thread");
  const clientId = a.client.id as string;
  try {
    if (thread) {
      await syncThread(a.admin, clientId, channel, thread).catch(() => null);
      return Response.json({ channel: true, messages: await listThread(a.admin, clientId, thread, a.contactId), canPost: !a.team, team: a.team }, { headers: NO_STORE });
    }
    let hasMore = true;
    if (before) {
      const page = await listMessages(a.admin, clientId, { before, readerId: a.contactId });
      // Ran out of what's copied here: the next page from Slack
      if (page.length < 50) {
        hasMore = await loadOlder(a.admin, clientId, channel).catch(() => false);
        const more = await listMessages(a.admin, clientId, { before, readerId: a.contactId });
        return Response.json({ channel: true, messages: more, hasMore: hasMore || more.length >= 50, canPost: !a.team, team: a.team }, { headers: NO_STORE });
      }
      return Response.json({ channel: true, messages: page, hasMore: true, canPost: !a.team, team: a.team }, { headers: NO_STORE });
    }
    await syncChannel(a.admin, clientId, channel).catch((e) => console.error("[portal chat] sync", e instanceof Error ? e.message : e));
    const messages = await listMessages(a.admin, clientId, { after, readerId: a.contactId });
    const { data: state } = await a.admin.from("portal_chat_state").select("has_more").eq("client_id", clientId).maybeSingle();
    hasMore = Boolean(state?.has_more ?? true);
    // Read up to the newest they've been shown
    const newest = messages.at(-1)?.ts;
    if (newest) await markRead(a.admin, clientId, a.readerId, newest);
    return Response.json({ channel: true, messages, hasMore, canPost: !a.team, team: a.team }, { headers: NO_STORE });
  } catch (e) {
    console.error("[portal chat] read", e instanceof Error ? e.message : e);
    return Response.json({ error: "The chat couldn't load right now." }, { status: 502 });
  }
}

const safe = (name: string) => name.replace(/[^\w.-]+/g, "-").slice(-80);

export async function POST(request: Request, ctx: RouteContext<"/api/portal-chat/[slug]">) {
  const { slug } = await ctx.params;
  const a = await chatAccess(slug);
  if (!a) return Response.json({ error: "Not found" }, { status: 404 });
  const channel = a.client.slack_channel_id as string | null;
  if (!channel) return Response.json({ error: "Your chat isn't set up yet." }, { status: 400 });
  // The team answers in Slack itself; the portal shows them what the client sees
  if (a.team) return Response.json({ error: "Reply in Slack: the portal chat is the client's side." }, { status: 403 });
  const clientId = a.client.id as string;
  const body = (await request.json().catch(() => null)) as { op?: string; files?: { name: string; bytes: number; mime?: string }[]; text?: string; thread?: string | null; paths?: { path: string; name: string; mime: string }[] } | null;
  if (!body) return Response.json({ error: "Nothing to send." }, { status: 400 });

  // 1. Where the browser puts the files (our storage, signed slots in this client's own folder)
  if (body.op === "slots") {
    const files = (body.files ?? []).slice(0, 6);
    if (!files.length) return Response.json({ slots: [] });
    if (files.some((f) => f.bytes > 50_000_000)) return Response.json({ error: "Files up to 50 MB." }, { status: 400 });
    const slots: { path: string; token: string }[] = [];
    for (const f of files) {
      const path = `${clientId}/chat/${crypto.randomUUID()}-${safe(f.name)}`;
      const { data, error } = await a.admin.storage.from("client-docs").createSignedUploadUrl(path);
      if (error || !data) return Response.json({ error: "Uploads aren't working right now. Try again in a minute." }, { status: 502 });
      slots.push({ path, token: data.token });
    }
    return Response.json({ slots });
  }

  // 2. The message
  const text = String(body.text ?? "").slice(0, 8000);
  const paths = (body.paths ?? []).slice(0, 6);
  if (!text.trim() && !paths.length) return Response.json({ error: "Write something first." }, { status: 400 });
  if (paths.some((p) => !p.path.startsWith(`${clientId}/chat/`))) return Response.json({ error: "Not found" }, { status: 404 });
  if (await tooFast(a.admin, clientId, a.name)) return Response.json({ error: "Slow down a little: try again in a minute." }, { status: 429 });
  const thread = body.thread && /^\d+\.\d+$/.test(body.thread) ? body.thread : null;
  const files: Upload[] = [];
  for (const p of paths) {
    const { data, error } = await a.admin.storage.from("client-docs").download(p.path);
    if (error || !data) return Response.json({ error: "One of the files didn't upload. Try again." }, { status: 400 });
    files.push({ name: p.name.slice(0, 200), mime: p.mime || data.type, bytes: new Uint8Array(await data.arrayBuffer()) });
  }
  const r = await postFromPortal(a.admin, { id: clientId, channel }, { contactId: a.contactId, name: a.name, avatar: null, team: false }, { text, thread, files });
  if (!r.ok) return Response.json({ error: r.error }, { status: 502 });
  return Response.json({ ok: true, ts: r.ts });
}
