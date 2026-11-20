import "server-only";
import type { ChatTool, ToolCtx } from "./tools";
import { seesAccountNumbers } from "@/lib/ai-access-core";
import { PRIVATE_WHILE_VIEWING, textAnswer, viewingAs } from "./my-tools";
import { beforeAfter, describeWrite, driveQuery, eventRow, gmailRow, klaviyoPathOk, scopeHelp, short, type KlaviyoMethod } from "./workspace-core";

// Kaizen AI working where the team works (owner, Nov 19 2026), for everyone and in every chat (the assistant gets every
// chat tool too): their own Gmail, Drive and Calendar, read as them through the company's Google access (no sign-in),
// and hands-on work inside a client's Klaviyo with the key already on file: templates, campaigns and their messages,
// flows, segments, lists, forms, universal content. Reading is free; every change is described first and runs only
// after the person's own yes in this turn; deletes, privacy erasure and account settings never run from a chat; every
// change is logged (klaviyo_ai_changes).

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

async function googleOrHelp<T>(fn: () => Promise<T>, scope: string): Promise<T | { error: string; for_the_admin?: string }> {
  try {
    return await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const help = scopeHelp(msg, scope);
    return { error: help ? "Google hasn't allowed this yet." : `Google didn't answer: ${clip(msg, 200)}`, ...(help ? { for_the_admin: help } : {}) };
  }
}

