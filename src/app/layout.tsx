import type { Metadata, Viewport } from "next";
import { Poppins } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";

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
  themeColor: "#060606",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${poppins.variable} ${flexa.variable} h-full antialiased`}>
      <body className="min-h-full font-sans">{children}</body>
    </html>
  );
}
