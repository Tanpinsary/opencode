import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import nodePath from "node:path"
import { externalDirectoryRequest, isExternalProjectPath, resolvePath } from "@opencode-plugins/utils"
import type { ToolContext, ToolResult } from "@opencode-ai/plugin/tool"
import { createTwoFilesPatch, diffLines } from "diff"
import { type ApplyPatchArgs, type Hunk, type UpdateFileChunk, parsePatch } from "./parser.js"

export type PlannedFileChange = {
  type: "add" | "update" | "delete" | "move"
  filePath: string
  relativePath: string
  oldContent: string
  newContent: string
  diff: string
  additions: number
  deletions: number
  patterns: string[]
  movePath?: string
}

type Replacement = {
  startIndex: number
  oldLength: number
  newLines: string[]
}

type VirtualFile = { exists: true; content: string } | { exists: false }

export async function applyPatch(patch: string, ctx: ToolContext): Promise<ToolResult> {
  const args = parsePatch(patch)
  if (args.hunks.length === 0) throw new Error("No files were modified.")

  for (const target of patchTargets(args, ctx)) await askExternalDirectory(ctx, target)

  const changes = await planPatchChanges(args, ctx)
  const metadata = metadataForChanges(changes)
  ctx.metadata({ title: `apply_patch ${summaryLines(changes).join(", ")}`, metadata })
  await ctx.ask({ permission: "edit", patterns: editPatterns(changes), always: ["*"], metadata })
  await applyPlannedChanges(changes)

  const output = `Success. Updated the following files:\n${summaryLines(changes).join("\n")}`
  return { title: output, output, metadata }
}

export async function planPatchChanges(args: ApplyPatchArgs, ctx: Pick<ToolContext, "directory" | "worktree">) {
  const changes: PlannedFileChange[] = []
  const virtualFiles = new Map<string, VirtualFile>()
  for (const hunk of args.hunks) changes.push(await planHunk(hunk, ctx, virtualFiles))
  return changes
}

export function deriveNewContentsFromChunks(path: string, chunks: UpdateFileChunk[], originalContents: string) {
  const originalLines = originalContents.split("\n")
  if (originalLines.at(-1) === "") originalLines.pop()
  const newLines = applyReplacements(originalLines, computeReplacements(originalLines, path, chunks))
  if (newLines.at(-1) !== "") newLines.push("")
  return newLines.join("\n")
}

export function seekSequence(lines: string[], pattern: string[], start: number, eof: boolean) {
  if (pattern.length === 0) return start
  if (pattern.length > lines.length) return undefined

  const searchStart = eof && lines.length >= pattern.length ? lines.length - pattern.length : start
  const exact = findSequence(lines, pattern, searchStart, (line, expected) => line === expected)
  if (exact !== undefined) return exact

  const rstrip = findSequence(lines, pattern, searchStart, (line, expected) => line.trimEnd() === expected.trimEnd())
  if (rstrip !== undefined) return rstrip

  const trimmed = findSequence(lines, pattern, searchStart, (line, expected) => line.trim() === expected.trim())
  if (trimmed !== undefined) return trimmed

  return findSequence(
    lines,
    pattern,
    searchStart,
    (line, expected) => normalizeForFuzzyMatch(line) === normalizeForFuzzyMatch(expected),
  )
}

function patchTargets(args: ApplyPatchArgs, ctx: Pick<ToolContext, "directory">) {
  return args.hunks.flatMap((hunk) => {
    if (hunk.type !== "update" || hunk.movePath === undefined) return [resolvePath(ctx.directory, hunk.path)]
    return [resolvePath(ctx.directory, hunk.path), resolvePath(ctx.directory, hunk.movePath)]
  })
}

async function askExternalDirectory(ctx: ToolContext, target: string) {
  if (!isExternalProjectPath(target, { directory: ctx.directory, worktree: ctx.worktree })) return
  await ctx.ask(externalDirectoryRequest(target))
}

async function planHunk(
  hunk: Hunk,
  ctx: Pick<ToolContext, "directory" | "worktree">,
  virtualFiles: Map<string, VirtualFile>,
): Promise<PlannedFileChange> {
  if (hunk.type === "add") return planAdd(hunk, ctx, virtualFiles)
  if (hunk.type === "delete") return planDelete(hunk, ctx, virtualFiles)
  return planUpdate(hunk, ctx, virtualFiles)
}

