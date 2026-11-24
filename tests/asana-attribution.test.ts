import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { asanaForPerson, asanaWrite } from "@/lib/asana";
import { ASANA_CONNECT_SAY, isAsanaConnectNeeded, isStoryPath, KAIZEN_OS_STAMP, stampSystemStory } from "@/lib/asana-connect";
import { applyPreview, feedbackCommentHtml, feedbackCommentText, htmlMessage, linksIn, plainMessage, sourceOf, type Feedback } from "@/lib/direction-feedback-core";

// Owner + Head of Email, Nov 24 2026: comments from "Apply all" were posted as the shared Asana account, not the person
// who clicked. Every Asana write a person triggers goes out with their own token (or asks them to connect); writes
// nobody asked for say "Posted by Kaizen OS". And the client's full feedback, links and files reach the comment.

describe("Asana writes go out as the person who asked", () => {
  const calls: { url: string; auth: string | null; body: unknown }[] = [];
  const stub = () =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, auth: new Headers(init.headers).get("authorization"), body: init.body ? JSON.parse(String(init.body)) : null });
        return new Response(JSON.stringify({ data: { gid: "1" } }), { status: 200 });
      }),
    );
  afterEach(() => {
    calls.length = 0;
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("a person without their own Asana is asked to connect: nothing is written as someone else", async () => {
    stub();
    vi.stubEnv("ASANA_TOKEN", "shared");
    const e = await asanaForPerson("p1", null, () => asanaWrite("/tasks/9/stories", { text: "hi" })).catch((x) => x);
    expect(isAsanaConnectNeeded(e)).toBe(true);
    expect((e as Error).message).toBe(ASANA_CONNECT_SAY);
    expect(calls).toHaveLength(0);
  });

  it("a person with their own Asana writes with their token, no stamp", async () => {
    stub();
    vi.stubEnv("ASANA_TOKEN", "shared");
    await asanaForPerson("p1", "mel-token", () => asanaWrite("/tasks/9/stories", { text: "Change the footer" }));
    expect(calls[0].auth).toBe("Bearer mel-token");
    expect(calls[0].body).toEqual({ data: { text: "Change the footer" } });
  });

  it("a system write uses the shared connection and says Posted by Kaizen OS", async () => {
    stub();
    vi.stubEnv("ASANA_TOKEN", "shared");
    await asanaWrite("/tasks/9/stories", { text: "Closed: the client confirmed it." });
    expect(calls[0].auth).toBe("Bearer shared");
    expect((calls[0].body as { data: { text: string } }).data.text).toBe(`Closed: the client confirmed it.\n\n${KAIZEN_OS_STAMP}`);
    expect(stampSystemStory({ html_text: "<body>Hi</body>" }).html_text).toBe(`<body>Hi\n<em>${KAIZEN_OS_STAMP}</em></body>`);
    expect(isStoryPath("/tasks/123/stories")).toBe(true);
    expect(isStoryPath("/tasks/123")).toBe(false);
  });

  // Every file that writes to Asana, sorted: work a person triggers runs inside asanaAsPerson (the file wraps it, or
  // its only callers do); system work has no person and is stamped automatically
  const WRITERS: Record<string, { by: "person" | "system" | "core"; wraps: boolean; why: string }> = {
    "src/lib/asana.ts": { by: "core", wraps: false, why: "the write functions themselves (writeAs enforces the rule)" },
    "src/app/(team)/board/actions.ts": { by: "person", wraps: true, why: "dragging an Asana task on the Creative board" },
    "src/lib/asana-email.ts": { by: "person", wraps: true, why: "migration's link back (as them); moves run inside the caller's asanaAsPerson (email board drag, direction)" },
    "src/lib/asana-live.ts": { by: "person", wraps: false, why: "the Asana task sheet and card actions: every caller (src/app/(team)/asana-task-actions.ts asMe) wraps it" },
    "src/lib/asana-request.ts": { by: "person", wraps: true, why: "a creative request sent to Asana, as the sender" },
    "src/lib/brief-drafting.ts": { by: "person", wraps: true, why: "a swap closing an Asana task" },
    "src/lib/deliverables/server.ts": { by: "person", wraps: true, why: "the assistant's and the form's requests (updateRequest's only caller wraps it)" },
    "src/lib/direction-changes.ts": { by: "person", wraps: true, why: "Apply all on a client's feedback, and its Undo" },
    "src/lib/direction-feedback.ts": { by: "person", wraps: false, why: "files attached inside actOnTasks' asanaAsPerson" },
    "src/lib/done-check.ts": { by: "system", wraps: true, why: "the evidence sweep's auto-close is the system's (stamped); Reopen is the person's and wraps" },
    "src/lib/intake-form.ts": { by: "system", wraps: false, why: "a task from the Zapier intake form, nobody in the OS asked" },
  };
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : /\.tsx?$/.test(f) ? [join(dir, f).replace(/\\/g, "/")] : []));

  it("every Asana write site is sorted, and person sites run as the person", () => {
    const writers = files("src").filter((f) => /\b(asanaWrite|asanaUpdate|asanaAttach|asanaRemove|createAsanaTask)\b/.test(readFileSync(f, "utf8")));
    expect(writers.filter((f) => !WRITERS[f]), "new Asana write sites: sort them in tests/asana-attribution.test.ts (person ones inside asanaAsPerson)").toEqual([]);
    for (const [f, w] of Object.entries(WRITERS)) if (w.wraps) expect(readFileSync(f, "utf8"), f).toContain("asanaAsPerson");
    expect(readFileSync("src/app/(team)/asana-task-actions.ts", "utf8")).toContain("asanaAsPerson");
    expect(readFileSync("src/app/(team)/board/email/actions.ts", "utf8")).toContain("asanaAsPerson");
    expect(readFileSync("src/lib/deliverables/tools.ts", "utf8")).toContain("asanaAsPerson");
    // Nobody falls back to the shared token for a write any more
    expect(readFileSync("src/app/(team)/asana-task-actions.ts", "utf8")).not.toContain("withMyAsana(");
  });
});

