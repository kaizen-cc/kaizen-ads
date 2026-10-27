"use client";

import { createClient } from "@/lib/supabase/client";
import { captureFrames, extractAudio } from "@/lib/uploads/video-prep";
import { saveVideoPrep, videoPrepList } from "./review-actions";

// Before an AI review: any video on the ticket not yet captured is watched here in the browser (frames through the
// whole video, and its audio), saved beside the video, so the review sees all of it. Done once per video version.

export async function prepareVideos(requestId: string, say: (label: string) => void): Promise<string | null> {
  const list = await videoPrepList(requestId);
  if (!list.length) return null;
  const supabase = createClient();
  let problem: string | null = null;
  for (const [i, v] of list.entries()) {
    const which = list.length > 1 ? ` ${i + 1} of ${list.length}` : "";
    try {
      if (!v.url) throw new Error("no link to the video");
      say(`Watching the video${which}`);
      const frames = await captureFrames(v.url, (done, total) => say(`Watching the video${which}: ${Math.round((done / total) * 100)}%`));
      say(`Saving the frames${which}`);
      const saved: { ms: number; path: string }[] = [];
      for (let n = 0; n < frames.length; n += 6) {
        await Promise.all(
          frames.slice(n, n + 6).map(async (f) => {
            const path = `${v.path}.frames/${String(f.ms).padStart(7, "0")}.jpg`;
            const { error } = await supabase.storage.from("creative").upload(path, f.blob, { contentType: "image/jpeg", upsert: true });
            if (!error) saved.push({ ms: f.ms, path });
          }),
        );
      }
      say(`Listening to the video${which}`);
      const wav = await extractAudio(v.url);
      let audioPath: string | null = null;
      if (wav) {
        const path = `${v.path}.audio.wav`;
        const { error } = await supabase.storage.from("creative").upload(path, wav, { contentType: "audio/wav", upsert: true });
        if (!error) audioPath = path;
      }
      if (!saved.length) throw new Error("no frames could be captured");
      const r = await saveVideoPrep(v.fileId, saved, audioPath);
      if (!r.ok) throw new Error(r.error);
    } catch (e) {
      // The review still runs on the cover frame; say why it couldn't watch the whole thing
      problem = `Couldn't watch the video${which} (${e instanceof Error ? e.message : e}); it was reviewed from its cover frame.`;
    }
  }
  say("");
  return problem;
}