export function workspaceTools(ctx: ToolCtx): ChatTool[] {
  return [
    // ─── Gmail ─────────────────────────────────────────────────────────────
    {
      name: "search_my_gmail",
      description:
        "Searches the person's own Gmail (as them, read only) with Gmail's search syntax: words, from:, to:, subject:, after:2026/11/01, has:attachment, in:sent… Returns the newest matches (who, subject, date, a snippet, the thread id). Read one whole with read_gmail_thread. Use it whenever they ask about an email they sent or got.",
      input_schema: { type: "object", properties: { query: { type: "string", description: "Gmail search, e.g. from:jason@acme.com after:2026/11/10" }, limit: { type: "integer", minimum: 1, maximum: 20 } }, required: ["query"], additionalProperties: false },
      status: (input) => `Searching your Gmail for ${clip(input.query, 40)}…`,
      run: async (input) => {
        if (viewingAs(ctx)) return { error: PRIVATE_WHILE_VIEWING };
        const { gmailToken, google, googleConfigured } = await import("@/lib/context/google");
        if (!googleConfigured()) return { error: "Google isn't connected to Kaizen OS yet." };
        return googleOrHelp(async () => {
          const token = await gmailToken(ctx.me.email);
          const list = await google<{ messages?: { id: string }[] }>(token, `${GMAIL}/messages`, { q: clip(input.query, 300), maxResults: String(Math.min(20, Number(input.limit) || 10)) });
          // Each one's headers and snippet (metadata only: never the body here)
          const full = await Promise.all((list.messages ?? []).map(async ({ id }) => gmailRow(await google(token, `${GMAIL}/messages/${id}`, { format: "metadata" }))));
          return { found: full.length, emails: full, note: full.length ? "Read one whole with read_gmail_thread (thread_id)." : "Nothing matched: try other words or a wider date." };
        }, "https://www.googleapis.com/auth/gmail.readonly");
      },
    },
    {
      name: "read_gmail_thread",
      description: "Reads one email thread from the person's own Gmail whole (each message: who, when, the text without quoted replies), a part at a time or the passages matching a search. thread_id comes from search_my_gmail.",
      input_schema: { type: "object", properties: { thread_id: { type: "string" }, part: { type: "integer", minimum: 1 }, search: { type: "string" } }, required: ["thread_id"], additionalProperties: false },
      status: () => "Reading the email thread…",
      run: async (input) => {
        if (viewingAs(ctx)) return { error: PRIVATE_WHILE_VIEWING };
        const id = String(input.thread_id ?? "").replace(/[^A-Za-z0-9]/g, "");
        if (!id) return { error: "Which thread? Give a thread_id from search_my_gmail." };
        const { gmailToken, google, plainText, withoutQuotes } = await import("@/lib/context/google");
        return googleOrHelp(async () => {
          const token = await gmailToken(ctx.me.email);
          const t = await google<{ messages?: { id: string; internalDate?: string; payload: Parameters<typeof plainText>[0] & { headers?: { name: string; value: string }[] } }[] }>(token, `${GMAIL}/threads/${id}`, { format: "full" });
          const msgs = (t.messages ?? []).map((m) => {
            const h = (n: string) => m.payload.headers?.find((x) => x.name.toLowerCase() === n)?.value ?? "";
            return `From ${h("from")} to ${h("to")}${h("cc") ? `, cc ${h("cc")}` : ""} (${m.internalDate ? new Date(Number(m.internalDate)).toISOString().slice(0, 16).replace("T", " ") : h("date")})\nSubject: ${h("subject")}\n${withoutQuotes(plainText(m.payload) ?? "").trim()}`;
          });
          return { messages: msgs.length, link: `https://mail.google.com/mail/u/${ctx.me.email}/#all/${id}`, ...textAnswer(msgs.join("\n\n---\n\n") || "(empty)", input) };
        }, "https://www.googleapis.com/auth/gmail.readonly");
      },
    },

    // ─── Drive ─────────────────────────────────────────────────────────────
    {
      name: "search_my_drive",
      description: "Searches the Google Drive the person can open (their own files, files shared with them, shared drives) by name and by the text inside, newest first: name, type, last change, link. Open one with read_google_file (its link). Use it when they ask for a doc, sheet, deck or file without a link.",
      input_schema: { type: "object", properties: { words: { type: "string", description: "Words in the file's name or text" }, limit: { type: "integer", minimum: 1, maximum: 25 } }, required: ["words"], additionalProperties: false },
      status: (input) => `Searching your Drive for ${clip(input.words, 40)}…`,
      run: async (input) => {
        if (viewingAs(ctx)) return { error: PRIVATE_WHILE_VIEWING };
        const words = clip(input.words, 120);
        if (!words) return { error: "What should I look for?" };
        const { googleDriveToken, google } = await import("@/lib/context/google");
        return googleOrHelp(async () => {
          const token = await googleDriveToken(ctx.me.email);
          const r = await google<{ files?: { id: string; name: string; mimeType: string; modifiedTime?: string; webViewLink?: string; owners?: { displayName?: string }[] }[] }>(token, "https://www.googleapis.com/drive/v3/files", {
            q: driveQuery(words),
            pageSize: String(Math.min(25, Number(input.limit) || 12)),
            orderBy: "modifiedTime desc",
            fields: "files(id,name,mimeType,modifiedTime,webViewLink,owners(displayName))",
            supportsAllDrives: "true",
            includeItemsFromAllDrives: "true",
            corpora: "allDrives",
          });
          const files = (r.files ?? []).map((f) => ({ name: f.name, type: f.mimeType.replace("application/vnd.google-apps.", "google ").replace("application/", ""), changed: f.modifiedTime?.slice(0, 10) ?? null, owner: f.owners?.[0]?.displayName ?? null, link: f.webViewLink ?? `https://drive.google.com/open?id=${f.id}` }));
          return { found: files.length, files, note: files.length ? "Open one with read_google_file (its link)." : "Nothing matched: try fewer or other words." };
        }, "https://www.googleapis.com/auth/drive.readonly");
      },
    },

    // ─── Calendar ──────────────────────────────────────────────────────────
    {
      name: "my_calendar",
      description: "Reads the person's own Google Calendar (as them, read only) between two days (default: today and the next 7 days): each event's title, time, who's invited, where (Meet link) and notes. Use it for 'what's on my calendar', 'when am I meeting X', prepping for a call.",
      input_schema: { type: "object", properties: { from: { type: "string", description: "YYYY-MM-DD, default today" }, to: { type: "string", description: "YYYY-MM-DD, default a week later" }, search: { type: "string", description: "Words in the event (a client, a person)" } }, additionalProperties: false },
      status: () => "Reading your calendar…",
      run: async (input) => {
        if (viewingAs(ctx)) return { error: PRIVATE_WHILE_VIEWING };
        const day = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
        const from = day(input.from) ?? new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
        const to = day(input.to) ?? new Date(Date.parse(`${from}T12:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
        const { googleCalendarToken, google, CALENDAR_SCOPE } = await import("@/lib/context/google");
        return googleOrHelp(async () => {
          const token = await googleCalendarToken(ctx.me.email);
          const r = await google<{ items?: Parameters<typeof eventRow>[0][] }>(token, "https://www.googleapis.com/calendar/v3/calendars/primary/events", {
            timeMin: `${from}T00:00:00-05:00`,
            timeMax: `${to}T23:59:59-05:00`,
            singleEvents: "true",
            orderBy: "startTime",
            maxResults: "100",
            ...(clip(input.search, 80) ? { q: clip(input.search, 80) } : {}),
          });
          const events = (r.items ?? []).map(eventRow);
          return { from, to, count: events.length, events };
        }, CALENDAR_SCOPE);
      },
    },

    // ─── Klaviyo, hands-on ─────────────────────────────────────────────────
    {
      name: "klaviyo_account",
      description: [
        "Works inside a client's own Klaviyo account through its API (JSON:API, the current revision), with the key Kaizen OS already holds: read anything (templates with their HTML, campaigns and their messages, flows with their actions and messages, segments, lists, forms, universal content, images, metrics), and change it (edit a template's HTML, copy and links; create a template; create or update a campaign or a campaign message, assign a template; create or update a flow, its messages and status; segments, lists, universal content; upload an image).",
        "method GET to read; POST to create or run a job; PATCH to change one object. path is the API path (/api/templates/, /api/templates/<id>/, /api/campaigns/?filter=equals(messages.channel,'email'), /api/campaign-messages/<id>/?include=template, /api/flows/<id>/?include=flow-actions, /api/flow-messages/<id>/…); body is the JSON:API document for a write.",
        "A write never runs on the first call: call it once without confirmed to get the exact change (and, for a PATCH, the current values next to the new ones), show the person what will change in plain words (which object, what changes) and ask 'shall I?'; call again with the same request and confirmed: true only after their yes. Edit the HTML you read: change only what they asked, keep the rest exactly. Deleting anything, privacy erasure, suppressions and account settings never run from here. Sending or scheduling a campaign goes to the client's customers: say so plainly before asking.",
      ].join(" "),
      input_schema: {
        type: "object",
        properties: {
          client: { type: "string", description: "The client (not needed in a chat pinned to one)" },
          method: { type: "string", enum: ["GET", "POST", "PATCH"] },
          path: { type: "string", description: "The API path, starting with /api/" },
          body: { type: "object", description: "The JSON:API body for POST or PATCH", additionalProperties: true },
          confirmed: { type: "boolean", description: "true only on the second call, after the person said yes to this exact change" },
          part: { type: "integer", minimum: 1, description: "A long answer (a template's HTML) a part at a time" },
        },
        required: ["method", "path"],
        additionalProperties: false,
      },
      status: (input, client) => (input.method === "GET" ? `Reading ${client ?? "the client"}'s Klaviyo…` : input.confirmed ? `Changing ${client ?? "the client"}'s Klaviyo…` : `Checking the change in ${client ?? "the client"}'s Klaviyo…`),
      run: async (input) => {
        const method = (["GET", "POST", "PATCH"].includes(String(input.method)) ? input.method : "GET") as KlaviyoMethod;
        const checked = klaviyoPathOk(input.path, method);
        if (!checked.ok) return { error: checked.why };
        // Klaviyo's metrics and reports are account numbers, which makers never see
        if (!seesAccountNumbers(ctx.me) && /metric|report|aggregate/i.test(checked.path)) return { error: "Account numbers aren't part of your view." };
        const { clientNamedForTools } = await import("./tools");
        const c = await clientNamedForTools(ctx, input);
        if (method !== "GET") {
          const may = await (await import("@/lib/line-actions-server")).mayActOn(ctx.admin, { id: ctx.me.id, role: ctx.me.role, isExec: ctx.me.isExec }, c.id, "email", "change this client's Klaviyo");
          if (!may.ok) return { error: `${may.reason} Everyone can still read it.` };
        }
        const { clientKlaviyoKey } = await import("@/lib/klaviyo/store");
        const k = await clientKlaviyoKey(ctx.admin, c.id);
        if ("error" in k) return { error: k.error };
        const { klaviyoRequest } = await import("@/lib/klaviyo/api");
        const ask = async (m: KlaviyoMethod, p: string, b?: unknown) => {
          try {
            return { ok: true as const, json: await klaviyoRequest(k.key, m, p, b) };
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const status = (e as { status?: number | null }).status ?? null;
            return { ok: false as const, error: status === 403 ? "This client's Klaviyo key is read only: a key with write access is needed for changes (replace it on the client's Klaviyo card with a Full Access private key)." : clip(msg, 400) };
          }
        };

        if (method === "GET") {
          const r = await ask("GET", checked.path);
          if (!r.ok) return { error: r.error };
          const text = JSON.stringify(r.json, null, 1);
          return { client: c.name, account: k.account, ...(text.length > 20_000 ? textAnswer(text, input) : { data: r.json }) };
        }

        const body = input.body && typeof input.body === "object" ? input.body : null;
        if (!body) return { error: "A change needs its JSON:API body (data: { type, attributes… })." };
        const what = describeWrite(method, checked.path, body);
        const { saidYes } = await import("@/lib/assistant/core");
        if (input.confirmed !== true || !saidYes(ctx.said ?? "")) {
          const before = method === "PATCH" ? await ask("GET", checked.path.split("?")[0]) : null;
          return {
            needs_their_yes: true,
            client: c.name,
            account: k.account,
            change: what,
            ...(before?.ok ? { before_and_after: beforeAfter(before.json, body) } : {}),
            note: "Nothing has changed yet. Tell them in plain words exactly what this changes and ask 'shall I?'. Call again with the same method, path and body and confirmed: true only after their yes.",
          };
        }
        const r = await ask(method, checked.path, body);
        await ctx.admin
          .from("klaviyo_ai_changes")
          .insert({ client_id: c.id, profile_id: ctx.me.id, method, path: checked.path.slice(0, 500), change: what.slice(0, 1000), body, ok: r.ok, error: r.ok ? null : r.error, thread_id: ctx.threadId ?? null })
          .then(() => undefined, () => undefined);
        if (!r.ok) return { done: false, error: r.error };
        const data = (r.json as { data?: { id?: string; type?: string; attributes?: Record<string, unknown> } } | null)?.data;
        return { done: true, client: c.name, change: what, id: data?.id ?? null, type: data?.type ?? null, name: short(data?.attributes?.name ?? null, 120), note: "It's done in Klaviyo. Say what changed in a sentence, with where to see it." };
      },
    },
  ];
}
