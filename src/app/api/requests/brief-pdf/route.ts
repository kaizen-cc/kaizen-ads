import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

type Body = {
  clientId: string;
  title: string;
  formats: Partial<Record<"image" | "video" | "carousel", { new: number; variations: number; cards?: number }>>;
  sizes: string[];
  priority: string;
  angle: string;
  audience: string;
  brief: string;
  refs: string;
  landing?: string;
  origin?: { label?: string } | null;
};

const NAME = { image: "Single image", video: "Video", carousel: "Carousel" } as const;

// POST /api/requests/brief-pdf: a creative request as a Kaizen-branded PDF (from the request form, for anyone on the
// team who can see the client)
export async function POST(request: Request) {
  const me = await requireStaff();
  const b = (await request.json().catch(() => null)) as Body | null;
  if (!b || !/^[0-9a-f-]{36}$/i.test(b.clientId ?? "")) return new Response("Bad request", { status: 400 });
  const db = await createClient();
  const { data: client } = await db.from("clients").select("name").eq("id", b.clientId).maybeSingle();
  if (!client) return new Response("Not found", { status: 404 });
  const { briefPdf } = await import("@/lib/brief-pdf");
  const formats = (["image", "video", "carousel"] as const)
    .filter((f) => b.formats?.[f])
    .map((f) => {
      const k = b.formats[f]!;
      return { label: NAME[f], count: [k.new ? `${k.new} new` : "", k.variations ? `${k.variations} variation${k.variations === 1 ? "" : "s"}` : "", f === "carousel" && k.cards ? `${k.cards} cards` : ""].filter(Boolean).join(" + ") };
    });
  const pdf = await briefPdf({
    client: client.name as string,
    title: String(b.title ?? "").slice(0, 200),
    formats,
    sizes: (b.sizes ?? []).map((z) => String(z).replace("x", ":")),
    priority: ["high", "urgent"].includes(b.priority) ? b.priority : "normal",
    angle: String(b.angle ?? "").slice(0, 500),
    audience: String(b.audience ?? "").slice(0, 1500),
    brief: String(b.brief ?? "").slice(0, 20000),
    refs: String(b.refs ?? "").split(/\s+/).filter((u) => /^https?:\/\//i.test(u)).slice(0, 20),
    landing: b.landing && /^https?:\/\//i.test(b.landing) ? b.landing : null,
    origin: b.origin?.label ?? null,
    by: me.fullName,
  });
  const name = `${client.name} - ${b.title || "Creative request"}.pdf`.replace(/[^\w .()-]+/g, "").slice(0, 120);
  return new Response(pdf, { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${name}"`, "cache-control": "private, no-store" } });
}
