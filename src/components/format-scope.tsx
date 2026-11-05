"use client";

import { useCreativeFormats } from "@/components/creative-formats-provider";
import { formatsPhrase, seesAllFormats } from "@/lib/creative-formats";

/** A quiet line on a library or a list of ideas, for someone who only sees their own formats: what's shown */
export function FormatScope({ className = "" }: { className?: string }) {
  const allowed = useCreativeFormats();
  if (seesAllFormats(allowed)) return null;
  const phrase = formatsPhrase(allowed);
  return <span className={`inline-flex items-center rounded-full border border-line px-2.5 py-0.5 text-[11.5px] text-muted ${className}`}>{`${phrase[0].toUpperCase()}${phrase.slice(1)} only`}</span>;
}
