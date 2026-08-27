/* Signal Lab — bridges ffmpeg.wasm (any media format, in-browser) to RunMat's
 * native audioread/fwrite (real signal-processing builtins: fft, pwelch,
 * fir1, filtfilt, buttord, spectrogram, …), via the filesystem-provider hook
 * RunMat's wasm build exposes to the host.
 *
 * Import:  ffmpeg.wasm decodes/transcodes whatever the user drops (mp3, mp4,
 *          mov, webm, …) to a 16-bit PCM WAV → written into an in-memory
 *          filesystem → `[x, fs] = audioread('input.wav')` in a cell reads
 *          it with zero custom RunMat-side code.
 * Export:  RunMat itself writes processed samples out — `fwrite(fid, y,
 *          'int16')` — which lands in the SAME in-memory filesystem; we wrap
 *          the raw PCM bytes in a WAV header and hand back a Blob to
 *          download. (RunMat has no `audiowrite`, and `materializeVariable`
 *          caps out at 4096 elements — fwrite through the fsProvider sidesteps
 *          both.)
 *
 * Verified directly against the deployed runtime (crates.io runmat-core
 * behind /streamlab/runtime): audioread, pwelch, fir1, filtfilt, buttord,
 * spectrogram, and fopen/fwrite/fclose against a JS-backed fsProvider all
 * work as of the build this repo currently loads.
 */

/** An in-memory filesystem RunMat's wasm session can read/write through. */
export function createMemFs() {
  const files = new Map(); // '/name.ext' -> Uint8Array

  const key = (p) => (p.startsWith('/') ? p : `/${p}`);

  const fsProvider = {
    readFile: (p) => {
      const v = files.get(key(p));
      if (!v) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    writeFile: (p, data) => {
      files.set(key(p), data instanceof Uint8Array ? data : new Uint8Array(data));
    },
    removeFile: (p) => {
      files.delete(key(p));
    },
    metadata: (p) => {
      const v = files.get(key(p));
      if (!v) throw new Error(`ENOENT: ${p}`);
      return { isFile: true, isDir: false, isSymlink: false, len: v.length, readonly: false };
    },
  };

  return {
    fsProvider,
    write: (name, data) => fsProvider.writeFile(name, data),
    read: (name) => files.get(key(name)) ?? null,
    has: (name) => files.has(key(name)),
  };
}

let ffmpegPromise = null;

/** Lazily load + boot ffmpeg.wasm (single-threaded core, vendored same-origin). */
async function getFfmpeg(base) {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const { FFmpeg } = await import(/* @vite-ignore */ `${base}/index.js`);
      const ffmpeg = new FFmpeg();
      await ffmpeg.load({
        coreURL: `${base}/core/ffmpeg-core.js`,
        wasmURL: `${base}/core/ffmpeg-core.wasm`,
      });
      return ffmpeg;
    })();
  }
  return ffmpegPromise;
}

/**
 * Decode/transcode an arbitrary media File (audio or video — ffmpeg pulls
 * the audio track out of video containers automatically) to a mono 16-bit
 * PCM WAV. Returns the WAV bytes.
 */
export async function decodeToWav(file, { base = './vendor/ffmpeg', sampleRate = 44100, onLog = null } = {}) {
  const ffmpeg = await getFfmpeg(base);
  if (onLog) ffmpeg.on('log', onLog);
  const inExt = (file.name.match(/\.[^.]+$/)?.[0] ?? '.bin');
  const inName = `in${inExt}`;
  const outName = 'out.wav';
  await ffmpeg.writeFile(inName, new Uint8Array(await file.arrayBuffer()));
  try {
    await ffmpeg.exec(['-i', inName, '-ar', String(sampleRate), '-ac', '1', '-f', 'wav', outName]);
    return await ffmpeg.readFile(outName);
  } finally {
    await ffmpeg.deleteFile(inName).catch(() => {});
    await ffmpeg.deleteFile(outName).catch(() => {});
  }
}

/** Wrap raw little-endian 16-bit PCM bytes (as `fwrite(fid, y, 'int16')` produces) in a WAV header. */
export function wavFromPcm16(pcmBytes, { sampleRate = 44100, channels = 1 } = {}) {
  const dataLen = pcmBytes.length;
  const buf = new ArrayBuffer(44 + dataLen);
  const view = new DataView(buf);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); view.setUint32(4, 36 + dataLen, true); str(8, 'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, channels, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, dataLen, true);
  new Uint8Array(buf, 44).set(pcmBytes);
  return new Uint8Array(buf);
}

/** Trigger a browser download for a Uint8Array. */
export function downloadBytes(bytes, filename, mime = 'audio/wav') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], { type: mime }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
