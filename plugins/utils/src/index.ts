import { realpathSync } from "node:fs"
import nodePath from "node:path"

export type PathOps = {
  relative: typeof nodePath.relative
  parse: typeof nodePath.parse
  isAbsolute: typeof nodePath.isAbsolute
}

export type ContainmentOptions = {
  platform?: NodeJS.Platform
  realpathNative?: (path: string) => string
}

export type ProjectPathContext = {
  directory: string
  worktree: string
}

export type ExternalDirectoryKind = "file" | "directory"

export type ExternalDirectoryRequest = {
  permission: "external_directory"
  patterns: string[]
  always: string[]
  metadata: {
    filepath: string
    parentDir: string
  }
}

export function windowsPath(path: string, platform: NodeJS.Platform = process.platform) {
  if (platform !== "win32") return path
  return path
    .replace(/^\/([a-zA-Z]):(?:[\\/]|$)/, (_, drive: string) => `${drive.toUpperCase()}:/`)
    .replace(/^\/([a-zA-Z])(?:\/|$)/, (_, drive: string) => `${drive.toUpperCase()}:/`)
    .replace(/^\/cygdrive\/([a-zA-Z])(?:\/|$)/, (_, drive: string) => `${drive.toUpperCase()}:/`)
    .replace(/^\/mnt\/([a-zA-Z])(?:\/|$)/, (_, drive: string) => `${drive.toUpperCase()}:/`)
}

export function normalizePath(path: string, options?: ContainmentOptions) {
  const platform = options?.platform ?? process.platform
  if (platform !== "win32") return path
  const resolved = nodePath.win32.normalize(nodePath.win32.resolve(windowsPath(path, platform)))
  try {
    return options?.realpathNative?.(resolved) ?? realpathSync.native(resolved)
  } catch {
    return resolved
  }
}

export function normalizePathPattern(path: string, options?: ContainmentOptions) {
  const platform = options?.platform ?? process.platform
  if (platform !== "win32") return path
  if (path === "*") return path

  const match = path.match(/^(.*)[\\/]\*$/)
  if (!match) return normalizePath(path, options)

  const dir = /^[A-Za-z]:$/.test(match[1] ?? "") ? `${match[1]}\\` : (match[1] ?? "")
  return nodePath.win32.join(normalizePath(dir, options), "*")
}

export function containsNormalized(
  parent: string,
  child: string,
  ops?: PathOps,
  platform: NodeJS.Platform = process.platform,
) {
  const pathOps = ops ?? pathOpsForPlatform(platform)

  if (platform === "win32") {
    const parentRoot = pathOps.parse(parent).root.toLowerCase()
    const childRoot = pathOps.parse(child).root.toLowerCase()
    if (parentRoot && childRoot && parentRoot !== childRoot) return false
  }

  const rel = pathOps.relative(parent, child)
  return rel === "" || (!rel.startsWith("..") && !pathOps.isAbsolute(rel))
}

export function contains(parent: string, child: string, options?: ContainmentOptions) {
  const platform = options?.platform ?? process.platform
  return containsNormalized(
    resolveForContainment(parent, options),
    resolveForContainment(child, options),
    undefined,
    platform,
  )
}

export function containsProjectPath(filepath: string, ctx: ProjectPathContext, options?: ContainmentOptions) {
  if (contains(ctx.directory, filepath, options)) return true
  if (ctx.worktree === "/") return false
  return contains(ctx.worktree, filepath, options)
}

export function isExternalProjectPath(filepath: string, ctx: ProjectPathContext, options?: ContainmentOptions) {
  return !containsProjectPath(filepath, ctx, options)
}

export function externalDirectoryRequest(
  target: string,
  kind: ExternalDirectoryKind = "file",
  options?: ContainmentOptions,
): ExternalDirectoryRequest {
  const platform = options?.platform ?? process.platform
  const full = platform === "win32" ? normalizePath(target, options) : target
  const parentDir = kind === "directory" ? full : pathModuleForPlatform(platform).dirname(full)
  const pattern = pathModuleForPlatform(platform).join(parentDir, "*")
  const glob = platform === "win32" ? normalizePathPattern(pattern, options) : pattern.replaceAll("\\", "/")

  return {
    permission: "external_directory",
    patterns: [glob],
    always: [glob],
    metadata: {
      filepath: full,
      parentDir,
    },
  }
}

export function resolvePath(base: string, target: string, platform: NodeJS.Platform = process.platform) {
  const pathModule = pathModuleForPlatform(platform)
  return pathModule.isAbsolute(target) ? target : pathModule.resolve(base, target)
}

function resolveForContainment(path: string, options?: ContainmentOptions) {
  const platform = options?.platform ?? process.platform
  const pathModule = pathModuleForPlatform(platform)
  const resolved = pathModule.resolve(windowsPath(path, platform))
  const suffix: string[] = []
  let current = resolved

  while (true) {
    try {
      const real = options?.realpathNative?.(current) ?? realpathSync.native(current)
      return normalizePath(suffix.length === 0 ? real : pathModule.join(real, ...suffix.slice().reverse()), options)
    } catch {
      const root = pathModule.parse(current).root
      if (current === root) return normalizePath(resolved, options)
      suffix.push(pathModule.basename(current))
      current = pathModule.dirname(current)
    }
  }
}

function pathOpsForPlatform(platform: NodeJS.Platform): PathOps {
  if (platform === "win32") return nodePath.win32
  return nodePath.posix
}

function pathModuleForPlatform(platform: NodeJS.Platform) {
  if (platform === "win32") return nodePath.win32
  return nodePath.posix
}
