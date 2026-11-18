import { asanaTaskName, type CopyKind } from "@/lib/copy-docs/core";
import type { LineConfig, TaskInput } from "../engine";

// The email line: the Email Strategist leads, the Copywriter writes, one preview document per batch or flow, the
// approved copy as a Google Doc in the client's HQ Drive under "Email Marketing", and the requests in Asana's Email
// Marketing project, "Email Requests" column, no assignee or due date (the strategists set those), the client's email
// strategist following. One task per campaign in a batch; one per flow with its email count.

const REQUEST_TYPE: Record<string, string> = { campaign: "Email Campaign", flow: "Email Flow", sms: "SMS" };

export const EMAIL_LINE: LineConfig = {
  line: "email",
  label: "Email",
  lead: "email_strategist",
  writer: "copywriter",
  followerSeat: "email_strategist",
  kinds: [
    { key: "campaign", label: "Campaign", max: 5, split: "per_item", words: /\b(?:campaigns?|blasts?|newsletters?|promo(?:tional)? emails?|batch(?:es)?)\b/i },
    { key: "flow", label: "Flow", max: 6, split: "per_doc", words: /\b(?:flows?|automations?|series|sequences?|drip)\b/i },
    { key: "sms", label: "SMS", max: 5, split: "per_item", words: /\b(?:sms|texts?|text messages?)\b/i },
  ],
  trigger: /\b(?:(?:create|make|build|plan|do|need|write|draft|set up|put together)\b[^.?!]{0,40}\b(?:email\s+)?(?:campaigns?|flows?|newsletters?|blasts?|email copy|emails?\s+for|sms|welcome series|abandon\w* (?:cart|checkout))|copy for (?:an?|the|their) (?:campaign|email|newsletter|flow))\b/i,
  context: [
    "kpi_board (the Email KPI board as it shows: the email score and every check incl. deliverability, revenue pace, RPR, campaign and flow rates, the sending cycle, segments; it is also in the context pull as kpi_board)",
    "email_marketing (recent campaigns and flows, lists and how each performs)",
    "top_emails and email_detail (what worked for them)",
    "get_client_context and search_client (the latest Slack, Gmail and call notes)",
    "recent_calls and read_call (what was promised on calls)",
    "the Brand Bible and client memory in the context (their rules)",
  ],
  brainstorm: "Use your knowledge's rule for which segments to include and exclude, check the calendar and the allotment, and keep each topic to one line.",
  doc: { template: "copy", folder: "Email Marketing" },
  asana: {
    project: { env: "ASANA_EMAIL_PROJECT_GID", setting: "asana_email_project", nameLike: /email/i, syncSource: "asana_email" },
    section: "Email Requests",
    taskName: (t: TaskInput) => asanaTaskName({ client: t.client.name, kind: t.kind.key as CopyKind, shortName: t.shortName, count: t.count }),
    fields: (t: TaskInput) => [
      { name: "CLIENT ID", value: t.client.kaizenId != null ? String(t.client.kaizenId) : "", aliases: ["Client ID", "Client #", "Kaizen ID"] },
      { name: "Request Type", value: REQUEST_TYPE[t.kind.key] ?? t.kind.label, aliases: ["Type", "Request"] },
      { name: "Platform", value: t.client.platform ?? "", aliases: ["Email Platform", "ESP"] },
      { name: "Priority", value: t.urgency, aliases: ["Urgency"] },
      { name: "Client HQ - ASSETS", value: t.client.hqUrl ?? "", aliases: ["Client HQ", "HQ", "Assets"] },
      { name: "Purpose", value: t.purpose, aliases: ["Goal", "Purpose of Email"] },
      { name: "Figma Board", value: t.client.figma ?? "", aliases: ["Figma", "Figma Link"] },
      { name: "Copy", value: t.docUrl ?? "", aliases: ["Copy Doc", "Copy Link"] },
      { name: "Client Website", value: t.client.website ?? "", aliases: ["Website"] },
      // Revision Stage stays empty: the team sets it
    ],
    mirror: "email_asana_tasks",
  },
  kaizenRequests: false,
  tools: { request: "create_email_request", update: "update_email_request" },
};
