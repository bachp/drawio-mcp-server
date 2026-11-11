import { z } from "zod";

import { default_tool } from "../tool.js";
import { resolveImportSource } from "./import-source.js";
import { target_page_field } from "./shared.js";
import { ToolRegistrar } from "./types.js";

export const TOOL_import_diagram = "import-diagram";

export const registerImportDiagramTool: ToolRegistrar = (server, context) => {
  server.tool(
    TOOL_import_diagram,
    "Import a diagram from XML, SVG with embedded XML, or PNG with embedded XML into the current Draw.io instance. Provide the content inline via `data`, or pass `input_path` to load a local file (.drawio, .xml, .svg, .png) that the server reads from disk. `target_page` is required for `replace` and `add`, and optional for `new-page`.",
    {
      target_page: target_page_field().optional(),
      data: z
        .string()
        .optional()
        .describe(
          "The diagram data: raw XML string, or base64-encoded SVG/PNG with embedded XML. Use either `data` or `input_path`, not both",
        ),
      input_path: z
        .string()
        .optional()
        .describe(
          "Absolute path to a local diagram file (.drawio, .dio, .xml, .svg, .drawio.svg, .png, .drawio.png) that the server reads from disk. Use either `data` or `input_path`, not both",
        ),
      format: z
        .enum(["xml", "svg", "png"])
        .optional()
        .describe(
          "Input format: xml for raw Draw.io XML, svg for SVG with embedded XML, png for PNG with embedded XML. Required with `data`; inferred from the file extension with `input_path` when omitted",
        ),
      mode: z
        .enum(["replace", "add", "new-page"])
        .optional()
        .default("replace")
        .describe(
          "Import mode: replace clears current diagram and loads new one, add merges imported cells into current diagram, new-page creates a new page with imported diagram",
        ),
      filename: z
        .string()
        .optional()
        .describe(
          "Optional original filename for context; defaults to the base name of `input_path`",
        ),
    },
    async (args, extra) => {
      if (args.mode !== "new-page" && !args.target_page) {
        throw new Error(
          "`target_page` is required when import-diagram mode is `replace` or `add`",
        );
      }

      const { input_path: _inputPath, ...rest } = args;
      const source = await resolveImportSource(args);

      const handler = default_tool(TOOL_import_diagram, context, {
        queue: true,
      });
      return handler({ ...rest, ...source }, extra);
    },
  );
};
