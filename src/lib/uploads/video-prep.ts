// A video turned into what the AI review can read, in the browser (no video processing on the server): frames through
// the whole video (four a second over the 3-second hook, then one a second, plus a frame at each scene change) and the
// audio as 16 kHz mono WAV for transcription.

export type CapturedFrame = { ms: number; blob: Blob };

const SIDE = 768;
const MAX = 60;

function seek(v: HTMLVideoElement, s: number) {
  return new Promise<void>((resolve, reject) => {
    const done = () => (v.removeEventListener("seeked", done), resolve());
    v.addEventListener("seeked", done);
    v.addEventListener("error", () => reject(new Error("The video couldn't be read")), { once: true });
    v.currentTime = Math.min(s, Math.max(0, v.duration - 0.05));
  });
}

/** How different two small greyscale frames are (0–255): a big jump is a scene change. */
function diff(a: Uint8ClampedArray, b: Uint8ClampedArray) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) sum += Math.abs((a[i] + a[i + 1] + a[i + 2]) / 3 - (b[i] + b[i + 1] + b[i + 2]) / 3);
  return sum / (a.length / 4);
}

export async function captureFrames(url: string, onProgress?: (done: number, total: number) => void): Promise<CapturedFrame[]> {
  const v = document.createElement("video");
  v.crossOrigin = "anonymous";
  v.muted = true;
  v.preload = "auto";
  v.playsInline = true;
  v.src = url;
  await new Promise<void>((resolve, reject) => {
    v.onloadeddata = () => resolve();
    v.onerror = () => reject(new Error("The video couldn't be opened"));
  });
  const dur = v.duration || 0;
  const scale = Math.min(1, SIDE / Math.max(v.videoWidth, v.videoHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(v.videoWidth * scale);
  canvas.height = Math.round(v.videoHeight * scale);
  const ctx = canvas.getContext("2d")!;
  const tiny = document.createElement("canvas");
  tiny.width = tiny.height = 24;
  const tctx = tiny.getContext("2d", { willReadFrequently: true })!;

  // The hook densely, then about one a second (spread out further for long videos)
  const times: number[] = [];
  for (let t = 0; t < Math.min(3, dur); t += 0.25) times.push(t);
  const step = Math.max(1, (dur - 3) / 40);
  for (let t = 3; t < dur; t += step) times.push(t);
  if (dur > 0.5) times.push(Math.max(0, dur - 0.1)); // the end card

  const out: CapturedFrame[] = [];
  let prev: Uint8ClampedArray | null = null;
  const grab = async (t: number) => {
    await seek(v, t);
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    tctx.drawImage(v, 0, 0, 24, 24);
    const px = tctx.getImageData(0, 0, 24, 24).data;
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.75));
    return { px, blob };
  };
  for (let i = 0; i < times.length && out.length < MAX; i++) {
    const t = times[i];
    const { px, blob } = await grab(t);
    // A scene change since the last frame (after the hook): also catch the moment in between
    if (prev && t >= 3 && diff(prev, px) > 40 && out.length < MAX - 1) {
      const mid = (times[i - 1] + t) / 2;
      const m = await grab(mid);
      if (m.blob) out.push({ ms: Math.round(mid * 1000), blob: m.blob });
      await seek(v, t);
    }
    if (blob) out.push({ ms: Math.round(t * 1000), blob });
    prev = px;
    onProgress?.(i + 1, times.length);
  }
  v.removeAttribute("src");
  v.load();
  return out.sort((a, b) => a.ms - b.ms);
}

/** The audio as 16 kHz mono 16-bit WAV, or null when the video has no sound track (or it can't be decoded here). */
export async function extractAudio(url: string): Promise<Blob | null> {
  try {
    const bytes = await (await fetch(url)).arrayBuffer();
    const decoded = await new AudioContext().decodeAudioData(bytes);
    const seconds = Math.min(decoded.duration, 290); // Speech-to-Text takes about 5 minutes inline
    const off = new OfflineAudioContext(1, Math.ceil(seconds * 16000), 16000);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    const pcm = (await off.startRendering()).getChannelData(0);
    // Silence (music-free, voice-free) isn't worth sending
    let peak = 0;
    for (let i = 0; i < pcm.length; i += 64) peak = Math.max(peak, Math.abs(pcm[i]));
    if (peak < 0.01) return null;
    const buf = new ArrayBuffer(44 + pcm.length * 2);
    const view = new DataView(buf);
    const text = (o: number, s: string) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
    text(0, "RIFF");
    view.setUint32(4, 36 + pcm.length * 2, true);
    text(8, "WAVE");
    text(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true);
    view.setUint32(28, 32000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, "data");
    view.setUint32(40, pcm.length * 2, true);
    for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
    return new Blob([buf], { type: "audio/wav" });
  } catch {
    return null;
  }
}
