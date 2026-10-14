"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export type CreateResult = { ok: true; number: number } | { ok: false; error: string };

const SIZES = ["1x1", "4x5", "9x16"];

export async function createRequest(form: FormData): Promise<CreateResult> {
  await requireStaff();
  const s = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v.trim() : "";
  };
  const client = s("client");
  const title = s("title");
  const format = s("format");
  if (!client) return { ok: false, error: "Pick a client." };
  if (!title) return { ok: false, error: "Give the request a title." };
  if (!["image", "video", "carousel"].includes(format)) return { ok: false, error: "Pick a format." };

  const refs = s("refs")
    .split(/\s+/)
    .filter((u) => /^https?:\/\//i.test(u))
    .slice(0, 20);
  const sizes = form.getAll("sizes").filter((v): v is string => typeof v === "string" && SIZES.includes(v));
  const quantity = Math.min(100, Math.max(1, Number(s("quantity")) || 1));

  const supabase = await createClient();
  const { data: id, error } = await supabase.rpc("create_request", {
    p_client: client,
    p_title: title,
    p_format: format,
    p_kind: s("kind") === "iteration" ? "iteration" : "new",
    p_priority: ["high", "urgent"].includes(s("priority")) ? s("priority") : "normal",
    p_angle: s("angle") || null,
    p_audience: s("audience") || null,
    p_brief: s("brief") || null,
    p_refs: refs,
    p_sizes: sizes,
    p_quantity: quantity,
  });
  if (error) return { ok: false, error: error.message };

  const { data: row } = await supabase.from("requests").select("number").eq("id", id).single();
  revalidatePath("/board");
  revalidatePath("/pipeline");
  return { ok: true, number: row?.number ?? 0 };
}
