import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateRawSync, deflateSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";

import {
  decompressDiagramXml,
  extractXmlFromPng,
  extractXmlFromSvg,
  inferImportFormat,
  resolveImportSource,
} from "./import-source.js";

const MODEL_XML =
  '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="Hällo &amp; co" vertex="1" parent="1"/></root></mxGraphModel>';

function compress(xml: string): string {
  return deflateRawSync(Buffer.from(encodeURIComponent(xml), "latin1"))
    .toString("base64");
}

const MXFILE = `<mxfile host="localhost">\n  <diagram name="Page-1" id="p1">${MODEL_XML}</diagram>\n</mxfile>`;

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\n/g, "&#10;");
}

/** SVG as written by draw.io's export with embed_xml. */
function drawioSvg(mxfile: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg xmlns="http://www.w3.org/2000/svg" width="10px" height="10px" content="${escapeAttr(mxfile)}"><g/></svg>`;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  // CRC is not validated by the extractor.
  return Buffer.concat([length, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
}

/** PNG as written by draw.io's export with embed_xml (URL-encoded tEXt). */
function drawioPng(chunks: Buffer[]): Buffer {
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", Buffer.alloc(13)),
    ...chunks,
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function textChunk(keyword: string, text: string): Buffer {
  return pngChunk(
    "tEXt",
    Buffer.concat([Buffer.from(`${keyword}\0`, "latin1"), Buffer.from(text, "latin1")]),
  );
}

describe("extractXmlFromSvg", () => {
  it("reads the mxfile from draw.io's content attribute", () => {
    expect(extractXmlFromSvg(drawioSvg(MXFILE))).toBe(MXFILE);
  });

  it("reads an inline mxfile element", () => {
    expect(
      extractXmlFromSvg(`<svg><metadata>${MXFILE}</metadata></svg>`),
    ).toBe(MXFILE);
  });

  it("returns null for plain SVG", () => {
    expect(extractXmlFromSvg('<svg width="1"><g/></svg>')).toBeNull();
  });
});

describe("extractXmlFromPng", () => {
  it("reads a URL-encoded mxfile tEXt chunk", () => {
    const png = drawioPng([textChunk("mxfile", encodeURIComponent(MXFILE))]);
    expect(extractXmlFromPng(png)).toBe(MXFILE);
  });

  it("reads a plain-text mxfile tEXt chunk", () => {
    const png = drawioPng([textChunk("mxfile", MXFILE)]);
    expect(extractXmlFromPng(png)).toBe(MXFILE);
  });

  it("reads a zTXt mxfile chunk", () => {
    const data = Buffer.concat([
      Buffer.from("mxfile\0\0", "latin1"),
      deflateSync(Buffer.from(encodeURIComponent(MXFILE), "latin1")),
    ]);
    const png = drawioPng([pngChunk("zTXt", data)]);
    expect(extractXmlFromPng(png)).toBe(MXFILE);
  });

  it("ignores unrelated text chunks and non-PNG input", () => {
    expect(
      extractXmlFromPng(drawioPng([textChunk("Software", "x")])),
    ).toBeNull();
    expect(extractXmlFromPng(Buffer.from("not a png"))).toBeNull();
  });
});

describe("inferImportFormat", () => {
  it.each([
    ["/a/b.drawio", "xml"],
    ["/a/b.dio", "xml"],
    ["/a/b.XML", "xml"],
    ["/a/b.svg", "svg"],
    ["/a/b.drawio.svg", "svg"],
    ["/a/b.png", "png"],
    ["/a/b.drawio.png", "png"],
  ])("maps %s to %s", (file, expected) => {
    expect(inferImportFormat(file)).toBe(expected);
  });

  it("returns undefined for unknown extensions", () => {
    expect(inferImportFormat("/a/b.txt")).toBeUndefined();
    expect(inferImportFormat("/a/noext")).toBeUndefined();
  });
});

describe("decompressDiagramXml", () => {
  it("expands compressed diagram payloads", () => {
    const xml = `<mxfile><diagram id="p1" name="Page-1">${compress(MODEL_XML)}</diagram></mxfile>`;
    expect(decompressDiagramXml(xml)).toBe(
      `<mxfile><diagram id="p1" name="Page-1">${MODEL_XML}</diagram></mxfile>`,
    );
  });

  it("expands every page of a multi-page file", () => {
    const xml = `<mxfile><diagram id="a">${compress(MODEL_XML)}</diagram><diagram id="b">\n  ${compress(MODEL_XML)}\n</diagram></mxfile>`;
    const out = decompressDiagramXml(xml);
    expect(out.match(/<mxGraphModel>/g)).toHaveLength(2);
  });

  it("leaves uncompressed diagrams untouched", () => {
    const xml = `<mxfile><diagram id="p1">${MODEL_XML}</diagram></mxfile>`;
    expect(decompressDiagramXml(xml)).toBe(xml);
  });

  it("leaves undecodable payloads untouched", () => {
    const xml = '<mxfile><diagram id="p1">notbase64atall</diagram></mxfile>';
    expect(decompressDiagramXml(xml)).toBe(xml);
  });
});

describe("resolveImportSource", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "import-source-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes inline data through", async () => {
    await expect(
      resolveImportSource({ data: MODEL_XML, format: "xml", filename: "x" }),
    ).resolves.toEqual({ data: MODEL_XML, format: "xml", filename: "x" });
  });

  it("requires exactly one of data or input_path", async () => {
    await expect(resolveImportSource({ format: "xml" })).rejects.toThrow(
      "exactly one of",
    );
    await expect(
      resolveImportSource({
        data: MODEL_XML,
        input_path: "/tmp/x.drawio",
        format: "xml",
      }),
    ).rejects.toThrow("exactly one of");
  });

  it("requires format with inline data", async () => {
    await expect(resolveImportSource({ data: MODEL_XML })).rejects.toThrow(
      "`format` is required",
    );
  });

  it("rejects relative paths", async () => {
    await expect(
      resolveImportSource({ input_path: "diagram.drawio" }),
    ).rejects.toThrow("absolute path");
  });

  it("reads a .drawio file, infers xml, and decompresses it", async () => {
    const file = path.join(dir, "compressed.drawio");
    writeFileSync(
      file,
      `<mxfile><diagram id="p1">${compress(MODEL_XML)}</diagram></mxfile>`,
    );
    await expect(resolveImportSource({ input_path: file })).resolves.toEqual({
      data: `<mxfile><diagram id="p1">${MODEL_XML}</diagram></mxfile>`,
      format: "xml",
      filename: "compressed.drawio",
    });
  });

  it("reads an exported draw.io SVG and passes its diagram on as xml", async () => {
    const file = path.join(dir, "d.drawio.svg");
    writeFileSync(file, drawioSvg(MXFILE));
    await expect(resolveImportSource({ input_path: file })).resolves.toEqual({
      data: MXFILE,
      format: "xml",
      filename: "d.drawio.svg",
    });
  });

  it("reads an exported draw.io PNG and passes its diagram on as xml", async () => {
    const file = path.join(dir, "d.drawio.png");
    writeFileSync(
      file,
      drawioPng([textChunk("mxfile", encodeURIComponent(MXFILE))]),
    );
    await expect(resolveImportSource({ input_path: file })).resolves.toEqual({
      data: MXFILE,
      format: "xml",
      filename: "d.drawio.png",
    });
  });

  it("normalizes inline SVG (raw or base64) and base64 PNG data", async () => {
    const svg = drawioSvg(MXFILE);
    const png = drawioPng([textChunk("mxfile", encodeURIComponent(MXFILE))]);
    for (const [data, format] of [
      [svg, "svg"],
      [Buffer.from(svg).toString("base64"), "svg"],
      [png.toString("base64"), "png"],
    ] as const) {
      await expect(resolveImportSource({ data, format })).resolves.toEqual({
        data: MXFILE,
        format: "xml",
        filename: undefined,
      });
    }
  });

  it("passes SVG without an embedded diagram through unchanged", async () => {
    const file = path.join(dir, "plain.svg");
    writeFileSync(file, "<svg><g/></svg>");
    await expect(resolveImportSource({ input_path: file })).resolves.toEqual({
      data: "<svg><g/></svg>",
      format: "svg",
      filename: "plain.svg",
    });
  });

  it("reads PNG without an embedded diagram as base64", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const file = path.join(dir, "d.png");
    writeFileSync(file, bytes);
    const result = await resolveImportSource({ input_path: file });
    expect(result.format).toBe("png");
    expect(Buffer.from(result.data, "base64")).toEqual(bytes);
  });

  it("lets an explicit format and filename override inference", async () => {
    const file = path.join(dir, "diagram.txt");
    writeFileSync(file, MODEL_XML);
    await expect(
      resolveImportSource({ input_path: file, format: "xml", filename: "n" }),
    ).resolves.toEqual({ data: MODEL_XML, format: "xml", filename: "n" });
  });

  it("errors when the format cannot be inferred", async () => {
    const file = path.join(dir, "diagram.txt");
    writeFileSync(file, MODEL_XML);
    await expect(resolveImportSource({ input_path: file })).rejects.toThrow(
      "Cannot infer format",
    );
  });

  it("reports missing files and directories clearly", async () => {
    await expect(
      resolveImportSource({ input_path: path.join(dir, "missing.drawio") }),
    ).rejects.toThrow("File not found");
    await expect(
      resolveImportSource({ input_path: dir, format: "xml" }),
    ).rejects.toThrow("is a directory");
  });
});
