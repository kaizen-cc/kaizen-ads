import type { ClientKlaviyo } from "@/lib/klaviyo/store";
import { EmailTab, type EmailTabId } from "./email-panel";

// The Email service's tabs for the client page's tab bar. Kept out of the client component file: the client page is
// rendered on the server, which can't call a function exported from a "use client" file, only render its components.

const TABS: { id: EmailTabId; label: string; hint: string }[] = [
  { id: "overview", label: "Overview", hint: "Revenue, share of the store, revenue per recipient and deliverability over time, and the account's health" },
  { id: "campaigns", label: "Campaigns", hint: "Every campaign: sortable, email or SMS, best subject lines, each previewed on hover or tap" },
  { id: "flows", label: "Flows", hint: "The key flows' coverage and every flow's revenue" },
  { id: "audience", label: "Audience", hint: "List joins and leaves, lists and segments by size" },
  { id: "deliverability", label: "Deliverability", hint: "Weekly bounce, spam and unsubscribe rates against healthy lines" },
];

export function emailTabs(k: ClientKlaviyo, clientId: string) {
  return TABS.map((t) => ({ ...t, content: <EmailTab k={k} clientId={clientId} tab={t.id} /> }));
}
