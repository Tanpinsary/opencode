/** Persistent tree stored in .opencode/session-tree.json */
export interface SessionTree {
  version: 1
  projectId: string
  nodes: Record<string, SessionNode>
  /** Session ID of the root (main) node */
  root: string
}

/** A single node in the fork tree */
export interface SessionNode {
  /** Opencode session ID */
  id: string
  /** Human-readable name, e.g. "fix-auth", "refactor-db" */
  name: string
  /** Parent node's session ID, null for root */
  parentId: string | null
  /** Child node session IDs */
  children: string[]
  status: "active" | "merged" | "abandoned"
  /** ISO 8601 timestamp */
  createdAt: string
  mergedAt?: string
  abandonedAt?: string
  /** One-line goal set at fork creation */
  goal?: string
  /** Git commit SHA at the moment this fork was created — used by /rewind --hard */
  gitCommitAtFork?: string
  mergeLog?: MergeLog
}

/** Summary data generated at merge time */
export interface MergeLog {
  goal: string
  filesChanged: string[]
  decisions: string[]
  discoveries: string[]
  linesAdded: number
  linesRemoved: number
  /** The compact message sent to the parent session */
  summary: string
}

/** Stats extracted from `git diff --stat` */
export interface GitDiffStats {
  filesChanged: string[]
  linesAdded: number
  linesRemoved: number
}
