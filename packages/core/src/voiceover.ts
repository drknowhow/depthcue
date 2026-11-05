import { sha256Hex } from "./revision.ts";

/** What an author writes in a voice-over's text where the slide should move on: the next step shows here. */
export const VOICE_MARK = "{step}";

const MARK = /\{step\}/g;
const countWords = (text: string) => text.split(/\s+/).filter(Boolean).length;

/**
 * Takes the marks out of a voice-over's text. `spoken` is what is read aloud and captioned. Each entry of `marks`
 * is the number of spoken words that come before that mark, so the mark sits at the start of the word with that
 * index, or at the end of the recording when it equals the number of words.
 */
export function splitMarks(text: string): { spoken: string; marks: number[] } {
  const parts = text.split(MARK);
  const marks: number[] = [];
  let before = 0;
  for (const part of parts.slice(0, -1)) {
    before += countWords(part);
    marks.push(before);
  }
  return { spoken: parts.join(" ").replace(/\s+/g, " ").trim(), marks };
}

const KEY_FORMAT = "depthcue-voice/1";

/** The hash a recording is filed under: it changes when the text or the voice does, so a stale recording shows. */
export function voiceKey(text: string, voice: string): string {
  return sha256Hex(`${KEY_FORMAT}\n${voice}\n${text}`);
}
