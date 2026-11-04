import { createHash, timingSafeEqual } from "node:crypto";
import { after } from "next/server";
import { reportError } from "@/lib/error-report";
import { loomFolders, loomLinks } from "@/lib/loom-links";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// The worker reads and files what's queued after replying
export const maxDuration = 800;

// POST /api/loom: a Loom video (or a shared folder) for the agents' knowledge.
// Zapier (Loom's "New video" trigger), Make, an email-parsing rule or the Loom browser script sends
//   { url, title?, folder?, client?, transcript?, recorded_at? }
// with the token (LOOM_WEBHOOK_TOKEN in Vercel) as `x-loom-token`, `Authorization: Bearer <token>` or `?token=`.
// The url can be anywhere in what's sent (an email body works). A transcript sent along is used as is: that's how
// videos shared only to a Loom Space (which can't be read from the link) get in, through the browser script.
// Each video is processed once; sending it again is safe (a new transcript for one that failed is read again).

const ORIGINS = ["https://www.loom.com", "https://loom.com"];
const cors = (request: Request): Record<string, string> => {
  const origin = request.headers.get("origin") ?? "";
  return ORIGINS.includes(origin) ? { "access-control-allow-origin": origin, "access-control-allow-headers": "content-type, x-loom-token, authorization", "access-control-allow-methods": "POST, OPTIONS", vary: "origin" } : {};
};

function allowed(request: Request) {
  const secret = process.env.LOOM_WEBHOOK_TOKEN;
  if (!secret) return false;
  const given = request.headers.get("x-loom-token") ?? request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? new URL(request.url).searchParams.get("token") ?? "";
  // Compared as hashes: same length whatever was sent
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}

export function OPTIONS(request: Request) {
  return new Response(null, { status: 204, headers: cors(request) });
}

export async function POST(request: Request) {
  const headers = cors(request);
  if (!allowed(request)) return Response.json({ error: "Not allowed" }, { status: 401, headers });
  if (!adminConfigured()) return Response.json({ error: "Not connected" }, { status: 500, headers });
  try {
    const raw: Record<string, unknown> = (request.headers.get("content-type") ?? "").includes("application/json")
      ? ((await request.json().catch(() => ({}))) as Record<string, unknown>)
      : Object.fromEntries((await request.formData().catch(() => new FormData())).entries());
    const str = (...keys: string[]) => keys.map((k) => raw[k]).find((v) => typeof v === "string" && v.trim()) as string | undefined;
    const all = Object.values(raw).filter((v) => typeof v === "string").join("\n");
    const urlText = str("url", "share_url", "shareUrl", "link", "video_url") ?? all;
    const admin = createAdminClient();
    const intake = await import("@/lib/loom-intake");
    const clientText = str("client", "client_name", "clientName") ?? null;

    // A shared folder: saved, read now, and read again daily
    const folder = loomFolders(urlText)[0];
    const video = loomLinks(urlText)[0];
    if (!video && folder) {
      const clientId = await intake.matchClient(admin, clientText);
      const r = await intake.addLoomFolder(admin, folder.url, { clientId });
      after(() => intake.processLoomQueue(admin).catch(() => null));
      return Response.json({ ok: !r.error, folder: folder.url, found: r.found, added: r.added, error: r.error }, { status: r.error ? 422 : 200, headers });
    }
    if (!video) return Response.json({ error: "No Loom link in what was sent (loom.com/share/…)" }, { status: 400, headers });

    const transcript = str("transcript", "text")?.slice(0, 400_000) ?? null;
    const recorded = str("recorded_at", "created_at", "createdAt", "date");
    const recordedAt = recorded && !Number.isNaN(Date.parse(recorded)) ? new Date(recorded).toISOString() : new Date().toISOString();
    const q = await intake.queueLooms(admin, [{ ...video, title: str("title", "name", "video_title") ?? null, folder: str("folder", "folder_name", "folderName") ?? null }], {
      source: "webhook",
      clientText,
      recordedAt,
    });
    let id = q.ids[0] ?? null;
    let status = "queued";
    const { data: row } = await admin.from("loom_videos").select("id, status").eq("loom_id", video.id).single();
    if (row) {
      id = row.id as string;
      status = row.status as string;
      // A transcript pushed in (a Space-only video): kept, and read again if it hadn't been filed
      if (transcript) {
        await admin.from("loom_videos").update({ transcript, updated_at: new Date().toISOString() }).eq("id", id);
        if (["failed", "queued"].includes(status)) {
          await intake.retryLoom(admin, id);
          status = "queued";
        }
      }
    }
    after(() => intake.processLoomQueue(admin).catch(() => null));
    return Response.json({ ok: true, id, status, duplicate: !q.added }, { headers });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Loom intake failed";
    await reportError({ message, path: "/api/loom", kind: "server" });
    return Response.json({ error: message }, { status: 500, headers });
  }
}
