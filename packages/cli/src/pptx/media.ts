/**
 * Whether a clip can be embedded in the PowerPoint file: an MP4 in the deck whose video is H.264 and whose sound, if
 * it has any, is AAC, which PowerPoint plays on every system it runs on. The file's own boxes say what it holds, so
 * nothing is run to find out.
 */
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";

/** The sample formats of an MP4's tracks, by kind: `avc1` for H.264, `mp4a` for AAC. */
export interface Mp4Tracks {
  video: string[];
  audio: string[];
}

const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl"]);

/** The tracks an MP4 file holds, or nothing when it is not one. */
export function mp4Tracks(bytes: Uint8Array): Mp4Tracks | undefined {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) =>
    String.fromCharCode(
      bytes[at] as number,
      bytes[at + 1] as number,
      bytes[at + 2] as number,
      bytes[at + 3] as number,
    );
  const tracks: Mp4Tracks = { video: [], audio: [] };
  let typed = false;
  let handler = "";
  const walk = (start: number, end: number, depth: number): boolean => {
    let at = start;
    while (at + 8 <= end) {
      let size = data.getUint32(at);
      const type = tag(at + 4);
      let head = 8;
      if (size === 1) {
        if (at + 16 > end) return false;
        size = Number(data.getBigUint64(at + 8));
        head = 16;
      } else if (size === 0) size = end - at;
      if (size < head || at + size > end) return false;
      if (depth === 0 && at === start && type !== "ftyp") return false;
      if (type === "ftyp") typed = true;
      if (type === "trak") handler = "";
      if (type === "hdlr" && at + head + 12 <= end) handler = tag(at + head + 8);
      if (type === "stsd" && at + head + 8 <= end) {
        const count = data.getUint32(at + head + 4);
        let entry = at + head + 8;
        for (let i = 0; i < count && entry + 8 <= at + size; i++) {
          const format = tag(entry + 4);
          if (handler === "vide") tracks.video.push(format);
          else if (handler === "soun") tracks.audio.push(format);
          entry += Math.max(8, data.getUint32(entry));
        }
      }
      if (CONTAINERS.has(type) && !walk(at + head, at + size, depth + 1)) return false;
      at += size;
    }
    return true;
  };
  if (bytes.length < 8 || !walk(0, bytes.length, 0) || !typed) return undefined;
  return tracks;
}

const H264 = new Set(["avc1", "avc3"]);
const AAC = new Set(["mp4a"]);

/**
 * Why a clip cannot be embedded, in words for the report, or nothing when it can. `source` is the clip's file as the
 * deck names it.
 */
export function cannotEmbed(folder: string, source: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(source)) return "it is not a file in the deck";
  const type = extname(source).toLowerCase();
  if (type !== ".mp4" && type !== ".m4v") {
    return `PowerPoint embeds MP4 (H.264 video, AAC sound) and this is ${type ? type.slice(1).toUpperCase() : "another kind of file"}`;
  }
  const file = join(folder, source);
  if (!existsSync(file)) return "the file is not in the deck folder";
  const tracks = mp4Tracks(new Uint8Array(readFileSync(file)));
  if (!tracks) return "the file is not a readable MP4";
  if (tracks.video.length === 0) return "the file has no video track";
  const video = tracks.video.find((format) => !H264.has(format));
  if (video) return `its video is ${video}, not H.264`;
  const audio = tracks.audio.find((format) => !AAC.has(format));
  if (audio) return `its sound is ${audio}, not AAC`;
  return undefined;
}
