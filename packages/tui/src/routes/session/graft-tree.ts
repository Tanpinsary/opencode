export type GraftStatus = "active" | "merged" | "abandoned"

export type GraftNode = {
  id: string
  name: string
  parentId?: string | null
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
  const parents = new Map<string, string>()
  Object.values(tree.nodes).forEach((node) => {
    if (node.parentId && tree.nodes[node.parentId]) parents.set(node.id, node.parentId)
    node.children.forEach((child) => {
      if (tree.nodes[child] && !parents.has(child)) parents.set(child, node.id)
    })
  })

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

  const currentRoot = (() => {
    const seen = new Set<string>()
    let id: string | undefined = sessionID
    while (id && !seen.has(id)) {
      seen.add(id)
      const node = tree.nodes[id]
      const parent = parents.get(id)
      if (!parent) return node?.id
      id = parent
    }
  })()
  const roots = [
    currentRoot,
    tree.root,
    ...Object.values(tree.nodes)
      .filter((node) => !parents.has(node.id))
      .map((node) => node.id),
  ].filter((id, index, all): id is string => Boolean(id) && all.indexOf(id) === index)

  roots.forEach((id) => visit(id, "", true, true))
  return rows
}
