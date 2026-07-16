import nodePath from "node:path"

export const BEGIN_PATCH_MARKER = "*** Begin Patch"
export const ENVIRONMENT_ID_MARKER = "*** Environment ID: "
export const END_PATCH_MARKER = "*** End Patch"
export const ADD_FILE_MARKER = "*** Add File: "
export const DELETE_FILE_MARKER = "*** Delete File: "
export const UPDATE_FILE_MARKER = "*** Update File: "
export const MOVE_TO_MARKER = "*** Move to: "
export const EOF_MARKER = "*** End of File"
export const CHANGE_CONTEXT_MARKER = "@@ "
export const EMPTY_CHANGE_CONTEXT_MARKER = "@@"

export const ParseMode = {
  Strict: "strict",
  Lenient: "lenient",
} as const

export type ParseMode = (typeof ParseMode)[keyof typeof ParseMode]

export class InvalidPatchError extends Error {
  readonly type = "invalid_patch"

  constructor(message: string) {
    super(`invalid patch: ${message}`)
    this.name = "InvalidPatchError"
  }
}

export class InvalidHunkError extends Error {
  readonly type = "invalid_hunk"

  constructor(
    message: string,
    readonly lineNumber: number,
  ) {
    super(`invalid hunk at line ${lineNumber}, ${message}`)
    this.name = "InvalidHunkError"
  }
}

export type ParseError = InvalidPatchError | InvalidHunkError

export type Hunk =
  | {
      type: "add"
      path: string
      contents: string
    }
  | {
      type: "delete"
      path: string
    }
  | {
      type: "update"
      path: string
      movePath?: string
      chunks: UpdateFileChunk[]
    }

export type UpdateFileChunk = {
  changeContext?: string
  oldLines: string[]
  newLines: string[]
  isEndOfFile: boolean
}

export type ApplyPatchArgs = {
  patch: string
  hunks: Hunk[]
  workdir?: string
  environmentId?: string
}

export function parsePatch(patch: string) {
  return parsePatchText(patch, ParseMode.Lenient)
}

export function hunkPath(hunk: Hunk) {
  if (hunk.type === "update") return hunk.movePath ?? hunk.path
  return hunk.path
}

export function resolveHunkPath(hunk: Hunk, cwd: string) {
  const path = hunk.type === "update" ? hunk.path : hunkPath(hunk)
  return nodePath.isAbsolute(path) ? path : nodePath.resolve(cwd, path)
}

export function parsePatchText(patch: string, mode: ParseMode): ApplyPatchArgs {
  const lines = patch.trim().split(/\r?\n/)
  const boundaries = mode === ParseMode.Strict ? checkPatchBoundariesStrict(lines) : checkPatchBoundariesLenient(lines)
  const preamble = parseEnvironmentIdPreamble(boundaries.hunkLines)
  const hunks: Hunk[] = []
  let remainingLines = preamble.remainingLines
  let lineNumber = preamble.lineNumber

  while (remainingLines.length > 0) {
    const parsed = parseOneHunk(remainingLines, lineNumber)
    hunks.push(parsed.hunk)
    lineNumber += parsed.parsedLines
    remainingLines = remainingLines.slice(parsed.parsedLines)
  }

  return {
    patch: boundaries.patchLines.join("\n"),
    hunks,
    environmentId: preamble.environmentId,
  }
}