async function planAdd(
  hunk: Extract<Hunk, { type: "add" }>,
  ctx: Pick<ToolContext, "directory" | "worktree">,
  virtualFiles: Map<string, VirtualFile>,
) {
  const filePath = resolvePath(ctx.directory, hunk.path)
  const oldContent = (await readOptionalPlannedText(filePath, virtualFiles)) ?? ""
  virtualFiles.set(filePath, { exists: true, content: hunk.contents })
  return plannedChange({ type: "add", filePath, oldContent, newContent: hunk.contents, worktree: ctx.worktree })
}

async function planDelete(
  hunk: Extract<Hunk, { type: "delete" }>,
  ctx: Pick<ToolContext, "directory" | "worktree">,
  virtualFiles: Map<string, VirtualFile>,
) {
  const filePath = resolvePath(ctx.directory, hunk.path)
  const oldContent = await readRequiredPlannedText(filePath, "delete", virtualFiles)
  virtualFiles.set(filePath, { exists: false })
  return plannedChange({ type: "delete", filePath, oldContent, newContent: "", worktree: ctx.worktree })
}

async function planUpdate(
  hunk: Extract<Hunk, { type: "update" }>,
  ctx: Pick<ToolContext, "directory" | "worktree">,
  virtualFiles: Map<string, VirtualFile>,
) {
  const filePath = resolvePath(ctx.directory, hunk.path)
  const oldContent = await readRequiredPlannedText(filePath, "update", virtualFiles)
  const newContent = deriveNewContentsFromChunks(filePath, hunk.chunks, oldContent)
  const movePath = hunk.movePath === undefined ? undefined : resolvePath(ctx.directory, hunk.movePath)
  virtualFiles.set(filePath, movePath === undefined ? { exists: true, content: newContent } : { exists: false })
  if (movePath !== undefined) virtualFiles.set(movePath, { exists: true, content: newContent })
  return plannedChange({
    type: movePath === undefined ? "update" : "move",
    filePath,
    movePath,
    oldContent,
    newContent,
    worktree: ctx.worktree,
  })
}

function plannedChange(input: {
  type: PlannedFileChange["type"]
  filePath: string
  oldContent: string
  newContent: string
  worktree: string
  movePath?: string
}): PlannedFileChange {
  const diff = trimDiff(
    createTwoFilesPatch(input.filePath, input.movePath ?? input.filePath, input.oldContent, input.newContent),
  )
  const counts = countChanges(input.oldContent, input.newContent)
  return {
    type: input.type,
    filePath: input.filePath,
    movePath: input.movePath,
    relativePath: relativePath(input.worktree, input.movePath ?? input.filePath),
    patterns: Array.from(
      new Set(
        [input.filePath, input.movePath].filter(isString).map((filePath) => relativePath(input.worktree, filePath)),
      ),
    ),
    oldContent: input.oldContent,
    newContent: input.newContent,
    diff,
    additions: counts.additions,
    deletions: counts.deletions,
  }
}

async function applyPlannedChanges(changes: PlannedFileChange[]) {
  for (const change of changes) {
    if (change.type === "delete") {
      await rm(change.filePath, { force: false, recursive: false })
      continue
    }
    const target = change.movePath ?? change.filePath
    await mkdir(nodePath.dirname(target), { recursive: true })
    await writeFile(target, change.newContent)
    if (change.type === "move") await rm(change.filePath, { force: false, recursive: false })
  }
}

function computeReplacements(originalLines: string[], path: string, chunks: UpdateFileChunk[]) {
  const replacements: Replacement[] = []
  let lineIndex = 0

  for (const chunk of chunks) {
    if (chunk.changeContext !== undefined) {
      const contextIndex = seekSequence(originalLines, [chunk.changeContext], lineIndex, false)
      if (contextIndex === undefined) throw new Error(`Failed to find context '${chunk.changeContext}' in ${path}`)
      lineIndex = contextIndex + 1
    }

    if (chunk.oldLines.length === 0) {
      replacements.push({
        startIndex: originalLines.at(-1) === "" ? originalLines.length - 1 : originalLines.length,
        oldLength: 0,
        newLines: chunk.newLines,
      })
      continue
    }

    const match = findOldLines(originalLines, chunk, lineIndex)
    if (match === undefined) throw new Error(`Failed to find expected lines in ${path}:\n${chunk.oldLines.join("\n")}`)
    replacements.push(match.replacement)
    lineIndex = match.replacement.startIndex + match.replacement.oldLength
  }

  return [...replacements].sort((a, b) => a.startIndex - b.startIndex)
}

