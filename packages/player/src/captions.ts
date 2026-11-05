/** One spoken word, in seconds from the start of the recording. */
export interface Word {
  text: string;
  start: number;
  end: number;
}

/** A caption: a few words shown together from `start` to `end`. */
export interface Line {
  text: string;
  start: number;
  end: number;
}

const WORDS_FORMAT = "depthcue-words/1";

/** Words per caption. Two short lines of a slide's caption are about this many. */
const MAX_WORDS = 9;
/** A pause this long between two words starts a new caption. */
const PAUSE = 0.45;
/** A caption stays up this long after its last word, so the eye can finish it. */
const LINGER = 0.6;

/** Reads the file `depthcue voice build` writes next to the audio. Anything else is not words. */
export function readWords(data: unknown): Word[] | undefined {
  const file = data as { format?: unknown; words?: unknown } | null;
  if (!file || file.format !== WORDS_FORMAT || !Array.isArray(file.words)) return undefined;
  const words: Word[] = [];
  for (const entry of file.words as unknown[]) {
    const word = entry as Partial<Word> | null;
    if (
      typeof word?.text !== "string" ||
      typeof word.start !== "number" ||
      typeof word.end !== "number" ||
      !Number.isFinite(word.start) ||
      !Number.isFinite(word.end)
    )
      return undefined;
    words.push({ text: word.text, start: word.start, end: word.end });
  }
  return words;
}

/** The seconds at which the slide moves on, from the word file. A file without marks, or with bad ones, has none. */
export function readMarks(data: unknown): number[] {
  const marks = (data as { marks?: unknown } | null)?.marks;
  if (!Array.isArray(marks)) return [];
  const times = marks.filter((at): at is number => typeof at === "number" && Number.isFinite(at) && at >= 0);
  return times.length === marks.length ? times : [];
}

/**
 * Groups timed words into captions: a new one after a pause, at the end of a sentence, at a comma once a few words
 * are in, or when it gets long. The word times carry no punctuation, so when the script has the same number of words
 * the captions use the script's own words, with their punctuation and where its sentences end.
 */
export function linesFromWords(words: readonly Word[], script?: string): Line[] {
  const tokens = script?.split(/\s+/).filter(Boolean) ?? [];
  const aligned = tokens.length === words.length;
  const lines: Line[] = [];
  let group: Word[] = [];
  const flush = () => {
    const first = group[0];
    const last = group[group.length - 1];
    if (first && last)
      lines.push({ text: group.map((word) => word.text).join(" "), start: first.start, end: last.end });
    group = [];
  };
  words.forEach((spoken, index) => {
    const word = aligned ? { ...spoken, text: tokens[index] as string } : spoken;
    const last = group[group.length - 1];
    if (last && (word.start - last.end > PAUSE || group.length >= MAX_WORDS)) flush();
    group.push(word);
    if (aligned && (/[.!?]["')\]]*$/.test(word.text) || (group.length >= 4 && /,["')\]]*$/.test(word.text))))
      flush();
  });
  flush();
  return lines;
}

/**
 * Captions for a recording that has no word times: the text is cut into sentences and phrases, and each gets
 * time in proportion to its length. It is a fair guide, not a match.
 */
export function linesFromText(text: string, duration: number): Line[] {
  if (!(duration > 0)) return [];
  const pieces: string[] = [];
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const words = sentence.trim().split(/\s+/).filter(Boolean);
    for (let at = 0; at < words.length; at += MAX_WORDS)
      pieces.push(words.slice(at, at + MAX_WORDS).join(" "));
  }
  const total = pieces.reduce((sum, piece) => sum + piece.length, 0);
  if (total === 0) return [];
  let clock = 0;
  return pieces.map((piece) => {
    const start = clock;
    clock += (piece.length / total) * duration;
    return { text: piece, start, end: clock };
  });
}

/** The times at which what `lineAt` returns can change: where a caption begins and where it goes away. */
export function captionEdges(lines: readonly Line[]): number[] {
  return lines.flatMap((line) => [line.start, line.end + LINGER]);
}

/** The caption to show at a time: the latest one that has begun, until it has been up past its end. */
export function lineAt(lines: readonly Line[], time: number): Line | undefined {
  let found: Line | undefined;
  for (const line of lines) {
    if (line.start <= time + 0.05) found = line;
    else break;
  }
  return found && time <= found.end + LINGER ? found : undefined;
}
