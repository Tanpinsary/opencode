import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { SessionNode, SessionTree } from "../types"

const recentDays = 7

function isRecent(isoDate: string): boolean {
  return Date.now() - new Date(isoDate).getTime() < recentDays * 24 * 60 * 60 * 1000
}

function renderDetailed(node: SessionNode): string[] {
  const log = node.mergeLog
  const fileCount = log?.filesChanged.length ?? 0
  const lines = [
    `- **${node.name}**: ${log?.goal || node.goal || "(no goal)"}, ${fileCount} file${fileCount === 1 ? "" : "s"} changed`,
  ]
  for (const decision of log?.decisions ?? []) lines.push(`  - Decision: ${decision}`)
  for (const discovery of log?.discoveries ?? []) lines.push(`  - Discovery: ${discovery}`)
  return lines
}

function renderOneLine(node: SessionNode): string {
  return `- ${node.name}: ${node.mergeLog?.goal || node.goal || node.mergeLog?.summary || ""}`
}

export async function writeRegistry(directory: string, tree: SessionTree): Promise<void> {
  const active = Object.values(tree.nodes).filter((node) => node.id !== tree.root && node.status === "active")
  const recent = Object.values(tree.nodes).filter(
    (node) => node.id !== tree.root && node.status === "merged" && node.mergedAt && isRecent(node.mergedAt),
  )
  const history = Object.values(tree.nodes).filter(
    (node) => node.id !== tree.root && node.status !== "active" && !recent.includes(node),
  )
  recent.sort((left, right) => new Date(right.mergedAt!).getTime() - new Date(left.mergedAt!).getTime())
  history.sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
  const sections = ["# Fork Registry", ""]

  if (active.length) {
    sections.push("## Active Forks")
    for (const node of active) {
      const since = node.createdAt.split("T")[0]
      sections.push(`- **${node.name}**: ${node.goal || "(no goal)"} (since ${since})`)
    }
    sections.push("")
  }
  if (recent.length) {
    sections.push(`## Recently Merged (< ${recentDays} days)`)
    for (const node of recent) sections.push(...renderDetailed(node))
    sections.push("")
  }
  if (history.length) sections.push("## History", ...history.map(renderOneLine), "")
  if (!active.length && !recent.length && !history.length) sections.push("_No forks yet._", "")

  const dir = join(directory, ".opencode")
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "fork-registry.md"), sections.join("\n"), "utf-8")
}
