import { ImageResponse } from "next/og";

// The picture a client's portal messages carry in Slack when they have no photo: their initials on Kaizen red.
// Public (Slack fetches it), and it only ever draws up to two letters.
export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("i") ?? "";
  const initials = raw.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2).toUpperCase() || "?";
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#b21e2c", color: "#ffffff", fontSize: 88, fontWeight: 700, letterSpacing: -2 }}>
        {initials}
      </div>
    ),
    { width: 192, height: 192, headers: { "cache-control": "public, max-age=31536000, immutable" } },
  );
}
