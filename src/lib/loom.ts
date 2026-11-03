import "server-only";

// Loom videos into the knowledge base. Loom has no public API for reading a video's transcript, so this does what a
// share link allows: the video's title and description from Loom's oEmbed, and its transcript from the same endpoint
// the share page itself uses (only for videos shared publicly, or to anyone with the link, with captions generated).
// When the transcript can't be read (a private video, captions off, or Loom changing that endpoint), the caller falls
// back to reading the share page with web research, and says so.

/** A Loom share or embed link → its video id */
export function loomId(url: string) {
  const m = url.match(/loom\.com\/(?:share|embed|v)\/([a-f0-9]{16,40})/i);
  return m ? m[1] : null;
}

export const isLoom = (url: string | null | undefined) => Boolean(url && loomId(url));

type Phrase = { ts?: number; value?: string; text?: string };

/** Title, description and the transcript text of a Loom video; transcript null when Loom won't give it */
export async function readLoom(url: string): Promise<{ title: string | null; description: string | null; transcript: string | null }> {
  const id = loomId(url);
  if (!id) return { title: null, description: null, transcript: null };
  const share = `https://www.loom.com/share/${id}`;
  let title: string | null = null;
  let description: string | null = null;
  try {
    const r = await fetch(`https://www.loom.com/v1/oembed?url=${encodeURIComponent(share)}`, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (r.ok) {
      const j = (await r.json()) as { title?: string; description?: string };
      title = j.title ?? null;
      description = j.description ?? null;
    }
  } catch {}
  let transcript: string | null = null;
  try {
    const r = await fetch("https://www.loom.com/graphql", {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
      headers: { "content-type": "application/json", "apollographql-client-name": "web", "x-loom-request-source": "loom_web" },
      body: JSON.stringify({
        operationName: "FetchVideoTranscript",
        variables: { videoId: id, password: null },
        query: "query FetchVideoTranscript($videoId: ID!, $password: String) { fetchVideoTranscript(videoId: $videoId, password: $password) { ... on VideoTranscriptDetails { id source_url captions_source_url } ... on GenericError { message } } }",
      }),
    });
    const j = (await r.json().catch(() => null)) as { data?: { fetchVideoTranscript?: { source_url?: string | null } } } | null;
    const src = j?.data?.fetchVideoTranscript?.source_url;
    if (src) {
      const t = await fetch(src, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
      if (t.ok) {
        const body = (await t.json().catch(() => null)) as { phrases?: Phrase[] } | null;
        const words = (body?.phrases ?? []).map((p) => (p.value ?? p.text ?? "").trim()).filter(Boolean);
        if (words.length) transcript = words.join(" ");
      }
    }
  } catch {}
  return { title, description, transcript };
}