export function parseOneHunk(lines: string[], lineNumber: number): { hunk: Hunk; parsedLines: number } {
  const firstLine = lines[0]?.trim() ?? ""
  const addPath = stripPrefix(firstLine, ADD_FILE_MARKER)
  if (addPath !== undefined) {
    let contents = ""
    let parsedLines = 1
    for (const addLine of lines.slice(1)) {
      const lineToAdd = stripPrefix(addLine, "+")
      if (lineToAdd === undefined) break
      contents += `${lineToAdd}\n`
      parsedLines++
    }
    return { hunk: { type: "add", path: addPath, contents }, parsedLines }
  }

  const deletePath = stripPrefix(firstLine, DELETE_FILE_MARKER)
  if (deletePath !== undefined) return { hunk: { type: "delete", path: deletePath }, parsedLines: 1 }

  const updatePath = stripPrefix(firstLine, UPDATE_FILE_MARKER)
  if (updatePath !== undefined) {
    const movePath = stripPrefix(lines[1] ?? "", MOVE_TO_MARKER)
    let remainingLines = lines.slice(movePath === undefined ? 1 : 2)
    let parsedLines = movePath === undefined ? 1 : 2
    const chunks: UpdateFileChunk[] = []

    while (remainingLines.length > 0) {
      const line = remainingLines[0] ?? ""
      if (line.trim() === "") {
        parsedLines++
        remainingLines = remainingLines.slice(1)
        continue
      }
      if (line.startsWith("*")) break

      const parsed = parseUpdateFileChunk(remainingLines, lineNumber + parsedLines, chunks.length === 0)
      chunks.push(parsed.chunk)
      parsedLines += parsed.parsedLines
      remainingLines = remainingLines.slice(parsed.parsedLines)
    }

    if (chunks.length === 0)
      throw new InvalidHunkError(`Update file hunk for path '${updatePath}' is empty`, lineNumber)
    return { hunk: { type: "update", path: updatePath, movePath, chunks }, parsedLines }
  }

  throw new InvalidHunkError(
    `'${firstLine}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
    lineNumber,
  )
}

export function parseUpdateFileChunk(
  lines: string[],
  lineNumber: number,
  allowMissingContext: boolean,
): { chunk: UpdateFileChunk; parsedLines: number } {
  if (lines.length === 0) throw new InvalidHunkError("Update hunk does not contain any lines", lineNumber)

  const firstLine = lines[0] ?? ""
  const context = stripPrefix(firstLine, CHANGE_CONTEXT_MARKER)
  const changeContext = firstLine === EMPTY_CHANGE_CONTEXT_MARKER ? undefined : context
  const startIndex = firstLine === EMPTY_CHANGE_CONTEXT_MARKER || context !== undefined ? 1 : 0

  if (startIndex === 0 && !allowMissingContext) {
    throw new InvalidHunkError(
      `Expected update hunk to start with a @@ context marker, got: '${firstLine}'`,
      lineNumber,
    )
  }
  if (startIndex >= lines.length) throw new InvalidHunkError("Update hunk does not contain any lines", lineNumber + 1)

  const chunk: UpdateFileChunk = {
    changeContext,
    oldLines: [],
    newLines: [],
    isEndOfFile: false,
  }
  let parsedLines = 0

  for (const lineContents of lines.slice(startIndex)) {
    if (lineContents === EOF_MARKER) {
      if (parsedLines === 0) throw new InvalidHunkError("Update hunk does not contain any lines", lineNumber + 1)
      chunk.isEndOfFile = true
      parsedLines++
      break
    }

    const firstChar = lineContents[0]
    if (firstChar === undefined) {
      chunk.oldLines.push("")
      chunk.newLines.push("")
      parsedLines++
      continue
    }
    if (firstChar === " ") {
      chunk.oldLines.push(lineContents.slice(1))
      chunk.newLines.push(lineContents.slice(1))
      parsedLines++
      continue
    }
    if (firstChar === "+") {
      chunk.newLines.push(lineContents.slice(1))
      parsedLines++
      continue
    }
    if (firstChar === "-") {
      chunk.oldLines.push(lineContents.slice(1))
      parsedLines++
      continue
    }
    if (parsedLines === 0) {
      throw new InvalidHunkError(
        `Unexpected line found in update hunk: '${lineContents}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
        lineNumber + 1,
      )
    }
    break
  }

  return { chunk, parsedLines: parsedLines + startIndex }
}

function parseEnvironmentIdPreamble(hunkLines: string[]) {
  const firstLine = hunkLines[0]
  const environmentId =
    firstLine === undefined ? undefined : stripPrefix(firstLine.trimStart(), ENVIRONMENT_ID_MARKER)?.trim()
  if (environmentId === undefined) return { environmentId: undefined, remainingLines: hunkLines, lineNumber: 2 }
  if (environmentId === "") throw new InvalidPatchError("apply_patch environment_id cannot be empty")
  return { environmentId, remainingLines: hunkLines.slice(1), lineNumber: 3 }
}

function checkPatchBoundariesStrict(lines: string[]) {
  checkStartAndEndLinesStrict(lines[0], lines.at(-1))
  return { patchLines: lines, hunkLines: lines.slice(1, lines.length - 1) }
}

function checkPatchBoundariesLenient(originalLines: string[]) {
  try {
    return checkPatchBoundariesStrict(originalLines)
  } catch (error) {
    if (!(error instanceof InvalidPatchError)) throw error
    const firstLine = originalLines[0]
    const lastLine = originalLines.at(-1)
    if (
      firstLine !== undefined &&
      lastLine !== undefined &&
      ["<<EOF", "<<'EOF'", '<<"EOF"'].includes(firstLine) &&
      lastLine.endsWith("EOF") &&
      originalLines.length >= 4
    ) {
      return checkPatchBoundariesStrict(originalLines.slice(1, originalLines.length - 1))
    }
    throw error
  }
}

function checkStartAndEndLinesStrict(firstLine: string | undefined, lastLine: string | undefined) {
  if (firstLine?.trim() === BEGIN_PATCH_MARKER && lastLine?.trim() === END_PATCH_MARKER) return
  if (firstLine?.trim() !== BEGIN_PATCH_MARKER) {
    throw new InvalidPatchError("The first line of the patch must be '*** Begin Patch'")
  }
  throw new InvalidPatchError("The last line of the patch must be '*** End Patch'")
}

function stripPrefix(value: string, prefix: string) {
  return value.startsWith(prefix) ? value.slice(prefix.length) : undefined
}