function findOldLines(originalLines: string[], chunk: UpdateFileChunk, lineIndex: number) {
  const exactIndex = seekSequence(originalLines, chunk.oldLines, lineIndex, chunk.isEndOfFile)
  if (exactIndex !== undefined) {
    return { replacement: { startIndex: exactIndex, oldLength: chunk.oldLines.length, newLines: chunk.newLines } }
  }

  if (chunk.oldLines.at(-1) !== "") return undefined

  const pattern = chunk.oldLines.slice(0, -1)
  const newLines = chunk.newLines.at(-1) === "" ? chunk.newLines.slice(0, -1) : chunk.newLines
  const sentinelIndex = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile)
  if (sentinelIndex === undefined) return undefined
  return { replacement: { startIndex: sentinelIndex, oldLength: pattern.length, newLines } }
}

function applyReplacements(lines: string[], replacements: Replacement[]) {
  const next = [...lines]
  for (const replacement of [...replacements].reverse())
    next.splice(replacement.startIndex, replacement.oldLength, ...replacement.newLines)
  return next
}

function findSequence(
  lines: string[],
  pattern: string[],
  start: number,
  matches: (line: string, expected: string) => boolean,
) {
  for (let index = start; index <= lines.length - pattern.length; index++) {
    if (pattern.every((expected, offset) => matches(lines[index + offset] ?? "", expected))) return index
  }
  return undefined
}

function normalizeForFuzzyMatch(value: string) {
  return value
    .trim()
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u00A0\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u202F\u205F\u3000]/g, " ")
}

async function readOptionalText(path: string) {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
}

async function readOptionalPlannedText(path: string, virtualFiles: Map<string, VirtualFile>) {
  const planned = virtualFiles.get(path)
  if (planned?.exists === true) return planned.content
  if (planned?.exists === false) return undefined
  return readOptionalText(path)
}

async function readRequiredPlannedText(
  path: string,
  operation: "delete" | "update",
  virtualFiles: Map<string, VirtualFile>,
) {
  const planned = virtualFiles.get(path)
  if (planned?.exists === true) return planned.content
  if (planned?.exists === false)
    throw new Error(`apply_patch verification failed: Failed to read file to ${operation} ${path}: file does not exist`)
  return readRequiredText(path, operation)
}

async function readRequiredText(path: string, operation: "delete" | "update") {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    throw new Error(
      `apply_patch verification failed: Failed to read file to ${operation} ${path}: ${errorMessage(error)}`,
    )
  }
}

function metadataForChanges(changes: PlannedFileChange[]) {
  return {
    filepath: changes.map((change) => change.relativePath).join(", "),
    diff: changes.map((change) => change.diff).join("\n"),
    files: changes.map((change) => ({
      filePath: change.movePath ?? change.filePath,
      relativePath: change.relativePath,
      type: change.type,
      patch: change.diff,
      additions: change.additions,
      deletions: change.deletions,
      movePath: change.movePath,
    })),
  }
}

function editPatterns(changes: PlannedFileChange[]) {
  return Array.from(new Set(changes.flatMap((change) => change.patterns)))
}

function summaryLines(changes: PlannedFileChange[]) {
  return changes.map((change) => `${summaryPrefix(change.type)} ${change.relativePath}`)
}

function summaryPrefix(type: PlannedFileChange["type"]) {
  if (type === "add") return "A"
  if (type === "delete") return "D"
  return "M"
}

function relativePath(worktree: string, filePath: string) {
  return nodePath.relative(worktree, filePath).replaceAll("\\", "/")
}

function countChanges(oldContent: string, newContent: string) {
  return diffLines(oldContent, newContent).reduce(
    (acc, change) => ({
      additions: acc.additions + (change.added ? (change.count ?? 0) : 0),
      deletions: acc.deletions + (change.removed ? (change.count ?? 0) : 0),
    }),
    { additions: 0, deletions: 0 },
  )
}

function trimDiff(diff: string) {
  return diff.endsWith("\n") ? diff.slice(0, -1) : diff
}

function isString(value: string | undefined): value is string {
  return value !== undefined
}

function isNotFound(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
