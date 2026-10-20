// Where to send someone after connecting: only a path inside Kaizen Ads, never another site
export function safeNext(next: string | null | undefined) {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/reports";
}

export function withParams(origin: string, path: string, params: Record<string, string>) {
  const to = new URL(path, origin);
  for (const [k, v] of Object.entries(params)) to.searchParams.set(k, v);
  return to.toString();
}
