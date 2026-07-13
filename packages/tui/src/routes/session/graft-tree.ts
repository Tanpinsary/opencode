export type GraftStatus = "active" | "merged" | "abandoned"

export type GraftNode = {
  id: string
  name: string
  children: string[]
  status: GraftStatus
}

export type GraftTree = {
  root: string
  nodes: Record<string, GraftNode>
}

export type GraftRow = GraftNode & {
  prefix: string
  current: boolean
  expanded: boolean
}

export function parseGraftTree(raw: string): GraftTree | undefined {
  const value: unknown = JSON.parse(raw)
  if (!value || typeof value !== "object") return
  if (!("root" in value) || typeof value.root !== "string") return
  if (!("nodes" in value) || !value.nodes || typeof value.nodes !== "object") return
  return value as GraftTree
}

export function graftRows(tree: GraftTree, sessionID: string, collapsed: ReadonlySet<string> = new Set()): GraftRow[] {
  const rows: GraftRow[] = []
  const visited = new Set<string>()

  function visit(id: string, indent: string, last: boolean, root: boolean) {
    if (visited.has(id)) return
    const node = tree.nodes[id]
    if (!node) return
    visited.add(id)
    rows.push({
      ...node,
      prefix: root ? "" : `${indent}${last ? "└── " : "├── "}`,
      current: id === sessionID,
      expanded: node.children.length > 0 && !collapsed.has(id),
    })
    if (collapsed.has(id)) return
    const nextIndent = root ? "" : `${indent}${last ? "    " : "│   "}`
    node.children.forEach((child, index) => visit(child, nextIndent, index === node.children.length - 1, false))
  }

  visit(tree.root, "", true, true)
  return rows
}
