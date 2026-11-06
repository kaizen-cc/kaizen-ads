import { notFound } from "next/navigation";
import { LoaderPreview } from "./loader-preview";

// Every loading scene side by side, for checking the logo character without waiting on a real page. Development only.

export default function LoaderPreviewPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <LoaderPreview />;
}
