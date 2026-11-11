import { readFile } from "node:fs/promises";
import path from "node:path";
import { inflateRawSync, inflateSync } from "node:zlib";

import { assertAbsolutePath } from "./file-path.js";

export type ImportFormat = "xml" | "svg" | "png";

export interface ImportSourceInput {
  data?: string;
  input_path?: string;
  format?: ImportFormat;
  filename?: string;
}

export interface ResolvedImportSource {
  data: string;
  format: ImportFormat;
  filename?: string;
}

/**
 * Infers the import format from a file name. Handles draw.io's double
 * extensions (`.drawio.svg`, `.drawio.png`) by looking at the last suffix.
 */
export function inferImportFormat(filePath: string): ImportFormat | undefined {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".png":
      return "png";
    case ".svg":
      return "svg";
    case ".drawio":
    case ".dio":
    case ".xml":
      return "xml";
    default:
      return undefined;
  }
}

/** Decodes draw.io's compressed form: base64 → raw deflate → URI encoding. */
function inflateDrawioPayload(payload: string): string | null {
  try {
    const inflated = inflateRawSync(
      Buffer.from(payload.replace(/\s+/g, ""), "base64"),
    ).toString("latin1");
    const decoded = decodeURIComponent(inflated);
    return decoded.trimStart().startsWith("<") ? decoded : null;
  } catch {
    return null;
  }
}

const COMPRESSED_DIAGRAM =
  /(<diagram\b[^>]*>)\s*([A-Za-z0-9+/=\s]+?)\s*(<\/diagram>)/g;

/**
 * Expands compressed `<diagram>` payloads (the format older draw.io versions
 * save by default) into inline `<mxGraphModel>` XML. The browser-side
 * importer only understands the uncompressed form. Payloads that fail to
 * decode are left untouched.
 */
export function decompressDiagramXml(xml: string): string {
  return xml.replace(
    COMPRESSED_DIAGRAM,
    (match, open: string, payload: string, close: string) => {
      const decoded = inflateDrawioPayload(payload);
      return decoded === null ? match : `${open}${decoded}${close}`;
    },
  );
}

function decodeXmlEntities(value: string): string {
  return value.replace(
    /&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|quot|apos|amp);/g,
    (_match, entity: string) => {
      switch (entity) {
        case "lt":
          return "<";
        case "gt":
          return ">";
        case "quot":
          return '"';
        case "apos":
          return "'";
        case "amp":
          return "&";
        default:
          return String.fromCodePoint(
            entity[1] === "x"
              ? Number.parseInt(entity.slice(2), 16)
              : Number.parseInt(entity.slice(1), 10),
          );
      }
    },
  );
}

/**
 * Extracts the diagram from an SVG written by draw.io. draw.io stores the
 * entity-escaped `<mxfile>` in the root element's `content` attribute
 * (older versions store it compressed); some tools embed an `<mxfile>`
 * element instead. Returns null when the SVG carries no diagram.
 */
