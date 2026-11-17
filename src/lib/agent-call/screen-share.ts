import { fitWithin } from "./call-context";

// Sharing the screen on a call, in the browser: the browser's own picker (a tab, a window or the whole screen; it can't
// be skipped or chosen for the person), and a still frame of what's shared whenever the agent takes a look, scaled to
// about 1600 pixels on its longer side and saved as a JPEG. Phones can't share a screen from a browser (iPhones not at
// all, Android barely), so they get the upload panel for a screenshot instead.

/** Whether this browser can share a screen (computers with getDisplayMedia; never phones or tablets) */
export function canShareScreen(): boolean {
  if (typeof navigator === "undefined" || typeof window === "undefined") return false;
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== "function") return false;
  const ua = navigator.userAgent;
  const touchMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  return !/Android|iPhone|iPad|iPod|Mobile/i.test(ua) && !touchMac;
}

/** Asks to share a screen (call it from a tap: browsers only open the picker then). Video only, a few frames a second */
export function startScreenShare(): Promise<MediaStream> {
  return navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 5, max: 10 } }, audio: false });
}

/** Stops sharing (every track, so the browser's own sharing bar goes away) */
export function stopScreenShare(stream: MediaStream | null) {
  stream?.getTracks().forEach((t) => t.stop());
}

/** A still of what's shared right now, as a JPEG at most `max` pixels on its longer side; null when sharing stopped */
export async function grabFrame(stream: MediaStream, max = 1600): Promise<Blob | null> {
  const track = stream.getVideoTracks()[0];
  if (!track || track.readyState !== "live") return null;
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  try {
    await video.play();
    if (!video.videoWidth)
      await new Promise<void>((resolve) => {
        video.addEventListener("loadeddata", () => resolve(), { once: true });
        setTimeout(resolve, 3000);
      });
    if (!video.videoWidth) return null;
    const { width, height } = fitWithin(video.videoWidth, video.videoHeight, max);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext("2d");
    if (!g) return null;
    g.drawImage(video, 0, 0, width, height);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", 0.82));
  } catch {
    return null;
  } finally {
    video.pause();
    video.srcObject = null;
  }
}
