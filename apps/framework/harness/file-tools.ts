import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { mkdirSync } from "node:fs";
import { jsonSchema, tool, type ToolSet } from "ai";
import type { FileEndpoint, ToolCallRecord } from "./types.js";

export const FILE_ENDPOINTS: FileEndpoint[] = [
  "files.list",
  "files.read",
  "files.write",
  "files.edit",
];

export function buildFileTools(
  workspace: string,
  toolCalls?: ToolCallRecord[]
): ToolSet {
  const root = resolve(workspace);

  const record = async <T>(
    endpoint: FileEndpoint,
    body: Record<string, unknown>,
    fn: () => Promise<T> | T
  ): Promise<T> => {
    const rec: ToolCallRecord = { endpoint, body, ts: Date.now() };
    try {
      const result = await fn();
      rec.result = result;
      toolCalls?.push(rec);
      return result;
    } catch (error) {
      rec.error = error instanceof Error ? error.message : String(error);
      toolCalls?.push(rec);
      throw error;
    }
  };

  return {
    files_list: tool({
      description:
        "List files in the project workspace. Paths are relative to the workspace root.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          path: { type: "string", description: "Optional relative directory path." },
        },
      }),
      execute: async (input) =>
        record("files.list", (input as Record<string, unknown>) ?? {}, () => {
          const p = resolveWorkspacePath(root, String((input as any)?.path ?? "."));
          if (!existsSync(p)) return { entries: [] };
          if (!statSync(p).isDirectory()) {
            throw new Error("files.list path must be a directory");
          }
          return {
            entries: readdirSync(p)
              .map((entry) => {
                const full = resolve(p, entry);
                const type = statSync(full).isDirectory() ? "dir" : "file";
                return { path: relative(root, full), type };
              })
              .sort((a, b) => a.path.localeCompare(b.path)),
          };
        }),
    }),
    files_read: tool({
      description: "Read a UTF-8 text file from the project workspace.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path to read." },
        },
        required: ["path"],
      }),
      execute: async (input) =>
        record("files.read", (input as Record<string, unknown>) ?? {}, () => {
          const p = resolveWorkspacePath(root, String((input as any)?.path ?? ""));
          if (!statSync(p).isFile()) throw new Error("files.read path must be a file");
          return { contents: readFileSync(p, "utf8") };
        }),
    }),
    files_write: tool({
      description:
        "Write a UTF-8 text file in the project workspace, creating parent directories if needed.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path to write." },
          contents: { type: "string", description: "Full file contents." },
        },
        required: ["path", "contents"],
      }),
      execute: async (input) =>
        record("files.write", (input as Record<string, unknown>) ?? {}, () => {
          const p = resolveWorkspacePath(root, String((input as any)?.path ?? ""));
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, String((input as any)?.contents ?? ""));
          return { ok: true };
        }),
    }),
    files_edit: tool({
      description:
        "Replace exactly one string occurrence in a UTF-8 text file in the project workspace.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path to edit." },
          old_string: { type: "string", description: "Exact text to replace." },
          new_string: { type: "string", description: "Replacement text." },
        },
        required: ["path", "old_string", "new_string"],
      }),
      execute: async (input) =>
        record("files.edit", (input as Record<string, unknown>) ?? {}, () => {
          const p = resolveWorkspacePath(root, String((input as any)?.path ?? ""));
          const oldString = String((input as any)?.old_string ?? "");
          const newString = String((input as any)?.new_string ?? "");
          const contents = readFileSync(p, "utf8");
          const first = contents.indexOf(oldString);
          if (first === -1) throw new Error("old_string was not found");
          if (contents.indexOf(oldString, first + oldString.length) !== -1) {
            throw new Error("old_string must be unique in the file");
          }
          writeFileSync(p, contents.replace(oldString, newString));
          return { ok: true };
        }),
    }),
  };
}

function resolveWorkspacePath(root: string, userPath: string): string {
  if (!userPath || userPath.startsWith("/") || userPath.includes("\0")) {
    throw new Error("path must be relative to the workspace");
  }
  const resolved = resolve(root, userPath);
  const rel = relative(root, resolved);
  if (rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error("path escapes workspace");
  }
  return resolved;
}
