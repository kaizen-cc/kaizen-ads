import type { Metadata, Viewport } from "next";
import { Poppins } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";
import { ErrorListener } from "@/components/error-listener";
import { UpdateBar } from "@/components/update-bar";

const poppins = Poppins({
  variable: "--font-poppins",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

// GT Flexa is a TRIAL file (same as Kaizen Track) — swap for the licensed webfont before go-live.
const flexa = localFont({
  variable: "--font-flexa",
  src: "./fonts/GT-Flexa-Regular-Trial.woff2",
  display: "swap",
});

// Osake is the display face — subset to the letters of the "ads" wordmark only (same approach as Track)
const osake = localFont({
  variable: "--font-osake",
  src: "./fonts/Osake-ads.woff2",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Kaizen Ads",
  description: "Creative requests, approvals and launches with Kaizen Marketing",
  applicationName: "Kaizen Ads",
  appleWebApp: { capable: true, title: "Kaizen Ads", statusBarStyle: "black-translucent" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f5f4" },
    { media: "(prefers-color-scheme: dark)", color: "#060606" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning className={`${poppins.variable} ${flexa.variable} ${osake.variable} h-full antialiased`}>
      <head>
        {/* The person's light/dark choice, applied before anything paints (see src/components/theme-switch.tsx) */}
        <script dangerouslySetInnerHTML={{ __html: `try{var t=localStorage.getItem("kz-theme");if(t==="light"||t==="dark"||t==="system")document.documentElement.dataset.theme=t}catch(e){}` }} />
      </head>
      <body className="min-h-full font-sans">
        {children}
        {/* A newer version is live: offer a refresh. Errors in the browser get reported. */}
        <UpdateBar />
        <ErrorListener />
      </body>
    </html>
  );
}