export function extractXmlFromSvg(svg: string): string | null {
  const content = /<svg\b[^>]*?\scontent=(?:"([^"]*)"|'([^']*)')/.exec(svg);
  if (content) {
    const decoded = decodeXmlEntities(content[1] ?? content[2]).trim();
    if (decoded.startsWith("<")) {
      return decoded;
    }
    const inflated = inflateDrawioPayload(decoded);
    if (inflated) {
      return inflated;
    }
  }

  const element = /<mxfile\b[\s\S]*?<\/mxfile>/.exec(svg);
  return element ? element[0] : null;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function decodeEmbeddedText(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("<")) {
    return trimmed;
  }
  if (trimmed.startsWith("%3C") || trimmed.startsWith("%3c")) {
    try {
      return decodeURIComponent(trimmed);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Extracts the diagram from a PNG written by draw.io. draw.io stores the
 * URL-encoded `<mxfile>` in a `tEXt` chunk with keyword `mxfile`; `zTXt`
 * and `iTXt` variants are handled too. Returns null when the PNG carries no
 * diagram.
 */
export function extractXmlFromPng(png: Buffer): string | null {
  if (png.length < 8 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return null;
  }

  let offset = 8;
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("latin1", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type !== "tEXt" && type !== "zTXt" && type !== "iTXt") {
      continue;
    }

    const nul = data.indexOf(0);
    if (nul === -1) {
      continue;
    }
    const keyword = data.toString("latin1", 0, nul);
    if (keyword !== "mxfile" && keyword !== "mxGraphModel") {
      continue;
    }

    try {
      let text: string;
      if (type === "tEXt") {
        text = data.toString("latin1", nul + 1);
      } else if (type === "zTXt") {
        text = inflateSync(data.subarray(nul + 2)).toString("latin1");
      } else {
        // iTXt: keyword\0 flag method language\0 translated\0 text
        const compressed = data[nul + 1] === 1;
        const langEnd = data.indexOf(0, nul + 3);
        const transEnd = langEnd === -1 ? -1 : data.indexOf(0, langEnd + 1);
        if (transEnd === -1) {
          continue;
        }
        const body = data.subarray(transEnd + 1);
        text = (compressed ? inflateSync(body) : body).toString("utf-8");
      }
      const xml = decodeEmbeddedText(text);
      if (xml) {
        return xml;
      }
    } catch {
      // Malformed chunk: keep scanning.
    }
  }

  return null;
}

/**
 * Converts SVG/PNG input to the embedded draw.io XML when it can be found,
 * so the browser only ever has to parse plain XML. Input without an
 * embedded diagram passes through unchanged and the browser reports the
 * error.
 */
function normalize(
  format: ImportFormat,
  text: string | null,
  bytes: Buffer | null,
): { data: string; format: ImportFormat } {
  if (format === "xml") {
    const xml = text ?? (bytes as Buffer).toString("utf-8");
    return { data: decompressDiagramXml(xml), format };
  }

  if (format === "svg") {
    let svg = text ?? (bytes as Buffer).toString("utf-8");
    if (!svg.trimStart().startsWith("<")) {
      svg = Buffer.from(svg, "base64").toString("utf-8");
    }
    const xml = extractXmlFromSvg(svg);
    if (xml) {
      return { data: decompressDiagramXml(xml), format: "xml" };
    }
    return { data: text ?? svg, format };
  }

  const png = bytes ?? Buffer.from(text as string, "base64");
  const xml = extractXmlFromPng(png);
  if (xml) {
    return { data: decompressDiagramXml(xml), format: "xml" };
  }
  return { data: text ?? png.toString("base64"), format };
}

/**
 * Turns the `import-diagram` tool arguments into the `data`/`format` pair the
 * browser plugin expects. Exactly one of `data` or `input_path` must be set.
 * `input_path` follows the same rule as `export-diagram`'s `output_path`
 * (absolute path), so a file written by export loads back unchanged.
 * `format` is inferred from the extension when omitted, and `filename`
 * defaults to the file's base name.
 */
export async function resolveImportSource(
  input: ImportSourceInput,
): Promise<ResolvedImportSource> {
  const hasData = input.data !== undefined;
  const hasPath = input.input_path !== undefined;

  if (hasData === hasPath) {
    throw new Error(
      "import-diagram requires exactly one of `data` or `input_path`",
    );
  }

  if (hasData) {
    if (!input.format) {
      throw new Error("`format` is required when importing from `data`");
    }
    return {
      ...normalize(input.format, input.data as string, null),
      filename: input.filename,
    };
  }

  const inputPath = input.input_path as string;
  assertAbsolutePath("input_path", inputPath);

  const format = input.format ?? inferImportFormat(inputPath);
  if (!format) {
    throw new Error(
      `Cannot infer format from file extension of ${inputPath}; pass \`format\` explicitly`,
    );
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(inputPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`File not found: ${inputPath}`);
    }
    if (code === "EISDIR") {
      throw new Error(`input_path is a directory: ${inputPath}`);
    }
    throw new Error(`Could not read ${inputPath}: ${(error as Error).message}`);
  }

  return {
    ...normalize(format, null, bytes),
    filename: input.filename ?? path.basename(inputPath),
  };
}
