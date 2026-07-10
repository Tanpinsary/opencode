import type { SessionTree } from "../types"

function uniqueName(tree: SessionTree, requested: string, fallback: string): string {
  const base = requested.trim() || fallback
  const names = new Set(Object.values(tree.nodes).map((node) => node.name.toLowerCase()))
  if (!names.has(base.toLowerCase())) return base

  let suffix = 2
  while (names.has(`${base}-${suffix}`.toLowerCase())) suffix++
  return `${base}-${suffix}`
}

export function addFork(
  tree: SessionTree,
  input: {
    id: string
    name?: string
    fallbackName: string
    parentId: string
    goal?: string
    gitCommitAtFork?: string
  },
): SessionTree {
  if (tree.nodes[input.id]) return tree

  const parent = tree.nodes[input.parentId]
  if (!parent) throw new Error(`Parent session ${input.parentId} is not in the graft tree`)

  tree.nodes[input.id] = {
    id: input.id,
    name: uniqueName(tree, input.name ?? "", input.fallbackName),
    parentId: input.parentId,
    children: [],
    status: "active",
    createdAt: new Date().toISOString(),
    goal: input.goal?.trim() || undefined,
    gitCommitAtFork: input.gitCommitAtFork,
  }
  parent.children.push(input.id)
  return tree
}
