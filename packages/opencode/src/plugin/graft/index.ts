import { Process } from "@/util/process"
import { addFork } from "./core/session-tree"
import { createEmptyTree, loadTree, saveTree } from "./core/storage"
import { writeRegistry } from "./core/registry"

const queues = new Map<string, Promise<void>>()

export function recordFork(input: {
  directory: string
  projectId: string
  parentId: string
  childId: string
  childSlug: string
  name?: string
  goal?: string
}): Promise<void> {
  const previous = queues.get(input.directory) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(async () => {
    let gitCommitAtFork: string | undefined
    try {
      const revision = await Process.text(["git", "rev-parse", "HEAD"], {
        cwd: input.directory,
        nothrow: true,
      })
      if (revision.code === 0) gitCommitAtFork = revision.text.trim() || undefined
    } catch {
      gitCommitAtFork = undefined
    }

    const tree = (await loadTree(input.directory)) ?? createEmptyTree(input.projectId, input.parentId)
    addFork(tree, {
      id: input.childId,
      name: input.name,
      fallbackName: input.childSlug,
      parentId: input.parentId,
      goal: input.goal,
      gitCommitAtFork,
    })
    await saveTree(input.directory, tree)
    await writeRegistry(input.directory, tree)
  })

  queues.set(input.directory, next)
  return next.finally(() => {
    if (queues.get(input.directory) === next) queues.delete(input.directory)
  })
}
