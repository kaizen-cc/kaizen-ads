import type { MetadataRoute } from "next";

// Lets clients and the team add Kaizen Ads to their phone's home screen.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Kaizen Ads",
    short_name: "Kaizen Ads",
    description: "Review and approve your ads with Kaizen Marketing",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#060606",
    theme_color: "#060606",
    icons: [
      { src: "/icon.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/apple-icon.png", sizes: "180x180", type: "image/png" },
    ],
  };
}
