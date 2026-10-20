import { requireStaff } from "@/lib/auth";
import { disconnect } from "@/lib/slack-user";

// Forget the signed-in person's Slack. POST only, so a stray link or image can't disconnect someone.
export async function POST() {
  const staff = await requireStaff();
  await disconnect(staff.id);
  return Response.json({ ok: true });
}
