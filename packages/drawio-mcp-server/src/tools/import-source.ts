import { inflateRawSync, inflateSync } from "node:zlib";

export type ImportFormat = "xml" | "svg" | "png";

export interface ImportSourceInput {
  data: string;
  format: ImportFormat;
  filename?: string;
}

export interface ResolvedImportSource {
  data: string;
  format: ImportFormat;
  filename?: string;
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
  data: string,
): { data: string; format: ImportFormat } {
  if (format === "xml") {
    return { data: decompressDiagramXml(data), format };
  }

  if (format === "svg") {
    const svg = data.trimStart().startsWith("<")
      ? data
      : Buffer.from(data, "base64").toString("utf-8");
    const xml = extractXmlFromSvg(svg);
    return xml
      ? { data: decompressDiagramXml(xml), format: "xml" }
      : { data, format };
  }

  const xml = extractXmlFromPng(Buffer.from(data, "base64"));
  return xml
    ? { data: decompressDiagramXml(xml), format: "xml" }
    : { data, format };
}

/**
 * Turns the `import-diagram` tool arguments into the `data`/`format` pair the
 * browser plugin expects. SVG and PNG input written by draw.io (embedded
 * diagram in the SVG `content` attribute or the PNG `mxfile` text chunk) is
 * converted to XML, and compressed `<diagram>` pages are expanded.
 */
export function resolveImportSource(
  input: ImportSourceInput,
): ResolvedImportSource {
  return {
    ...normalize(input.format, input.data),
    filename: input.filename,
  };
}
