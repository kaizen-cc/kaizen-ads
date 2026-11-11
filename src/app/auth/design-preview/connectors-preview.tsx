"use client";

import { ConnectorsAdmin, MyConnections, type AdminItem, type DirectoryLoader, type MineItem } from "@/app/(team)/settings/connectors";
import type { DirectoryItem } from "@/app/(team)/settings/connector-actions";
import { faviconFor } from "@/lib/connectors/registry";

// The connector screens with sample data from the live registry (design check only: adding does nothing here)

const d = (title: string, vendor: string | null, domain: string, description: string, offered: DirectoryItem["offered"] = null): DirectoryItem => ({
  name: `${domain.split(".").reverse().join(".")}/mcp`,
  title,
  description,
  url: `https://mcp.${domain}/mcp`,
  icon_url: faviconFor(domain),
  website_url: null,
  featured: Boolean(vendor),
  vendor,
  badge: null,
  offered,
});

const SAMPLE: DirectoryItem[] = [
  d("Airtable", "Airtable", "airtable.com", "Read and write bases, tables and records."),
  d("Atlassian Rovo", "Atlassian", "atlassian.com", "Jira issues and Confluence pages, searched and updated."),
  d("Canva", "Canva", "canva.com", "Create, find and export designs and brand templates.", "on"),
  d("Cloudflare", "Cloudflare", "cloudflare.com", "Docs, observability, DNS analytics and Workers bindings."),
  d("Figma", "Figma", "figma.com", "Design context from Figma files for code and copy."),
  d("Linear", "Linear", "linear.app", "Issues, projects and cycles in Linear."),
  d("monday.com", "monday.com", "monday.com", "Boards, items and updates across your monday.com workspace."),
  d("Notion", "Notion", "notion.com", "Search, read and update pages and databases."),
  d("PayPal", "PayPal", "paypal.com", "Invoices, orders, disputes and transactions."),
  d("Stripe", "Stripe", "stripe.com", "Customers, payments, subscriptions and the Stripe docs."),
  d("Todoist", "Todoist", "todoist.com", "Tasks and projects in Todoist."),
  d("Windsor.ai", "Windsor.ai", "windsor.ai", "Marketing data from 325+ sources in one place."),
  d("Zapier", "Zapier", "zapier.com", "Run thousands of app actions through your Zapier account."),
  d("Zoom Meetings", "Zoom", "zoom.us", "Meetings, recordings and summaries."),
  d("Mizan", null, "mizan.ac", "Player ban records from game community ban lists."),
  d("inference.sh", null, "inference.sh", "Run any AI model, compose agents and connect tools."),
  d("Fireflies.ai", null, "fireflies.ai", "Meeting transcripts and summaries from Fireflies."),
  d("Bitly", null, "bitly.com", "Create and manage short links and QR codes."),
];

const load: DirectoryLoader = async (q) => {
  await new Promise((r) => setTimeout(r, 250));
  const t = q.trim().toLowerCase();
  const items = t ? SAMPLE.filter((i) => `${i.title} ${i.description} ${i.vendor ?? ""}`.toLowerCase().includes(t)) : SAMPLE;
  return { items, total: t ? items.length : 23866, ready: true };
};

const at = "2026-11-03T15:00:00Z";
const ADMIN: AdminItem[] = [
  { id: "1", key: "canva", name: "Canva", icon_url: faviconFor("canva.com"), url: "https://mcp.canva.com/mcp", auth: "oauth", client_id: null, scopes: null, note: "Create, find and export designs and brand templates.", roles: null, enabled: true, hasSecret: false, registered: true, people: 7, removed: false },
  { id: "2", key: "shopify", name: "Shopify", icon_url: faviconFor("shopify.com"), url: "https://shop.example/api/mcp", auth: "token", client_id: null, scopes: null, note: "Orders, products and customers for the client stores you manage.", roles: ["media_buyer"], enabled: true, hasSecret: false, registered: false, people: 3, removed: false },
  { id: "3", key: "mizan", name: "Mizan", icon_url: faviconFor("mizan.ac"), url: "https://mizan.ac/mcp", auth: "none", client_id: null, scopes: null, note: null, roles: null, enabled: false, hasSecret: false, registered: false, people: 0, removed: false },
];
const MINE: MineItem[] = [
  { key: "canva", name: "Canva", icon_url: faviconFor("canva.com"), note: "Create, find and export designs and brand templates.", auth: "oauth", state: "connected", since: at, lastUsed: at, last4: null, error: null, tools: 18, writes: 6 },
  { key: "notion", name: "Notion", icon_url: faviconFor("notion.com"), note: "Search, read and update pages and databases.", auth: "oauth", state: "not_connected", since: null, lastUsed: null, last4: null, error: null, tools: 0, writes: 0 },
  { key: "shopify", name: "Shopify", icon_url: faviconFor("shopify.com"), note: "Orders, products and customers for the client stores you manage.", auth: "token", state: "reconnect", since: at, lastUsed: null, last4: "9f2a", error: "Shopify didn't accept your sign in.", tools: 0, writes: 0 },
  { key: "mizan", name: "Mizan", icon_url: faviconFor("mizan.ac"), note: "Public data, nothing to sign in to.", auth: "none", state: "not_connected", since: null, lastUsed: null, last4: null, error: null, tools: 0, writes: 0 },
];

export function ConnectorsPreview({ mine }: { mine: boolean }) {
  return mine ? <MyConnections items={MINE} isExec /> : <ConnectorsAdmin items={ADMIN} ready encryption catalogTotal={23866} lastSync={at} syncError={null} syncPartial={false} loadDirectory={load} />;
}
