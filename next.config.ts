import type { NextConfig } from "next";
import { dayLogicHash } from "./day-logic-hash.mjs";

const nextConfig: NextConfig = {
  // The version each tab runs, baked in at build time: the UpdateBar compares it with what's live
  // DAY_LOGIC_HASH: the fingerprint of the code that builds everyone's day (./day-logic-hash.mjs); a saved day stamped
  // with another one is rebuilt on its next look
  env: { APP_VERSION: process.env.VERCEL_GIT_COMMIT_SHA ?? "dev", DAY_LOGIC_HASH: dayLogicHash().hash },
  // Knowledge PDFs are read on the server with pdfjs as it ships (its worker runs in the same process). The email report's
  // campaign cards draw the top of each email in a headless Chrome (src/lib/channel-reports/email-shots.ts): puppeteer
  // and Vercel's packed Chromium are loaded as they ship, never bundled
  serverExternalPackages: ["pdfjs-dist", "puppeteer-core", "@sparticuz/chromium"],
  // Chromium's packed binary is read from disk, so the trace can't see it: added to the functions that draft or render an
  // email report (the report API, the client's PDF link, the reports pages' actions and the schedule that drafts them).
  // About 70 MB packed per function, inside Vercel's 250 MB limit
  outputFileTracingIncludes: Object.fromEntries(["/api/reports/**", "/r/\\[token\\]/pdf", "/reports", "/reports/**", "/api/cron/context"].map((route) => [route, ["./node_modules/@sparticuz/chromium/bin/**"]])),
  // Keep a visited tab in the browser for 30 seconds, so switching back and forth is instant.
  // Saving anything (server actions call revalidatePath) refreshes it right away.
  experimental: {
    staleTimes: { dynamic: 30 },
    // An Ads Manager export attached in a report's chat (src/app/(team)/reports/actions.ts uploadReportCsv, up to 4 MB
    // of text) goes up in one action
    serverActions: { bodySizeLimit: "4.5mb" },
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
