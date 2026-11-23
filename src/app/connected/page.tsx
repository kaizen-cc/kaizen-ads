import { requireStaff } from "@/lib/auth";
import { ConnectedNotice } from "./connected-notice";

// Where a Connect card's sign-in lands (it opened in its own tab): tells the conversation it came from (the assistant's
// chat or call in the other tab) that the account is connected, so it picks the ask back up, then offers to close.
export default async function ConnectedPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireStaff();
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const service = one(sp.service) === "asana" ? "asana" : "slack";
  return <ConnectedNotice service={service} result={one(sp[service])} reason={one(sp.reason)} readUnavailable={one(sp.slack_read) === "unavailable"} />;
}
