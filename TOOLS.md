# Tools Reference

The Draw.io MCP server provides the following MCP tools for programmatic diagram interaction.

## Document Targeting

All live Draw.io tools operate on a connected Draw.io browser tab. Use `list-documents` to inspect the currently connected document instances.

Each document instance exposes:

- `id`
- `title`
- `mode`
- `hash`
- `file_url`
- `page_count`
- `current_page`

Routing rules:

- If no Draw.io documents are connected, live tools fail with `No connected Draw.io documents`.
- If exactly one Draw.io document is connected, `target_document` is optional and the server auto-targets it.
- If multiple Draw.io documents are connected, every live tool must include `target_document: { "id": "..." }` from `list-documents`.
- Document IDs are instance IDs for the currently connected browser tabs, not filesystem paths.
- Opening the same underlying `.drawio` file in two tabs yields two different document instances.
- The server only signals existing Draw.io tabs. It does not open files, open tabs, or switch tabs for you.

## Page Targeting

Page-scoped tools additionally require a `target_page` selector so multiple agents can safely work on different pages inside the selected Draw.io document.

Use exactly one of:

- `{ "index": 0 }`
- `{ "id": "page-id-from-list-pages" }`

Notes:

- Page indices are zero-based and come from `list-pages`.
- Page IDs are stable within the selected document and are recommended for agent workflows.
- Live tool calls are serialized per connected document in FIFO order, so concurrent agents do not interleave page switches and writes inside the same browser tab.
- Most page model tools mutate or inspect off-page content without switching the visible browser page.
- UI-bound tools such as `get-selected-cell`, `set-active-layer`, `get-active-layer`, `import-diagram`, selection-only `export-diagram`, and PNG `export-diagram` with `embed_xml=true` still operate through the visible page and may switch it.
- Shape library tools (`get-shape-categories`, `get-shapes-in-category`, `get-shape-by-name`) do not require `target_page`, but they still resolve against a single connected document and therefore use `target_document` when multiple documents are connected.

## Document Tools

### `list-documents`

Lists all currently connected Draw.io document instances.

*Returns*: Array of document objects with `id`, `title`, `mode`, `hash`, `file_url`, `page_count`, and `current_page`. File-backed documents (see `load-document`) also have `file_session` and `file_path`.

### `load-document`

Opens a local `.drawio`, `.dio`, or `.xml` file as a **file-backed document**: the document *is* the file. Requires the built-in editor (`--editor`).

The server serves the editor at `/file/<session>` in draw.io embed mode and loads the file into it, with all pages. Every other tool works on the document as usual. `save-document` (or **Save** in the editor) writes the file.

