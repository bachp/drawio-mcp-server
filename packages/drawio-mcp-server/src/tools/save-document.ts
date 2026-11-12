import { z } from "zod";

import { default_tool } from "../tool.js";
import { ToolRegistrar } from "./types.js";

export const TOOL_save_document = "save-document";

const FILE_SAVE_TIMEOUT_MS = 15_000;

export const registerSaveDocumentTool: ToolRegistrar = (server, context) => {
  server.tool(
    TOOL_save_document,
    "Triggers Draw.io's existing File > Save action for the current document. For a file-backed document (opened with load-document), this writes the local file and returns once it is written; it fails if the file was changed on disk since it was loaded, unless `overwrite` is true. For other documents, the active storage provider may display an authentication, conflict, or Save As prompt that requires user interaction.",
    {
      overwrite: z
        .boolean()
        .optional()
        .describe(
          "File-backed documents only: write even if the file was changed on disk since it was loaded",
        ),
    },
    async (args, extra) => {
      const handler = default_tool(TOOL_save_document, context, {
        queue: true,
      });

      const resolved =
        await context.document_routing.resolve_target_document(args);
      const sessionId = resolved.document.file_session;
      const files = context.files;

      if (!sessionId || !files) {
        return handler(args, extra);
      }

      // File-backed: File > Save in embed mode hands the XML to the host
      // page, which posts it to the server; wait for that write.
      const written = files.wait_for_write(sessionId, FILE_SAVE_TIMEOUT_MS);
      if (args.overwrite) {
        files.allow_next_overwrite(sessionId);
      }
      const triggered = await handler(
        { ...args, target_document: resolved.target_document },
        extra,
      );
      const reply = JSON.parse(
        (triggered.content[0] as { text: string }).text,
      ) as { success?: boolean; error?: unknown };
      if (reply.success !== true) {
        return triggered;
      }

      const outcome = await written;
      if (!outcome) {
        throw new Error(
          `Save was triggered but ${resolved.document.file_path} was not written within ${FILE_SAVE_TIMEOUT_MS / 1000}s; check the editor tab`,
        );
      }
      if (!outcome.ok) {
        throw new Error(outcome.error);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              result: {
                saved: true,
                file_path: outcome.path,
                bytes: outcome.bytes,
              },
            }),
          },
        ],
      };
    },
  );
};
