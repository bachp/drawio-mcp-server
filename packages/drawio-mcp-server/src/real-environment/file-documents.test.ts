import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Frame, Page } from "@playwright/test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  createRealEnvironmentContext,
  disposeRealEnvironmentContext,
} from "./harness.js";
import { callToolJson } from "./tools.js";
import type { RealEnvironmentContext } from "./types.js";

const TWO_PAGE_FILE = `<mxfile host="test">
  <diagram id="page-a" name="First">
    <mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="a1" value="On page one" vertex="1" parent="1"><mxGeometry x="20" y="20" width="120" height="60" as="geometry"/></mxCell></root></mxGraphModel>
  </diagram>
  <diagram id="page-b" name="Second">
    <mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="b1" value="On page two" vertex="1" parent="1"><mxGeometry x="20" y="20" width="120" height="60" as="geometry"/></mxCell></root></mxGraphModel>
  </diagram>
</mxfile>`;

type LoadResult = {
  document_id: string | null;
  file_path: string;
  url: string;
  url_path: string;
  autosave: boolean;
  already_open: boolean;
};

describe("real environment/file-backed documents", () => {
  let context: RealEnvironmentContext;
  let dir: string;

  beforeAll(async () => {
    context = await createRealEnvironmentContext();
    dir = mkdtempSync(join(tmpdir(), "drawio-file-docs-"));
  }, 180000);

  afterAll(async () => {
    await disposeRealEnvironmentContext(context);
  });

  async function openFileTab(urlPath: string): Promise<{ page: Page; frame: Frame }> {
    const page = await context.browserContext.newPage();
    page.on("console", (message) => {
      context.browserMessages.push({ type: message.type(), text: message.text() });
    });
    await page.addInitScript((port: number) => {
      (window as any).__DRAWIO_MCP_TEST_HOOKS__ = true;
      const store = { websocketPort: port };
      window.localStorage.setItem("drawio-mcp-plugin-config", JSON.stringify(store));
      window.localStorage.setItem("drawio-mcp-config", JSON.stringify(store));
    }, context.wsPort);
    await page.goto(new URL(urlPath.slice(1), context.baseUrl).toString(), {
      waitUntil: "domcontentloaded",
    });
    let frame: Frame | undefined;
    const deadline = Date.now() + 30000;
    while (!frame && Date.now() < deadline) {
      frame = page.frames().find((f) => f.url().includes("mcp_file="));
      if (!frame) await page.waitForTimeout(100);
    }
    if (!frame) throw new Error("editor frame did not appear");
    await frame.waitForFunction(() => Boolean((window as any).ui?.editor?.graph), null, {
      timeout: 60000,
    });
    return { page, frame };
  }

  async function loadFile(
    path: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ result: LoadResult; page: Page; frame: Frame }> {
    const first = await callToolJson<{ result: LoadResult }>(context, "load-document", {
      path,
      open_browser: false,
      wait_ms: 0,
      ...extra,
    });
    expect(first.payload.result.document_id).toBeNull();
    const { page, frame } = await openFileTab(first.payload.result.url_path);
    const second = await callToolJson<{ result: LoadResult }>(context, "load-document", {
      path,
      open_browser: false,
      wait_ms: 30000,
    });
    expect(second.payload.result.document_id).toBeTruthy();
    return { result: second.payload.result, page, frame };
  }

  async function callRaw(name: string, args: Record<string, unknown>) {
    return (await context.client.callTool({ name, arguments: args })) as CallToolResult;
  }

  function textOf(result: CallToolResult): string {
    return (result.content as Array<{ text?: string }>)[0]?.text ?? "";
  }

  it("loads all pages of a file, edits it, and save-document writes it back", async () => {
    const file = join(dir, "two-pages.drawio");
    writeFileSync(file, TWO_PAGE_FILE);
    const { result, page, frame } = await loadFile(file);
    const target_document = { id: result.document_id };

    const { payload: docs } = await callToolJson<{ result: any[] }>(context, "list-documents", {});
    const listed = docs.result.find((d) => d.id === result.document_id);
    expect(listed).toMatchObject({ file_path: file, page_count: 2 });

    const { payload: added } = await callToolJson<any>(context, "add-rectangle", {
      target_document,
      target_page: { index: 1 },
      x: 200,
      y: 40,
      width: 120,
      height: 60,
      text: "Added by agent",
    });
    expect(added.success).toBe(true);

    const { payload: saved } = await callToolJson<any>(context, "save-document", {
      target_document,
    });
    expect(saved).toMatchObject({ success: true, result: { saved: true, file_path: file } });

    const written = readFileSync(file, "utf-8");
    expect(written).toContain('name="First"');
    expect(written).toContain('name="Second"');
    expect(written).toContain("On page one");
    expect(written).toContain("On page two");
    expect(written).toContain("Added by agent");

    // A Save from inside the editor (what Ctrl+S does) takes the same path.
    await callToolJson<any>(context, "add-rectangle", {
      target_document,
      target_page: { index: 0 },
      x: 200,
      y: 200,
      width: 120,
      height: 60,
      text: "Saved from the editor",
    });
    await frame.evaluate(() => (window as any).ui.actions.get("save").funct());
    await page.waitForFunction(
      () => document.getElementById("status")?.textContent?.startsWith("Saved"),
      null,
      { timeout: 15000 },
    );
    expect(readFileSync(file, "utf-8")).toContain("Saved from the editor");

    await page.close();
  }, 180000);

  it("save-document works on a document without changes", async () => {
    const file = join(dir, "unchanged.drawio");
    writeFileSync(file, TWO_PAGE_FILE);
    const { result, page } = await loadFile(file);

    const saved = await callRaw("save-document", {
      target_document: { id: result.document_id },
    });
    expect(textOf(saved)).toContain('"saved":true');
    expect(saved.isError).not.toBe(true);
    expect(readFileSync(file, "utf-8")).toContain('name="Second"');

    await page.close();
  }, 180000);

  it("refuses to overwrite external changes unless overwrite is set", async () => {
    const file = join(dir, "conflict.drawio");
    writeFileSync(file, TWO_PAGE_FILE);
    const { result, page } = await loadFile(file);
    const target_document = { id: result.document_id };

    await callToolJson<any>(context, "add-rectangle", {
      target_document,
      x: 10,
      y: 300,
      width: 80,
      height: 40,
      text: "Mine",
    });
    writeFileSync(file, `${TWO_PAGE_FILE}<!-- edited elsewhere -->`);

    const refused = await callRaw("save-document", { target_document });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("changed on disk");
    expect(readFileSync(file, "utf-8")).toContain("edited elsewhere");

    const { payload: forced } = await callToolJson<any>(context, "save-document", {
      target_document,
      overwrite: true,
    });
    expect(forced.result.saved).toBe(true);
    const written = readFileSync(file, "utf-8");
    expect(written).toContain("Mine");
    expect(written).not.toContain("edited elsewhere");

    await page.close();
  }, 180000);

  it("autosave writes changes without an explicit save, and creates new files", async () => {
    const file = join(dir, "brand-new.drawio");
    const { result, page } = await loadFile(file, { autosave: true });
    expect(result.autosave).toBe(true);

    await callToolJson<any>(context, "add-rectangle", {
      target_document: { id: result.document_id },
      x: 40,
      y: 40,
      width: 120,
      height: 60,
      text: "Autosaved",
    });

    const deadline = Date.now() + 15000;
    let content = "";
    while (Date.now() < deadline) {
      try {
        content = readFileSync(file, "utf-8");
      } catch {
        content = "";
      }
      if (content.includes("Autosaved")) break;
      await page.waitForTimeout(200);
    }
    expect(content).toContain("Autosaved");

    await page.close();
  }, 180000);

  it("rejects file writes from other origins and unknown sessions", async () => {
    const file = join(dir, "origin.drawio");
    writeFileSync(file, TWO_PAGE_FILE);
    const { payload } = await callToolJson<{ result: LoadResult }>(context, "load-document", {
      path: file,
      open_browser: false,
      wait_ms: 0,
    });
    const api = new URL(
      payload.result.url_path.replace("/file/", "api/files/"),
      context.baseUrl,
    ).toString();

    const foreign = await fetch(api, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ xml: "<mxfile/>" }),
    });
    expect(foreign.status).toBe(403);
    expect(readFileSync(file, "utf-8")).toBe(TWO_PAGE_FILE);

    const unknown = await fetch(new URL("api/files/not-a-session", context.baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ xml: "<mxfile/>" }),
    });
    expect(unknown.status).toBe(404);
  }, 60000);

  it("rejects unsupported file types", async () => {
    const refused = await callRaw("load-document", {
      path: join(dir, "picture.png"),
      open_browser: false,
      wait_ms: 0,
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("import-diagram");
  }, 60000);
});
