import path from "node:path";

/**
 * Shared path rule for tools that touch the server's file system
 * (`export-diagram`'s `output_path`, `import-diagram`'s `input_path`):
 * paths must be absolute, so they never depend on the server's working
 * directory. A path that one tool writes can be passed unchanged to the other.
 */
export function assertAbsolutePath(param: string, value: string): void {
  if (!path.isAbsolute(value)) {
    throw new Error(`${param} must be an absolute path`);
  }
}
