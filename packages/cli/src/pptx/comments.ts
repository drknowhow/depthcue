/**
 * The deck's comments as PowerPoint comments: the classic form (`commentAuthors.xml` and one `comments/commentN.xml`
 * for each slide that has any), which PowerPoint reads and turns into its own comments on opening. The classic form
 * has no replies and no resolved flag, so a thread is one comment for each message, and the first names the block
 * it points at and whether the thread is resolved.
 */
import type { Comment } from "@depthcue/core";

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const AUTHORS = [
  { who: "you", name: "You", initials: "Y" },
  { who: "agent", name: "Agent", initials: "A" },
] as const;

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** Text for an XML element: escaped, without the control characters XML cannot hold. */
const xml = (text: string) =>
  text
    // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/** A time as the classic form writes it: no zone, with milliseconds. One that does not read becomes a fixed time. */
const when = (at: string) => {
  const time = new Date(at);
  return Number.isNaN(time.getTime()) ? "2026-01-01T00:00:00.000" : time.toISOString().slice(0, -1);
};

export interface SlideComments {
  /** The slide's number from 1: its part is `ppt/slides/slide<number>.xml`. */
  slide: number;
  comments: readonly Comment[];
}

/**
 * Adds the comments to the file's parts and returns how many it wrote. A comment points at a block, which the classic
 * form cannot say, so each sits at the slide's top left with the next one below.
 */
export function addComments(parts: Map<string, Uint8Array>, slides: readonly SlideComments[]): number {
  const given = slides.filter((slide) => slide.comments.length > 0);
  if (given.length === 0) return 0;
  const last = [0, 0];
  const files: Array<{ slide: number; xml: string }> = [];
  let total = 0;
  for (const { slide, comments } of given) {
    let row = 0;
    const list: string[] = [];
    for (const comment of comments) {
      comment.thread.forEach((message, at) => {
        const author = Math.max(
          0,
          AUTHORS.findIndex((entry) => entry.who === message.author),
        );
        last[author] = (last[author] ?? 0) + 1;
        const lead = at === 0 ? `${comment.resolved ? "[Resolved] " : ""}${comment.block}: ` : "";
        list.push(
          `<p:cm authorId="${author}" dt="${when(message.at)}" idx="${last[author]}"><p:pos x="${240 + 120 * row}" y="${240 + 360 * row}"/><p:text>${xml(lead + message.text)}</p:text></p:cm>`,
        );
        row += 1;
        total += 1;
      });
    }
    files.push({ slide, xml: `${HEAD}<p:cmLst ${NS}>${list.join("")}</p:cmLst>` });
  }
  const authors = AUTHORS.map(
    (entry, at) =>
      `<p:cmAuthor id="${at}" name="${entry.name}" initials="${entry.initials}" lastIdx="${last[at] ?? 0}" clrIdx="${at}"/>`,
  ).join("");
  parts.set("ppt/commentAuthors.xml", encode(`${HEAD}<p:cmAuthorLst ${NS}>${authors}</p:cmAuthorLst>`));

  let overrides =
    '<Override PartName="/ppt/commentAuthors.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.commentAuthors+xml"/>';
  for (const { slide, xml } of files) {
    parts.set(`ppt/comments/comment${slide}.xml`, encode(xml));
    overrides += `<Override PartName="/ppt/comments/comment${slide}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.comments+xml"/>`;
    const relsName = `ppt/slides/_rels/slide${slide}.xml.rels`;
    parts.set(
      relsName,
      encode(
        decode(parts.get(relsName) as Uint8Array).replace(
          "</Relationships>",
          `<Relationship Id="rIdComments" Type="${REL}/comments" Target="../comments/comment${slide}.xml"/></Relationships>`,
        ),
      ),
    );
  }
  parts.set(
    "[Content_Types].xml",
    encode(
      decode(parts.get("[Content_Types].xml") as Uint8Array).replace("</Types>", `${overrides}</Types>`),
    ),
  );
  parts.set(
    "ppt/_rels/presentation.xml.rels",
    encode(
      decode(parts.get("ppt/_rels/presentation.xml.rels") as Uint8Array).replace(
        "</Relationships>",
        `<Relationship Id="rIdCommentAuthors" Type="${REL}/commentAuthors" Target="commentAuthors.xml"/></Relationships>`,
      ),
    ),
  );
  return total;
}
