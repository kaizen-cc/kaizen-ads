import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The version each tab runs, baked in at build time: the UpdateBar compares it with what's live
  env: { APP_VERSION: process.env.VERCEL_GIT_COMMIT_SHA ?? "dev" },
  // Knowledge PDFs are read on the server with pdfjs as it ships (its worker runs in the same process)
  serverExternalPackages: ["pdfjs-dist"],
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
