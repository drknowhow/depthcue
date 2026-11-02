/**
 * An Office file as a set of parts: the zip, the XML parts parsed on demand, and the relationships that point from one
 * part to another. Nothing here knows what a theme or a layout is; it only finds parts and hands back their bytes.
 */
import JSZip from "jszip";
import { childrenNamed, parseXmlCounted, XmlError, type XmlNode, XmlTooLarge } from "./xml.ts";

/**
 * What a file may hold before it is refused. A zip says in its directory how large each part will be, and a hostile one
 * lies, so these are counted as the parts are unpacked, not read from the directory. The largest XML part in the themes
 * that ship with PowerPoint is 5.4 MB and 103,000 elements, their pictures are at most 1.2 MB each, and a whole file's
 * parts come to 432,000 elements and 8.4 MB of pictures: the limits sit well above that.
 */
export interface Limits {
  /** Parts in the zip. */
  parts: number;
  /** The unpacked size of one XML part, in bytes. */
  xml: number;
  /** The unpacked size of one picture. */
  media: number;
  /** Everything unpacked, XML and pictures together, over the whole import. */
  total: number;
  /** Elements in one XML part. */
  nodesPerPart: number;
  /** Elements in all the XML parts read. */
  nodes: number;
}

export const LIMITS: Limits = {
  parts: 4000,
  xml: 16 * 1024 * 1024,
  media: 32 * 1024 * 1024,
  total: 128 * 1024 * 1024,
  nodesPerPart: 300_000,
  nodes: 800_000,
};

export type PackageErrorCode = "not-a-package" | "too-large" | "bad-xml" | "unreadable";

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

/** The size a zip entry will unpack to, as its directory records it. The directory can lie, so this is only a shortcut. */
const declaredSize = (entry: JSZip.JSZipObject): number | undefined =>
  (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;

/**
 * An entry's bytes, counted as they come out of the decompressor, with the reading stopped as soon as they pass `limit`.
 * What the zip's directory says about the size is not used: a part that claims 2 KB and holds 600 MB is read for 16 KB of
 * input at a time, and stops after the one that takes it past the limit. Resolves to "over" when it does.
 */
function unpackCounted(entry: JSZip.JSZipObject, limit: number): Promise<Uint8Array | "over"> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    let settled = false;
    const stream = entry.nodeStream("nodebuffer") as NodeJS.ReadableStream & { destroy?: () => void };
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      stream.pause();
      stream.destroy?.();
      finish();
    };
    stream.on("data", (chunk: Uint8Array) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) settle(() => resolve("over"));
      else chunks.push(chunk);
    });
    stream.on("error", (error: Error) => settle(() => reject(error)));
    stream.on("end", () => {
      if (settled) return;
      const data = new Uint8Array(size);
      let at = 0;
      for (const chunk of chunks) {
        data.set(chunk, at);
        at += chunk.length;
      }
      settled = true;
      resolve(data);
    });
  });
}

export interface OpenOptions {
  /** Smaller limits than the defaults, for a test that cannot build a file of the real size. */
  limits?: Partial<Limits>;
}

export class OfficePackage {
  readonly #zip: JSZip;
  readonly limits: Limits;
  readonly #xml = new Map<string, XmlNode>();
  /** Pictures already unpacked, by part name: a picture two layouts share is read once and counted once. */
  readonly #media = new Map<string, Uint8Array>();
  /** Part names, as the file spells them, by lower case: part names are not case-sensitive. */
  readonly #names = new Map<string, string>();
  #unpacked = 0;
  #nodes = 0;

  private constructor(zip: JSZip, limits: Limits) {
    this.#zip = zip;
    this.limits = limits;
    for (const [name, entry] of Object.entries(zip.files)) {
      if (!entry.dir) this.#names.set(name.toLowerCase(), name);
    }
  }

  /** Opens the zip. Throws `PackageError` when the bytes are not a zip or hold too many parts. */
  static async open(bytes: Uint8Array, options: OpenOptions = {}): Promise<OfficePackage> {
    const limits = { ...LIMITS, ...options.limits };
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(bytes);
    } catch {
      throw new PackageError(
        "not-a-package",
        "It is not a PowerPoint file: a .potx, .pptx or .thmx is a zip of XML parts, and this is not a zip. (The old .ppt, .pot and .thm formats cannot be read.)",
      );
    }
    if (Object.keys(zip.files).length > limits.parts) {
      throw new PackageError(
        "too-large",
        `The file holds more than ${limits.parts} parts, which no deck does.`,
      );
    }
    return new OfficePackage(zip, limits);
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

  /** How many bytes have been unpacked so far, XML and pictures together. */
  get unpacked(): number {
    return this.#unpacked;
  }

  /** Unpacks one part, within its own limit and what is left of the whole file's. */
  async #unpack(part: string, name: string, limit: number): Promise<Uint8Array> {
    const entry = this.#zip.file(name);
    if (!entry) throw new PackageError("unreadable", `The part ${part} is not in the file.`);
    const declared = declaredSize(entry);
    if (declared !== undefined && declared > limit) {
      throw new PackageError(
        "too-large",
        `The part ${part} unpacks to ${declared} bytes, past the ${limit} this reads.`,
      );
    }
    const room = this.limits.total - this.#unpacked;
    let data: Uint8Array | "over";
    try {
      data = await unpackCounted(entry, Math.min(limit, room));
    } catch (error) {
      throw new PackageError(
        "unreadable",
        `The part ${part} cannot be unpacked (${(error as Error).message}), so the file is damaged.`,
      );
    }
    if (data === "over") {
      throw new PackageError(
        "too-large",
        limit <= room
          ? `The part ${part} unpacks to more than the ${limit} bytes this reads.`
          : `The file unpacks to more than ${this.limits.total} bytes in all, which no template does.`,
      );
    }
    this.#unpacked += data.length;
    return data;
  }

  /** A picture's bytes, or undefined when there is no such part. Throws `PackageError` for one that unpacks too large. */
  async bytes(part: string, limit: number = this.limits.media): Promise<Uint8Array | undefined> {
    const name = this.nameOf(part);
    if (name === undefined) return undefined;
    const known = this.#media.get(name);
    if (known) {
      if (known.length > limit) {
        throw new PackageError(
          "too-large",
          `The part ${part} unpacks to ${known.length} bytes, past the ${limit} this reads.`,
        );
      }
      return known;
    }
    const data = await this.#unpack(part, name, limit);
    this.#media.set(name, data);
    return data;
  }

  /** An XML part's root element, or undefined when there is no such part. Throws `PackageError` for bad XML. */
  async xml(part: string): Promise<XmlNode | undefined> {
    const key = part.toLowerCase();
    const cached = this.#xml.get(key);
    if (cached) return cached;
    const name = this.nameOf(part);
    if (name === undefined) return undefined;
    const data = await this.#unpack(part, name, this.limits.xml);
    try {
      const { root, nodes } = parseXmlCounted(new TextDecoder("utf-8").decode(data), {
        maxNodes: Math.min(this.limits.nodesPerPart, this.limits.nodes - this.#nodes),
      });
      this.#nodes += nodes;
      this.#xml.set(key, root);
      return root;
    } catch (error) {
      if (error instanceof XmlTooLarge) {
        throw new PackageError(
          "too-large",
          `The part ${part} has more elements than this reads (${this.limits.nodesPerPart} in one part, ${this.limits.nodes} in the whole file).`,
        );
      }
      if (error instanceof XmlError) {
        throw new PackageError("bad-xml", `The part ${part} is not valid XML: ${error.message}`);
      }
      throw error;
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
