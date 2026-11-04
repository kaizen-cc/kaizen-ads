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

/** Seconds as m:ss (or h:mm:ss) */
export const clock = (s: number) => {
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};

/** Title, description and the transcript text of a Loom video; transcript null when Loom won't give it */
export async function readLoom(url: string): Promise<{ title: string | null; description: string | null; transcript: string | null; found: boolean }> {
  const id = loomId(url);
  if (!id) return { title: null, description: null, transcript: null, found: false };
  const share = `https://www.loom.com/share/${id}`;
  let title: string | null = null;
  let description: string | null = null;
  // Loom's oEmbed answers only for a video anyone with the link can watch: a private one isn't found
  let found = false;
  try {
    const r = await fetch(`https://www.loom.com/v1/oembed?url=${encodeURIComponent(share)}`, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (r.ok) {
      found = true;
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
        query: "query FetchVideoTranscript($videoId: ID!, $password: String) { fetchVideoTranscript(videoId: $videoId, password: $password) { ... on VideoTranscriptDetails { source_url captions_source_url } ... on GenericError { message } } }",
      }),
    });
    const j = (await r.json().catch(() => null)) as { data?: { fetchVideoTranscript?: { source_url?: string | null } } } | null;
    const src = j?.data?.fetchVideoTranscript?.source_url;
    if (src) {
      const t = await fetch(src, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
      if (t.ok) {
        const body = (await t.json().catch(() => null)) as { phrases?: Phrase[] } | null;
        // Each phrase (about half a minute) keeps when it was said, so a lesson can point back to its moment
        const words = (body?.phrases ?? []).map((p) => ({ at: p.ts, text: (p.value ?? p.text ?? "").trim() })).filter((p) => p.text);
        if (words.length) transcript = words.map((p) => (typeof p.at === "number" ? `[${clock(p.at)}] ${p.text}` : p.text)).join("\n");
      }
    }
  } catch {}
  return { title, description, transcript, found };
}

// ─── Shared folders ─────────────────────────────────────────────────────────
// A Loom folder shared publicly (anyone with the link) lists its videos the way its share page does: Loom's web
// GraphQL, GetPublicFolderLooms, paged. Its subfolders come from the folder itself when Loom allows it without
// signing in. This is Loom's own unofficial endpoint, so everything here fails soft and says what it saw.

const GQL_HEADERS = { "content-type": "application/json", "apollographql-client-name": "web", "x-loom-request-source": "loom_web" };

async function gql<T>(operationName: string, query: string, variables: Record<string, unknown>): Promise<{ data: T | null; error: string | null }> {
  try {
    const r = await fetch("https://www.loom.com/graphql", { method: "POST", cache: "no-store", signal: AbortSignal.timeout(20_000), headers: GQL_HEADERS, body: JSON.stringify({ operationName, variables, query }) });
    const j = (await r.json().catch(() => null)) as { data?: T; errors?: { message?: string }[] } | null;
    if (!j) return { data: null, error: `Loom answered ${r.status}` };
    return { data: j.data ?? null, error: j.errors?.length ? (j.errors[0].message ?? "Loom error") : null };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : "Loom didn't answer" };
  }
}

const FOLDER_LOOMS = `query GetPublicFolderLooms($limit: Int!, $cursor: String, $folderId: String!) { getPublicFolderLooms { __typename ... on GetPublicFolderLoomsPayload { videos(first: $limit, after: $cursor, folderId: $folderId) { edges { cursor node { id name visibility } } pageInfo { endCursor hasNextPage } } } ... on Error { message } } }`;
const FOLDER_INFO = `query GetLoomFolder($id: ID!) { folder(id: $id) { id name isPublic totalNestedVideos sub_folders { id name isPublic } } }`;

export type LoomFolderVideo = { id: string; url: string; title: string | null; folder: string | null };

/**
 * Every video in a shared folder (and its subfolders Loom shows without signing in, a few levels down), paged 50 at a
 * time. `readable` false means Loom listed nothing: the folder is private, empty, the link is wrong, or Loom changed it.
 */
export async function listLoomFolder(folderId: string, opts: { maxVideos?: number; depth?: number } = {}): Promise<{ name: string | null; videos: LoomFolderVideo[]; readable: boolean; error: string | null; subfolders: number }> {
  const max = opts.maxVideos ?? 5000;
  const videos: LoomFolderVideo[] = [];
  const seen = new Set<string>();
  let error: string | null = null;
  let subfolders = 0;
  let rootName: string | null = null;
  type Payload = { getPublicFolderLooms?: { __typename?: string; message?: string; videos?: { edges?: { node?: { id?: string; name?: string } }[]; pageInfo?: { endCursor?: string | null; hasNextPage?: boolean } } } };
  type Info = { folder?: { name?: string; sub_folders?: { id?: string; name?: string }[] } };
  const walk = async (id: string, name: string | null, depth: number) => {
    let cursor: string | null = null;
    for (let page = 0; page < 200 && videos.length < max; page++) {
      const res: { data: Payload | null; error: string | null } = await gql<Payload>("GetPublicFolderLooms", FOLDER_LOOMS, { limit: 50, cursor, folderId: id });
      const e = res.error;
      const p: Payload["getPublicFolderLooms"] = res.data?.getPublicFolderLooms;
      if (e || !p || p.__typename !== "GetPublicFolderLoomsPayload") {
        error ??= e ?? p?.message ?? "Loom didn't list the folder";
        break;
      }
      for (const edge of p.videos?.edges ?? []) {
        const vid = edge.node?.id?.toLowerCase();
        if (!vid || seen.has(vid)) continue;
        seen.add(vid);
        videos.push({ id: vid, url: `https://www.loom.com/share/${vid}`, title: edge.node?.name ?? null, folder: name });
      }
      cursor = p.videos?.pageInfo?.endCursor ?? null;
      if (!p.videos?.pageInfo?.hasNextPage || !cursor) break;
    }
    // Subfolders: only when Loom shows the folder without signing in (a refusal just means this folder's own videos)
    if (depth >= (opts.depth ?? 3)) return;
    const { data } = await gql<Info>("GetLoomFolder", FOLDER_INFO, { id });
    if (depth === 0) rootName = data?.folder?.name ?? null;
    for (const sub of data?.folder?.sub_folders ?? []) {
      if (!sub.id || videos.length >= max) continue;
      subfolders++;
      await walk(sub.id, sub.name ?? null, depth + 1);
    }
  };
  await walk(folderId, null, 0);
  return { name: rootName, videos, readable: videos.length > 0, error, subfolders };
}
