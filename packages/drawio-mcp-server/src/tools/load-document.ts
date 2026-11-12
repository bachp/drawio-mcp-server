import { spawn } from "node:child_process";

import { z } from "zod";

import { ToolRegistrar } from "./types.js";

export const TOOL_load_document = "load-document";

const DEFAULT_WAIT_MS = 30_000;

/** Opens `url` in the user's default browser without a shell. */
function open_in_browser(url: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {
    // No opener available: the URL is returned to the agent instead.
  });
  child.unref();
}

export const registerLoadDocumentTool: ToolRegistrar = (server, context) => {
  server.tool(
    TOOL_load_document,
    "Open a local .drawio/.dio/.xml file as a file-backed document in the editor served by this server (requires --editor). The document *is* the file: save-document (or Save in the editor) writes back to it. All other tools work on it as usual; list-documents shows its `file_path`. A missing file starts as an empty diagram and is created on the first save. If the file is already open, the existing document is returned.",
    {
      path: z
        .string()
        .describe(
          "Absolute path to the diagram file (.drawio, .dio or .xml) on the machine running the server",
        ),
      autosave: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Write every change to the file automatically instead of only on save",
        ),
      open_browser: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "Open the editor in the default browser. When false, open the returned `url` yourself",
        ),
      wait_ms: z
        .number()
        .int()
        .min(0)
        .max(120_000)
        .optional()
        .default(DEFAULT_WAIT_MS)
        .describe(
          "How long to wait for the editor tab to connect before returning",
        ),
    },
    async (args) => {
      const files = context.files;
      const origin = files?.editor_origin();
      if (!files || !origin) {
        throw new Error(
          "load-document requires the server to run with --editor (the built-in editor serves file-backed documents)",
        );
      }

      const { session, created } = await files.open(args.path, {
        autosave: args.autosave,
      });
      const urlPath = `/file/${session.id}`;
      const url = `${origin}${urlPath}`;

      const connected = (await context.document_routing.list_documents()).find(
        (document) => document.file_session === session.id,
      );

      let documentId = connected?.id ?? null;
      if (!documentId) {
        const waiting = files.wait_for_document(session.id, args.wait_ms);
        if (args.open_browser) {
          open_in_browser(url);
        }
        documentId = await waiting;
      }

      const result = {
        document_id: documentId,
        file_path: session.path,
        url,
        url_path: urlPath,
        autosave: session.autosave,
        already_open: !created && connected !== undefined,
      };
      const note = documentId
        ? `Loaded ${session.path}. Use target_document {"id":"${documentId}"} for further tools; save-document writes back to the file.`
        : `The editor tab has not connected yet. Open ${url} in a browser, then call list-documents.`;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ success: true, result, note }),
          },
        ],
      };
    },
  );
};