const BRITT: Feedback = {
  author: "Britt Engler",
  at: "2026-11-24T18:14:15.157Z",
  where: "Slack",
  text: "Hey Mel, we prefer the layout in the CRM folder, particularly the <https://drive.google.com/drive/folders/18Bx?usp=drive_link|Window 10 Assets> and <https://drive.google.com/drive/folders/1--0d?usp=drive_link|The New Mac Welcome>. Adobe files are *included* & ready.",
  permalink: "https://slack.com/archives/C0CGC6E24NQ/p1795544055157809",
  files: [{ name: "footer.png", url: "https://kaizen.slack.com/files/U1/F1/footer.png", size: 2000, mime: "image/png" }],
};

describe("the client's full feedback reaches the Asana comment", () => {
  it("reads every link in the message", () => {
    expect(linksIn(BRITT.text)).toEqual([
      { url: "https://drive.google.com/drive/folders/18Bx?usp=drive_link", label: "Window 10 Assets" },
      { url: "https://drive.google.com/drive/folders/1--0d?usp=drive_link", label: "The New Mac Welcome" },
    ]);
    expect(linksIn("see https://www.loom.com/share/abc. thanks")).toEqual([{ url: "https://www.loom.com/share/abc", label: "https://www.loom.com/share/abc" }]);
    expect(plainMessage("<https://x.com|X> and <@U12|britt>")).toBe("X (https://x.com) and @britt");
  });

  it("quotes it whole with clickable links, who, when, files and the permalink", () => {
    const html = feedbackCommentHtml("The client asked for a revision: use the CRM layouts.\nChange the design: adapt what's made.", BRITT, [{ name: "footer.png", url: null }], "Moved back to Copy Review from Kaizen OS.");
    expect(html).toMatch(/^<body><strong>The client asked for a revision/);
    expect(html).toContain('<a href="https://drive.google.com/drive/folders/18Bx?usp=drive_link">Window 10 Assets</a>');
    expect(html).toContain('<a href="https://drive.google.com/drive/folders/1--0d?usp=drive_link">The New Mac Welcome</a>');
    expect(html).toContain("Britt Engler in Slack, Nov 24, 2026");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<strong>included</strong> &amp; ready");
    expect(html).toContain("footer.png (attached to this task)");
    expect(html).toContain('<a href="https://slack.com/archives/C0CGC6E24NQ/p1795544055157809">Open the message in Slack</a>');
    expect(html).toContain("<em>Moved back to Copy Review from Kaizen OS.</em>");
    expect(htmlMessage("<script>")).toBe("&lt;script&gt;");
    const text = feedbackCommentText("Change the design.", BRITT);
    expect(text).toContain("Window 10 Assets: https://drive.google.com/drive/folders/18Bx?usp=drive_link");
    expect(text).toContain("Message: https://slack.com/archives/C0CGC6E24NQ/p1795544055157809");
    expect(sourceOf("slack_external:C0CGC6E24NQ:1795544055.157809#0")).toEqual({ kind: "context", source: "slack_external", externalId: "C0CGC6E24NQ:1795544055.157809" });
  });

  it("says what Apply all will do before it happens", () => {
    expect(applyPreview([{ title: "Welcome 1", asana: true, how: "send_back", to: "Copy Review" }, { title: "Welcome 2", asana: true, how: "send_back", to: "Copy Review" }])).toEqual([
      "Post 2 comments on these Asana tasks, as you, with the client's full feedback, links and files",
      "Send them back to Copy Review for review",
      "Nothing goes to the client",
    ]);
  });
});