Notes:
- The path follows the same rule as `export-diagram`'s `output_path`: it must be an absolute path on the machine running the server.
- A missing file starts as an empty diagram. The server creates the file on the first save.
- If the file is already open, the call returns the existing document instead of opening a second tab.
- Before each write, the server checks that the file was not changed on disk since it was loaded or last saved. If it was, the save fails (see `save-document`'s `overwrite`).
- SVG and PNG files are not supported. Use `import-diagram` for those.

*Parameters*:
- `path`: Absolute path to the diagram file
- `autosave`: Write every change to the file automatically instead of only on save (default: false)
- `open_browser`: Open the editor in the default browser (default: true). When false, open the returned `url` yourself
- `wait_ms`: How long to wait for the editor tab to connect before returning (default: 30000)

*Returns*: `document_id` (null if the tab has not connected yet), `file_path`, `url`, `url_path`, `autosave`, and `already_open`

### `set-document-title`

Renames the selected Draw.io document through its active storage provider. When the new title omits an extension, the current `.drawio`, `.drawio.svg`, `.drawio.png`, `.xml`, `.svg`, or `.png` suffix is preserved.

*Parameters*:
- `title`: New document title, with or without the existing extension

*Returns*: The previous and resulting document titles

### `save-document`

Triggers Draw.io's existing **File → Save** action for the selected document, preserving the editor's current storage mode.

For a **file-backed document** (opened with `load-document`), the save writes the local file, and the call returns once the file is written. If the file was changed on disk since it was loaded or last saved, the save fails, unless `overwrite` is true.

For other documents, the call confirms that the save flow was triggered. Authentication, conflict, permission, or **Save As** prompts may still require user interaction in the Draw.io tab.

*Parameters*:
- `overwrite`: File-backed documents only: write even if the file was changed on disk (default: false)

*Returns*: For file-backed documents, `saved`, `file_path`, and `bytes`. For other documents, the trigger status plus the current document title and storage mode

## Diagram Inspection Tools

### `get-selected-cell`

Retrieves the currently selected cell on the target page.

*Parameters*:
- `target_page`: Page selector for the page to inspect

*Returns*: JSON object containing cell properties (ID, geometry, style, value, etc.)

### `get-shape-categories`

Retrieves available shape categories from the diagram's library. Categories cover the curated `general` set plus every vendor palette drawio ships — AWS (`mxgraph.aws4.*`), GCP (`mxgraph.gcp2.*`), Azure (`mxgraph.azure2.*`), Cisco19 (`mxgraph.cisco19.*`), and CiscoSafe (`mxgraph.cisco_safe.*`) — discovered at runtime from drawio's loaded sidebar, so the catalog always matches the editor version in use.

*Returns*: Array of category objects with their IDs and names

### `get-shapes-in-category`

Retrieves all shapes in a specified category from the diagram's library.

*Parameters*:
- `category_id`: Identifier of the category to retrieve shapes from

*Returns*: Array of shape objects with their properties and styles

### `get-shape-by-name`

Retrieves a specific shape by its name from all available shapes (general + AWS / GCP / Azure / Cisco19 / CiscoSafe vendors discovered at runtime).

*Parameters*:
- `shape_name`: Name of the shape to retrieve (e.g. `mxgraph.gcp2.cloud_functions`, `mxgraph.cisco19.router`, `mxgraph.cisco_safe.capability`)

*Returns*: Shape object including its category and style information

### `list-paged-model`

Retrieves a paginated view of all cells (vertices and edges) on the target page. This tool provides access to the complete model data with essential fields only, sanitized to remove circular dependencies and excessive data. Allows filtering based on multiple criteria and attribute boolean logic.

*Parameters*:
- `target_page`: Page selector for the page to inspect
- `page`: Zero-based result page for pagination
- `page_size`: Maximum number of returned cells
- `filter`: Optional filter criteria

## MCP Apps Tools

### `show-diagram`

Returns the current diagram XML. On MCP Apps-capable hosts (Claude Desktop, QuixiDesk, MCPJam, VS Code Copilot) the diagram is rendered as an interactive draw.io editor inside the conversation: the framed editor displays the diagram, connects to the server's WebSocket bridge, and registers there as a live document — it appears in `list-documents` (in embed mode) and agent tool calls (e.g. `add-rectangle`) apply to it, verified in headless E2E. Syncing user-side edits made in the framed editor remains pending real-browser verification. On other clients, the raw XML text is returned as plain text.

The in-chat editor is served by the `ui://drawio/editor.html` MCP app resource, a self-contained HTML shell that frames the locally served draw.io editor. The server must run with `--editor` so the framed editor can be served, and the MCP host must be able to reach `http://localhost:<http-port>`.

**Host support:** live embedded editing requires a host that honors `_meta.ui.csp.frameDomains` (MCPJam default, ChatGPT, Cursor, Copilot, VS Code, Gemini, and the official ext-apps basic-host do). Hosts that don't (Claude Desktop / claude.ai, Slack, Notion, …) get a read-only preview of the current diagram instead, plus a link to open the editor in a normal browser tab — where diagram editing and the tools keep working; the tools themselves are unaffected either way.

Like all live tools, it targets a connected document, but it also works cold: with no connected Draw.io documents (and no `target_document` passed), it returns a blank diagram instead of an error, so the app opens an empty canvas to start drawing from; with several connected documents pass `target_document`. An explicit `target_document` with an unknown id still errors.

*Parameters*:
- `target_page`: Page selector for the page to show; use exactly one of `{ index }` or `{ id }`
- `target_document`: Optional document selector from `list-documents`; required when multiple documents are connected

*Returns*: The current diagram XML (the same XML an `export-diagram` call with `format: "xml"` and `size: "diagram"` returns, without the export status line)

## Diagram Modification Tools

### `add-rectangle`

Creates a new rectangle shape on the target page with customizable properties:

- `target_page`: Page selector for the page to modify
- Position (`x`, `y` coordinates)
- Dimensions (`width`, `height`)
- Text content
- Visual style (fill color, stroke, etc. using Draw.io style syntax)
- Parent cell (`parent_id`) to create as a child of another shape

### `add-edge`

Creates a connection between two cells (vertices). When source and target are the same shape (self-connector), a loop edge style is automatically applied so the line is visible and selectable.

*Parameters*:
- `target_page`: Page selector for the page to modify
- `source_id`: ID of the source cell
- `target_id`: ID of the target cell
- `text`: Optional text label for the edge
- `style`: Optional style properties for the edge
- `points`: Optional array of `{x, y}` waypoints to control edge routing (useful for custom paths or self-connectors)
- `parent_id`: Optional ID of parent cell (creates as child instead of at diagram root)

### `delete-cell-by-id`

Removes a specified cell from the diagram.

*Parameters*:
- `target_page`: Page selector for the page to modify
- `cell_id`: ID of the cell to delete

### `add-cell-of-shape`

Adds a new cell of a specific shape type from the diagram's library.

*Parameters*:
- `target_page`: Page selector for the page to modify
- `shape_name`: Name of the shape to create
- `x`, `y`: Position coordinates (optional)
- `width`, `height`: Dimensions (optional)
- `text`: Optional text content
- `style`: Optional additional style properties
- `parent_id`: Optional ID of parent cell (creates as child instead of at diagram root)

### `set-cell-shape`

Applies a library shape's style to an existing cell.

*Parameters*:
- `target_page`: Page selector for the page to modify
- `cell_id`: ID of the cell whose appearance should change
- `shape_name`: Name of the library shape whose style should be applied

### `set-cell-data`

Stores or updates a custom attribute on a cell.

*Parameters*:
- `target_page`: Page selector for the page to modify
- `cell_id`: ID of the cell to update
- `key`: Attribute name to set
- `value`: Attribute value (stored as a string internally)

### `edit-cell`

Updates an existing vertex/shape cell in place by ID.

*Parameters*:
- `target_page`: Page selector for the page to modify
- `cell_id`: ID of the cell whose properties should change (required)
- `text`, `x`, `y`, `width`, `height`, `style`: Optional fields to update on the cell; omitted properties stay as-is

### `edit-edge`

Updates an existing edge connection between cells by ID.

*Parameters*:
- `target_page`: Page selector for the page to modify
- `cell_id`: ID of the edge cell to update (required)
- `text`: Optional edge label text
- `source_id`, `target_id`: Optional IDs of new source/target cells
- `style`: Optional replacement style string
- `points`: Optional array of `{x, y}` waypoints to set edge geometry control points (replaces existing waypoints; use empty array to clear)

### `set-cell-parent`

Sets the parent of a cell, making it a child of the specified parent cell. This allows creating hierarchical relationships where moving the parent also moves its children.

*Parameters*:
- `target_page`: Page selector for the page to modify
- `cell_id`: ID of the cell to reparent
- `parent_id`: ID of the new parent cell

*Returns*: Confirmation with cell_id and parent_id

## Page Management Tools

### `list-pages`

Lists all pages in the target/current Draw.io document.

*Returns*: Array of page objects with `index`, `id`, `name`, and `is_current`

### `get-current-page`

Returns metadata for the currently visible page in the target/current Draw.io document.

*Returns*: Page object with `index`, `id`, `name`, and `is_current`

### `create-page`

Creates a new blank page and appends it to the target/current document. On supported draw.io runtimes, this does not switch the visible page.

*Parameters*:
- `name`: Name for the new page

*Returns*: Metadata for the created page

### `copy-page`

Creates a copy of an existing page in the target/current document and appends the copy to the end of the page list. When possible, the previously visible page is restored after the copy is created.

*Parameters*:
- `page`: Source page selector for the page to copy. Use exactly one of `{ index }` or `{ id }`
- `name`: Optional name for the copied page

*Returns*: Metadata for the copied page

### `rename-page`

Renames a page in the target/current document without switching the visible page.

*Parameters*:
- `page`: Page selector for the page to rename. Use exactly one of `{ index }` or `{ id }`
- `name`: New page name

*Returns*: Metadata for the renamed page

## Layer Management Tools

*Available since v1.7.0*

### `list-layers`

Lists all available layers on the target page with their IDs and names.

*Parameters*:
- `target_page`: Page selector for the page to inspect

*Returns*: Array of layer objects with properties (ID, name, visibility, locked status)

### `set-active-layer`

Sets the active layer for creating new elements. All subsequent element creation will happen in this layer.

*Parameters*:
- `target_page`: Page selector for the page to modify
- `layer_id`: ID of the layer to set as active

*Returns*: Information about the newly active layer

### `move-cell-to-layer`

Moves a cell from its current layer to a target layer.

*Parameters*:
- `target_page`: Page selector for the page to modify
- `cell_id`: ID of the cell to move
- `target_layer_id`: ID of the target layer where the cell will be moved

*Returns*: Confirmation of the move operation

### `get-active-layer`

Gets the currently active layer information for the target page.

*Parameters*:
- `target_page`: Page selector for the page to inspect

*Returns*: Information about the current active layer (ID and name)

### `create-layer`

Creates a new layer on the target page.

*Parameters*:
- `target_page`: Page selector for the page to modify
- `name`: Name for the new layer

*Returns*: Information about the newly created layer

## Diagram Import/Export Tools

### `export-diagram`

Export the target page or current diagram as SVG, PNG, or XML. Returns the diagram data as base64 (PNG) or text (SVG/XML). Optionally saves to a file.

Notes:
- Page and diagram exports for off-page targets run without switching the visible browser page.
- Selection-only exports still use the visible page because selection is a UI-bound concept in Draw.io.
- PNG exports with `embed_xml=true` also use the visible page because Draw.io's embedded PNG export path is still UI-bound.

*Parameters*:
- `target_page`: Page selector for the page context used by the export
- `format`: Export format: svg for vector graphics, png for raster image, xml for raw diagram data
- `scale`: Zoom factor for the export (1 = 100%, default: 1)
- `border`: Border width in pixels around the diagram (default: 0)
- `background`: Background color in hex format (e.g., #ffffff, default: #ffffff)
- `shadow`: Include shadow effects in the export (default: false)
- `crop`: Crop the export to diagram bounds (true) or full page (false, default: true)
- `selection_only`: Export only the currently selected cells (default: false)
- `transparent`: Use transparent background (overrides background color, default: false)
- `dpi`: DPI for PNG export (affects quality, default: 96)
- `embed_xml`: Embed the diagram XML data in SVG/PNG so it can be reopened in draw.io (default: false)
- `size`: What to export: 'selection' for selected cells only, 'page' for the target page, 'diagram' for the entire model (default: diagram)
- `output_path`: Absolute file path to save the exported file (must be an absolute path). XML files, and SVG/PNG files exported with `embed_xml=true`, can be loaded back with `import-diagram`'s `input_path`

*Returns*: Export result with format, mimeType, data (base64 for PNG, text for SVG/XML), dimensions, and optional warning

### `import-diagram`

Import a diagram from XML, SVG with embedded XML, or PNG with embedded XML into the current Draw.io instance. Pass the content inline with `data`, or pass `input_path` so the server reads a local file from disk.

Notes:
- Use exactly one of `data` or `input_path`.
- `input_path` follows the same rule as `export-diagram`'s `output_path`: it must be an absolute path on the machine running the server. A file written by `export-diagram` (XML, or SVG/PNG with `embed_xml=true`) loads back unchanged from the same path.
- For SVG and PNG input, the server extracts the embedded diagram (the SVG `content` attribute or the PNG `mxfile` text chunk) before import, so files exported by draw.io or by `export-diagram` with `embed_xml=true` load correctly.
- Compressed `<diagram>` content, which older draw.io versions save by default, is expanded before import.

*Parameters*:
- `target_page`: Required for `replace` and `add`; optional for `new-page`
- `data`: The diagram data: raw XML string, or base64-encoded SVG/PNG with embedded XML
- `input_path`: Absolute path to a local diagram file (`.drawio`, `.dio`, `.xml`, `.svg`, `.drawio.svg`, `.png`, `.drawio.png`)
- `format`: Input format: xml for raw Draw.io XML, svg for SVG with embedded XML, png for PNG with embedded XML. Required with `data`; inferred from the file extension with `input_path` when omitted
- `mode`: Import mode: replace clears current diagram and loads new one, add merges imported cells into current diagram, new-page creates a new page with imported diagram (default: replace)
- `filename`: Optional original filename for context; defaults to the base name of `input_path`

*Returns*: Import result with success status, message, and optional page/cell counts

### `import-mermaid`

Import a Mermaid diagram into a Draw.io page. The conversion runs inside the Draw.io editor using its bundled Mermaid pipeline. Native mode converts supported Mermaid diagrams into mxGraph cells; embed mode creates a single image cell with Mermaid source preserved for Draw.io re-editing.

*Parameters*:
- `target_page`: Required for `replace` and `add`; optional for `new-page`
- `mermaid_source`: Raw Mermaid syntax
- `mode`: Import mode: native converts to mxGraph cells when supported, embed preserves Mermaid source in an image cell (default: native)
- `insert_mode`: How to merge the converted XML: replace, add, or new-page (default: add)

*Returns*: Import result with success status, message, converted mode, optional cell count, and converted XML
