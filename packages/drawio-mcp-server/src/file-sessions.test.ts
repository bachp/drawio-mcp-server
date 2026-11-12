import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";

import { create_file_sessions, FileConflictError } from "./file-sessions.js";

const XML = '<mxfile><diagram id="p1" name="Page-1"><mxGraphModel><root><mxCell id="0"/></root></mxGraphModel></diagram></mxfile>';

describe("file sessions", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "file-sessions-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("opens an existing file and reads it", async () => {
    const file = path.join(dir, "a.drawio");
    writeFileSync(file, XML);
    const files = create_file_sessions();
    const { session, created } = await files.open(file);
    expect(created).toBe(true);
    expect(session).toMatchObject({ path: file, title: "a.drawio", autosave: false });
    await expect(files.read(session.id)).resolves.toMatchObject({ xml: XML });
  });

  it("reuses the session for the same path", async () => {
    const file = path.join(dir, "reuse.drawio");
    writeFileSync(file, XML);
    const files = create_file_sessions();
    const first = await files.open(file);
    const second = await files.open(path.join(dir, ".", "reuse.drawio"));
    expect(second.created).toBe(false);
    expect(second.session.id).toBe(first.session.id);
  });

  it("validates path, extension and directory", async () => {
    const files = create_file_sessions();
    await expect(files.open("rel.drawio")).rejects.toThrow("absolute path");
    await expect(files.open(path.join(dir, "x.svg"))).rejects.toThrow("import-diagram");
    await expect(files.open(path.join(dir, "missing-dir", "x.drawio"))).rejects.toThrow("Directory does not exist");
    mkdirSync(path.join(dir, "folder.drawio"));
    await expect(files.open(path.join(dir, "folder.drawio"))).rejects.toThrow("is a directory");
  });

  it("allows a missing file, reads null, and creates it on write", async () => {
    const file = path.join(dir, "new.drawio");
    const files = create_file_sessions();
    const { session } = await files.open(file, { autosave: true });
    expect(session.autosave).toBe(true);
    await expect(files.read(session.id)).resolves.toMatchObject({ xml: null });
    await files.write(session.id, XML);
    expect(readFileSync(file, "utf-8")).toBe(XML);
  });

  it("writes repeatedly while nobody else touches the file", async () => {
    const file = path.join(dir, "write.drawio");
    writeFileSync(file, XML);
    const files = create_file_sessions();
    const { session } = await files.open(file);
    await files.write(session.id, `${XML}<!--1-->`);
    const result = await files.write(session.id, `${XML}<!--2-->`);
    expect(result.bytes).toBe(Buffer.byteLength(`${XML}<!--2-->`));
    expect(readFileSync(file, "utf-8")).toBe(`${XML}<!--2-->`);
  });

  it("refuses to overwrite external changes unless overwrite is set", async () => {
    const file = path.join(dir, "conflict.drawio");
    writeFileSync(file, XML);
    const files = create_file_sessions();
    const { session } = await files.open(file);
    writeFileSync(file, `${XML}<!--external-->`);
    await expect(files.write(session.id, XML)).rejects.toBeInstanceOf(FileConflictError);
    expect(readFileSync(file, "utf-8")).toBe(`${XML}<!--external-->`);
    await files.write(session.id, XML, { overwrite: true });
    expect(readFileSync(file, "utf-8")).toBe(XML);
  });

  it("treats a re-read as the new baseline", async () => {
    const file = path.join(dir, "reread.drawio");
    writeFileSync(file, XML);
    const files = create_file_sessions();
    const { session } = await files.open(file);
    writeFileSync(file, `${XML}<!--external-->`);
    await files.read(session.id);
    await expect(files.write(session.id, XML)).resolves.toBeDefined();
  });

  it("detects a file created externally after opening a missing path", async () => {
    const file = path.join(dir, "race.drawio");
    const files = create_file_sessions();
    const { session } = await files.open(file);
    writeFileSync(file, XML);
    await expect(files.write(session.id, XML)).rejects.toBeInstanceOf(FileConflictError);
  });

  it("resolves document waiters on notify and times out otherwise", async () => {
    const files = create_file_sessions();
    const waiting = files.wait_for_document("s1", 1000);
    files.notify_document("s1", "doc-1");
    await expect(waiting).resolves.toBe("doc-1");
    await expect(files.wait_for_document("s2", 10)).resolves.toBeNull();
  });

  it("rejects unknown sessions", async () => {
    const files = create_file_sessions();
    await expect(files.read("nope")).rejects.toThrow("Unknown file session");
    await expect(files.write("nope", XML)).rejects.toThrow("Unknown file session");
  });

  it("reports write outcomes to waiters", async () => {
    const file = path.join(dir, "notify.drawio");
    writeFileSync(file, XML);
    const files = create_file_sessions();
    const { session } = await files.open(file);

    const ok = files.wait_for_write(session.id, 1000);
    await files.write(session.id, `${XML}<!--saved-->`);
    await expect(ok).resolves.toEqual({
      ok: true,
      path: file,
      bytes: Buffer.byteLength(`${XML}<!--saved-->`),
    });

    writeFileSync(file, `${XML}<!--external-->`);
    const failed = files.wait_for_write(session.id, 1000);
    await expect(files.write(session.id, XML)).rejects.toThrow();
    await expect(failed).resolves.toMatchObject({ ok: false, conflict: true });

    await expect(files.wait_for_write(session.id, 10)).resolves.toBeNull();
  });

  it("allow_next_overwrite skips the conflict check once", async () => {
    const file = path.join(dir, "once.drawio");
    writeFileSync(file, XML);
    const files = create_file_sessions();
    const { session } = await files.open(file);
    writeFileSync(file, `${XML}<!--external-->`);
    files.allow_next_overwrite(session.id);
    await files.write(session.id, XML);
    writeFileSync(file, `${XML}<!--external-2-->`);
    await expect(files.write(session.id, XML)).rejects.toBeInstanceOf(FileConflictError);
  });
});
