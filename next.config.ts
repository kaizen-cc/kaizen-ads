import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The version each tab runs, baked in at build time: the UpdateBar compares it with what's live
  env: { APP_VERSION: process.env.VERCEL_GIT_COMMIT_SHA ?? "dev" },
  // Keep a visited tab in the browser for 30 seconds, so switching back and forth is instant.
  // Saving anything (server actions call revalidatePath) refreshes it right away.
  experimental: {
    staleTimes: { dynamic: 30 },
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
