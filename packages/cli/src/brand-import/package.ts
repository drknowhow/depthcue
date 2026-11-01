/**
 * An Office file as a set of parts: the zip, the XML parts parsed on demand, and the relationships that point from one
 * part to another. Nothing here knows what a theme or a layout is; it only finds parts and hands back their bytes.
 */
import JSZip from "jszip";
import { childrenNamed, parseXml, type XmlNode } from "./xml.ts";

/** What a file may hold before it is refused, so a small file that unpacks into a great deal costs nothing to refuse. */
export const LIMITS = {
  parts: 4000,
  /** The unpacked size of one XML part. The largest master in the themes that ship with PowerPoint is under 100 KB. */
  xml: 16 * 1024 * 1024,
  /** The unpacked size of a picture. */
  media: 64 * 1024 * 1024,
} as const;

export type PackageErrorCode = "not-a-package" | "too-large" | "bad-xml";

/** The file is not an Office package this command can read. */
export class PackageError extends Error {
  constructor(
    readonly code: PackageErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** A relationship from one part to another, the target resolved to a part name from the package root. */
export interface Relationship {
  id: string;
  /** The relationship's type, such as `http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme`. */
  type: string;
  /** The part it points to, like `ppt/slideMasters/slideMaster1.xml`; undefined for a link to a web address. */
  target: string | undefined;
}

/** The last word of a relationship type: `.../relationships/slideLayout` is `slideLayout`. */
export const relationshipKind = (rel: Relationship): string => rel.type.slice(rel.type.lastIndexOf("/") + 1);

/** The part a relationship in `source` points to. `source` is "" for the package's own relationships. */
function resolve(source: string, target: string): string {
  const parts = target.startsWith("/") ? [] : source.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

const relsPath = (part: string): string => {
  const slash = part.lastIndexOf("/");
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
};

/** The size a zip entry will unpack to, as its directory records it; undefined if this version of JSZip hides it. */
const unpackedSize = (entry: JSZip.JSZipObject): number | undefined =>
  (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;

export class OfficePackage {
  readonly #zip: JSZip;
  readonly #xml = new Map<string, XmlNode>();
  /** Part names, as the file spells them, by lower case: part names are not case-sensitive. */
  readonly #names = new Map<string, string>();

  private constructor(zip: JSZip) {
    this.#zip = zip;
    for (const [name, entry] of Object.entries(zip.files)) {
      if (!entry.dir) this.#names.set(name.toLowerCase(), name);
    }
  }

  /** Opens the zip. Throws `PackageError` when the bytes are not a zip or hold too many parts. */
  static async open(bytes: Uint8Array): Promise<OfficePackage> {
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(bytes);
    } catch {
      throw new PackageError(
        "not-a-package",
        "It is not a PowerPoint file: a .potx, .pptx or .thmx is a zip of XML parts, and this is not a zip. (The old .ppt, .pot and .thm formats cannot be read.)",
      );
    }
    if (Object.keys(zip.files).length > LIMITS.parts) {
      throw new PackageError(
        "too-large",
        `The file holds more than ${LIMITS.parts} parts, which no deck does.`,
      );
    }
    return new OfficePackage(zip);
  }

  /** The part's name as the file spells it, or undefined when the file has no such part. */
  nameOf(part: string): string | undefined {
    return this.#names.get(part.toLowerCase());
  }

  has(part: string): boolean {
    return this.nameOf(part) !== undefined;
  }

  /** Every part's name. */
  names(): string[] {
    return [...this.#names.values()];
  }

  /** A part's bytes, or undefined when there is no such part. Throws `PackageError` for one that unpacks too large. */
  async bytes(part: string, limit: number = LIMITS.media): Promise<Uint8Array | undefined> {
    const name = this.nameOf(part);
    const entry = name === undefined ? undefined : this.#zip.file(name);
    if (!entry) return undefined;
    const size = unpackedSize(entry);
    if (size !== undefined && size > limit) {
      throw new PackageError(
        "too-large",
        `The part ${part} unpacks to ${size} bytes, past the ${limit} this reads.`,
      );
    }
    const data = await entry.async("uint8array");
    if (data.length > limit) {
      throw new PackageError(
        "too-large",
        `The part ${part} unpacks to ${data.length} bytes, past the ${limit} this reads.`,
      );
    }
    return data;
  }

  /** An XML part's root element, or undefined when there is no such part. Throws `PackageError` for bad XML. */
  async xml(part: string): Promise<XmlNode | undefined> {
    const key = part.toLowerCase();
    const cached = this.#xml.get(key);
    if (cached) return cached;
    const data = await this.bytes(part, LIMITS.xml);
    if (!data) return undefined;
    try {
      const root = parseXml(new TextDecoder("utf-8").decode(data));
      this.#xml.set(key, root);
      return root;
    } catch (error) {
      throw new PackageError("bad-xml", `The part ${part} is not valid XML: ${(error as Error).message}`);
    }
  }

  /** The relationships a part has, or none when it has no relationships part. */
  async rels(part: string): Promise<Relationship[]> {
    const root = await this.xml(relsPath(part));
    return childrenNamed(root, "Relationship").flatMap((node) => {
      const id = node.attrs.Id;
      const type = node.attrs.Type;
      const target = node.attrs.Target;
      if (id === undefined || type === undefined || target === undefined) return [];
      return [{ id, type, target: node.attrs.TargetMode === "External" ? undefined : resolve(part, target) }];
    });
  }
}

/** The first relationship of a kind, such as `slideMaster`. */
export const firstOfKind = (rels: readonly Relationship[], kind: string): Relationship | undefined =>
  rels.find((rel) => relationshipKind(rel) === kind);
