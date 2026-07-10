import { readFile, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import type { SessionTree } from "../types"

const DIR = ".opencode"
const FILENAME = "session-tree.json"

function treePath(directory: string): string {
  return join(directory, DIR, FILENAME)
}

/** Create an empty tree for the given project + root session */
export function createEmptyTree(projectId: string, rootSessionId: string, rootName = "main"): SessionTree {
  return {
    version: 1,
    projectId,
    root: rootSessionId,
    nodes: {
      [rootSessionId]: {
        id: rootSessionId,
        name: rootName,
        parentId: null,
        children: [],
        status: "active",
        createdAt: new Date().toISOString(),
      },
    },
  }
}

/** Load tree from disk. Returns null if not found. */
export async function loadTree(directory: string): Promise<SessionTree | null> {
  try {
    const raw = await readFile(treePath(directory), "utf-8")
    return JSON.parse(raw) as SessionTree
  } catch {
    return null
  }
}

/** Persist tree to disk, creating .opencode/ if needed. */
export async function saveTree(directory: string, tree: SessionTree): Promise<void> {
  await mkdir(join(directory, DIR), { recursive: true })
  await writeFile(treePath(directory), JSON.stringify(tree, null, 2), "utf-8")
}
