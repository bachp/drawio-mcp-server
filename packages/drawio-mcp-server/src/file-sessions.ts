import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { nanoid } from "nanoid";

import { assertAbsolutePath } from "./tools/file-path.js";
import { inferImportFormat } from "./tools/import-source.js";

/**
 * File-backed documents: a draw.io tab served by this server whose document
 * *is* a local file. The server reads the file when the tab loads and writes
 * it when the document is saved (by the agent via `save-document`, or by the
 * user/autosave inside the editor).
 */
export type FileSession = {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly autosave: boolean;
};

export class FileConflictError extends Error {
  constructor(filePath: string) {
    super(
      `${filePath} was changed on disk since it was loaded; reload it with load-document or save with overwrite: true`,
    );
    this.name = "FileConflictError";
  }
}

export type FileSessions = {
  /**
   * Opens (or reuses, when the same path is already open) a session for
   * `filePath`. A missing file is allowed and starts as an empty diagram;
   * it is created on the first save.
   */
  open: (
    filePath: string,
    options?: { autosave?: boolean },
  ) => Promise<{ session: FileSession; created: boolean }>;
  get: (id: string) => FileSession | undefined;
  /**
   * Reads the file for loading into the editor. The content read becomes
   * the new baseline for conflict detection. `xml` is null for a file that
   * does not exist yet.
   */
  read: (id: string) => Promise<{ session: FileSession; xml: string | null }>;
  /**
   * Writes `xml` to the session's file. Refuses with FileConflictError when
   * the file changed on disk since the last read/write, unless `overwrite`.
   */
  write: (
    id: string,
    xml: string,
    options?: { overwrite?: boolean },
  ) => Promise<{ session: FileSession; bytes: number }>;
  /**
   * Resolves with the outcome of the next write to the session's file
   * (from the host page's save), or null on timeout. Used by save-document
   * to report the result of the save it triggered.
   */
  wait_for_write: (sessionId: string, timeoutMs: number) => Promise<WriteOutcome | null>;
  /** Makes the next write to the session skip the conflict check once. */
  allow_next_overwrite: (sessionId: string) => void;
  /** Origin (scheme://host:port) the editor is served on, once known. */
  set_editor_origin: (origin: string) => void;
  editor_origin: () => string | null;
  /** Called when a tab reports a document belonging to a session. */
  notify_document: (sessionId: string, documentId: string) => void;
  /** Resolves with the document id once a tab for the session registers. */
  wait_for_document: (
    sessionId: string,
    timeoutMs: number,
  ) => Promise<string | null>;
};

export type WriteOutcome =
  | { ok: true; path: string; bytes: number }
  | { ok: false; path: string; error: string; conflict: boolean };

const SUPPORTED_EXTENSIONS = "`.drawio`, `.dio` or `.xml`";

function hashOf(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function readIfExists(filePath: string): Promise<Buffer | null> {
  try {
    return await readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function create_file_sessions(): FileSessions {
  const sessions = new Map<string, FileSession>();
  // Hash of the content the editor was last loaded from or last wrote;
  // null when the file did not exist at that point.
  const baselines = new Map<string, string | null>();
  const waiters = new Map<string, Set<(documentId: string) => void>>();
  const writeWaiters = new Map<string, Set<(outcome: WriteOutcome) => void>>();
  const overwriteOnce = new Set<string>();
  let origin: string | null = null;

  function require_session(id: string): FileSession {
    const session = sessions.get(id);
    if (!session) {
      throw new Error(`Unknown file session ${id}`);
    }
    return session;
  }

  return {
    async open(filePath, options = {}) {
      assertAbsolutePath("path", filePath);
      const resolved = path.resolve(filePath);

      if (inferImportFormat(resolved) !== "xml") {
        throw new Error(
          `load-document supports ${SUPPORTED_EXTENSIONS} files; use import-diagram for SVG or PNG`,
        );
      }
      const dir = path.dirname(resolved);
      if (!existsSync(dir) || !statSync(dir).isDirectory()) {
        throw new Error(`Directory does not exist: ${dir}`);
      }
      if (existsSync(resolved) && statSync(resolved).isDirectory()) {
        throw new Error(`path is a directory: ${resolved}`);
      }

      const existing = [...sessions.values()].find((s) => s.path === resolved);
      if (existing) {
        return { session: existing, created: false };
      }

      const content = await readIfExists(resolved);
      const session: FileSession = {
        id: nanoid(),
        path: resolved,
        title: path.basename(resolved),
        autosave: options.autosave === true,
      };
      sessions.set(session.id, session);
      baselines.set(session.id, content ? hashOf(content) : null);
      return { session, created: true };
    },

    get: (id) => sessions.get(id),

    async read(id) {
      const session = require_session(id);
      const content = await readIfExists(session.path);
      baselines.set(id, content ? hashOf(content) : null);
      return { session, xml: content ? content.toString("utf-8") : null };
    },

    async write(id, xml, options = {}) {
      const session = require_session(id);
      const overwrite = options.overwrite === true || overwriteOnce.has(id);
      overwriteOnce.delete(id);

      const notify = (outcome: WriteOutcome) => {
        const pending = writeWaiters.get(id);
        if (!pending) return;
        writeWaiters.delete(id);
        for (const resolve of pending) resolve(outcome);
      };

      try {
        const current = await readIfExists(session.path);
        const currentHash = current ? hashOf(current) : null;
        if (!overwrite && currentHash !== baselines.get(id)) {
          throw new FileConflictError(session.path);
        }

        // Write to a sibling temp file and rename, so a crash mid-write
        // never leaves a truncated diagram behind.
        const tmp = `${session.path}.${process.pid}.${Date.now()}.tmp`;
        await writeFile(tmp, xml, "utf-8");
        await rename(tmp, session.path);
        baselines.set(id, hashOf(xml));
        const bytes = Buffer.byteLength(xml, "utf-8");
        notify({ ok: true, path: session.path, bytes });
        return { session, bytes };
      } catch (error) {
        notify({
          ok: false,
          path: session.path,
          error: error instanceof Error ? error.message : String(error),
          conflict: error instanceof FileConflictError,
        });
        throw error;
      }
    },

    wait_for_write(sessionId, timeoutMs) {
      return new Promise((resolve) => {
        let set = writeWaiters.get(sessionId);
        if (!set) {
          set = new Set();
          writeWaiters.set(sessionId, set);
        }
        const onWrite = (outcome: WriteOutcome) => {
          clearTimeout(timer);
          resolve(outcome);
        };
        const timer = setTimeout(() => {
          writeWaiters.get(sessionId)?.delete(onWrite);
          resolve(null);
        }, timeoutMs);
        set.add(onWrite);
      });
    },

    allow_next_overwrite(sessionId) {
      require_session(sessionId);
      overwriteOnce.add(sessionId);
    },

    set_editor_origin(value) {
      origin = value;
    },

    editor_origin: () => origin,

    notify_document(sessionId, documentId) {
      const pending = waiters.get(sessionId);
      if (!pending) return;
      waiters.delete(sessionId);
      for (const resolve of pending) {
        resolve(documentId);
      }
    },

    wait_for_document(sessionId, timeoutMs) {
      return new Promise((resolve) => {
        let set = waiters.get(sessionId);
        if (!set) {
          set = new Set();
          waiters.set(sessionId, set);
        }
        const done = (documentId: string | null) => {
          clearTimeout(timer);
          waiters.get(sessionId)?.delete(onDocument);
          resolve(documentId);
        };
        const onDocument = (documentId: string) => done(documentId);
        const timer = setTimeout(() => done(null), timeoutMs);
        set.add(onDocument);
      });
    },
  };
}
