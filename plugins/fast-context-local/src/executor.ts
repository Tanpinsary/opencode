import { execFileSync, execFile as execFileCb } from "node:child_process"
import { readdirSync, readFileSync, statSync, existsSync, lstatSync, realpathSync } from "node:fs"
import { join, resolve, relative, isAbsolute } from "node:path"
import { promisify } from "node:util"
import { contains } from "@opencode-plugins/utils"
import { rgPath } from "@vscode/ripgrep"
import { tree } from "tree-node-cli"

const execFileAsync = promisify(execFileCb)

const RESULT_MAX_LINES = readIntEnv("FC_RESULT_MAX_LINES", 50, {
  min: 1,
  max: 500,
})
const LINE_MAX_CHARS = readIntEnv("FC_LINE_MAX_CHARS", 250, {
  min: 20,
  max: 10000,
})

function readIntEnv(name: string, defaultValue: number, opts?: { min?: number; max?: number }): number {
  const raw = process.env[name]
  const parsed = Number.parseInt(raw ?? "", 10)
  if (!Number.isFinite(parsed)) return defaultValue
  let value = parsed
  if (opts?.min != null) value = Math.max(opts.min, value)
  if (opts?.max != null) value = Math.min(opts.max, value)
  return value
}

export type ToolCommandArg = {
  type?: string
  pattern?: string
  path?: string
  include?: string[]
  exclude?: string[]
  file?: string
  start_line?: number
  end_line?: number
  levels?: number
  long_format?: boolean
  all?: boolean
  type_filter?: string
}

export class ToolExecutor {
  root: string
  collectedRgPatterns: string[] = []

  constructor(projectRoot: string) {
    this.root = realpathSync.native(resolve(projectRoot))
  }

  private real(input: string): string {
    if (!input || typeof input !== "string") return this.root
    const virtual = input === "/codebase" || input === "\\codebase"
    const insideVirtual = input.startsWith("/codebase/") || input.startsWith("\\codebase\\")
    if (isAbsolute(input) && !virtual && !insideVirtual) throw new Error(`path is outside /codebase: ${input}`)

    const candidate = resolve(
      this.root,
      virtual ? "." : insideVirtual ? input.slice("/codebase".length).replace(/^[/\\]+/, "") : input,
    )
    if (!contains(this.root, candidate)) throw new Error(`path escapes /codebase: ${input}`)
    return candidate
  }

  private resolved(input: string) {
    try {
      return { path: this.real(input) } as const
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) } as const
    }
  }

  answerPath(input: string) {
    if (
      input !== "/codebase" &&
      input !== "\\codebase" &&
      !input.startsWith("/codebase/") &&
      !input.startsWith("\\codebase\\")
    )
      return
    const result = this.resolved(input)
    if ("error" in result || !existsSync(result.path)) return
    return result.path
  }

  private static truncate(text: string): string {
    const lines = text.split("\n")
    const out: string[] = []
    const limit = Math.min(lines.length, RESULT_MAX_LINES)
    for (let i = 0; i < limit; i++) {
      const line = lines[i]
      out.push(line.length > LINE_MAX_CHARS ? line.slice(0, LINE_MAX_CHARS) : line)
    }
    let result = out.join("\n")
    if (lines.length > RESULT_MAX_LINES) result += "\n... (lines truncated) ..."
    return result
  }

  private remap(text: string): string {
    return text.replaceAll(this.root, "/codebase")
  }

  rg(pattern: string, path: string, include?: string[], exclude?: string[]): string {
    if (!pattern || typeof pattern !== "string") return "Error: missing or invalid pattern"
    if (!path || typeof path !== "string") return "Error: missing or invalid path"
    this.collectedRgPatterns.push(pattern)
    const resolved = this.resolved(path)
    if ("error" in resolved) return `Error: ${resolved.error}`
    const rp = resolved.path
    if (!existsSync(rp)) return `Error: path does not exist: ${path}`

    const args: string[] = ["--no-heading", "-n", "--max-count", "50", pattern, rp]
    if (include) for (const g of include) args.push("--glob", g)
    if (exclude) for (const g of exclude) args.push("--glob", `!${g}`)

    try {
      const stdout = execFileSync(rgPath, args, {
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, RIPGREP_CONFIG_PATH: "" },
        encoding: "utf-8",
      })
      return ToolExecutor.truncate(this.remap(stdout || "(no matches)"))
    } catch (err: any) {
      if (err.status === 1) return "(no matches)"
      if (err.stderr) return ToolExecutor.truncate(this.remap(err.stderr))
      return `Error: ${err.message}`
    }
  }

  async rgAsync(pattern: string, path: string, include?: string[], exclude?: string[]): Promise<string> {
    if (!pattern || typeof pattern !== "string") return "Error: missing or invalid pattern"
    if (!path || typeof path !== "string") return "Error: missing or invalid path"
    this.collectedRgPatterns.push(pattern)
    const resolved = this.resolved(path)
    if ("error" in resolved) return `Error: ${resolved.error}`
    const rp = resolved.path
    if (!existsSync(rp)) return `Error: path does not exist: ${path}`

    const args: string[] = ["--no-heading", "-n", "--max-count", "50", pattern, rp]
    if (include) for (const g of include) args.push("--glob", g)
    if (exclude) for (const g of exclude) args.push("--glob", `!${g}`)

    try {
      const { stdout } = await execFileAsync(rgPath, args, {
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, RIPGREP_CONFIG_PATH: "" },
        encoding: "utf-8",
      })
      return ToolExecutor.truncate(this.remap(stdout || "(no matches)"))
    } catch (err: any) {
      if (err.code === 1 || err.status === 1) return "(no matches)"
      if (err.stderr) return ToolExecutor.truncate(this.remap(err.stderr))
      return `Error: ${err.message}`
    }
  }

  readfile(file: string, startLine?: number, endLine?: number): string {
    if (!file || typeof file !== "string") return "Error: missing or invalid file path"
    const resolved = this.resolved(file)
    if ("error" in resolved) return `Error: ${resolved.error}`
    const rp = resolved.path
    try {
      const st = statSync(rp)
      if (!st.isFile()) return `Error: file not found: ${file}`
    } catch {
      return `Error: file not found: ${file}`
    }

    let content: string
    try {
      content = readFileSync(rp, "utf-8")
    } catch (e: any) {
      return `Error: ${e.message}`
    }

    const allLines = content.split("\n")
    const s = (startLine ?? 1) - 1
    const e = endLine ?? allLines.length
    const selected = allLines.slice(s, e)
    const out = selected.map((line, idx) => `${s + idx + 1}:${line}`).join("\n")
    return ToolExecutor.truncate(out)
  }

  tree(path: string, levels?: number): string {
    if (!path || typeof path !== "string") return "Error: missing or invalid path"
    const resolved = this.resolved(path)
    if ("error" in resolved) return `Error: ${resolved.error}`
    const rp = resolved.path
    try {
      const st = statSync(rp)
      if (!st.isDirectory()) return `Error: dir not found: ${path}`
    } catch {
      return `Error: dir not found: ${path}`
    }
    try {
      const opts: any = {}
      if (levels) opts.maxDepth = levels
      let stdout: string = tree(rp, opts)
      const dirName = rp.split("/").pop() || rp.split("\\").pop() || rp
      const lines = stdout.split("\n")
      if (lines[0] === dirName) {
        lines[0] = path
        stdout = lines.join("\n")
      }
      return ToolExecutor.truncate(this.remap(stdout))
    } catch {
      return `Error: failed to generate tree for ${path}`
    }
  }

  ls(path: string, longFormat = false, allFiles = false): string {
    if (!path || typeof path !== "string") return "Error: missing or invalid path"
    const resolved = this.resolved(path)
    if ("error" in resolved) return `Error: ${resolved.error}`
    const rp = resolved.path
    try {
      const st = statSync(rp)
      if (!st.isDirectory()) return `Error: not a directory: ${path}`
    } catch {
      return `Error: dir not found: ${path}`
    }
    let entries: string[]
    try {
      entries = readdirSync(rp).sort()
    } catch (e: any) {
      return `Error: ${e.message}`
    }
    if (!allFiles) entries = entries.filter((e) => !e.startsWith("."))
    if (!longFormat) return ToolExecutor.truncate(entries.join("\n"))

    const lines: string[] = [`total ${entries.length}`]
    for (const name of entries) {
      const fp = join(rp, name)
      try {
        const st = statSync(fp)
        const isDir = st.isDirectory()
        const type = isDir ? "d" : "-"
        const size = String(st.size).padStart(8)
        const mtime = st.mtime
        const month = mtime.toLocaleString("en", { month: "short" })
        const day = String(mtime.getDate()).padStart(2)
        const hh = String(mtime.getHours()).padStart(2, "0")
        const mm = String(mtime.getMinutes()).padStart(2, "0")
        lines.push(`${type}rwxr-xr-x  1 user  staff ${size} ${month} ${day} ${hh}:${mm} ${name}`)
      } catch {
        lines.push(`?---------  ? ?     ?        ? ? ?     ? ${name}`)
      }
    }
    return ToolExecutor.truncate(this.remap(lines.join("\n")))
  }

  glob(pattern: string, path: string, typeFilter = "all"): string {
    if (!pattern || typeof pattern !== "string") return "Error: missing or invalid pattern"
    if (!path || typeof path !== "string") return "Error: missing or invalid path"
    const resolved = this.resolved(path)
    if ("error" in resolved) return `Error: ${resolved.error}`
    const rp = resolved.path
    const matches: string[] = []
    try {
      globWalk(rp, pattern, matches, typeFilter)
    } catch {
      try {
        const entries = readdirSync(rp)
        for (const entry of entries) {
          const fp = join(rp, entry)
          if (fnmatch(entry, pattern)) {
            try {
              const st = statSync(fp)
              if (typeFilter === "file" && !st.isFile()) continue
              if (typeFilter === "directory" && !st.isDirectory()) continue
              matches.push(fp)
            } catch {
              /* skip */
            }
          }
        }
      } catch {
        /* skip */
      }
    }
    const sorted = matches.sort().slice(0, 100)
    const out = sorted.map((m) => this.remap(m)).join("\n")
    return out || "(no matches)"
  }

  async execCommandAsync(cmd: ToolCommandArg): Promise<string> {
    const t = cmd.type || ""
    switch (t) {
      case "rg":
        return this.rgAsync(cmd.pattern!, cmd.path!, cmd.include, cmd.exclude)
      case "readfile":
        return this.readfile(cmd.file!, cmd.start_line, cmd.end_line)
      case "tree":
        return this.tree(cmd.path!, cmd.levels)
      case "ls":
        return this.ls(cmd.path!, cmd.long_format!, cmd.all!)
      case "glob":
        return this.glob(cmd.pattern!, cmd.path!, cmd.type_filter!)
      default:
        return `Error: unknown command type '${t}'`
    }
  }

  async execToolCallAsync(args: Record<string, unknown>): Promise<string> {
    if (!args || typeof args !== "object") return "Error: missing or invalid tool args"
    const keys = Object.keys(args)
      .filter((k) => k.startsWith("command"))
      .sort()
    const tasks = keys.map(async (key) => {
      const output = await this.execCommandAsync(args[key] as ToolCommandArg)
      return `<${key}_result>\n${output}\n</${key}_result>`
    })
    const results = await Promise.all(tasks)
    return results.join("")
  }
}

// ─── Repo Map ──────────────────────────────────────────────

const MAX_TREE_BYTES = 250 * 1024

function excludePatternToRegex(pattern: string): RegExp {
  if (!/[*?]/.test(pattern)) {
    return new RegExp("^" + pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$")
  }
  let regex = "^"
  for (const c of pattern) {
    if (c === "*") regex += ".*"
    else if (c === "?") regex += "."
    else if (".+^${}()|[]\\".includes(c)) regex += "\\" + c
    else regex += c
  }
  regex += "$"
  return new RegExp(regex)
}

export interface RepoMapResult {
  tree: string
  depth: number
  sizeBytes: number
}

export function getRepoMap(projectRoot: string, targetDepth = 3, excludePaths: string[] = []): RepoMapResult {
  const rootPattern = new RegExp(projectRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")
  const dirName = projectRoot.split("/").pop() || projectRoot.split("\\").pop() || projectRoot
  const excludeRegexes = excludePaths.length ? excludePaths.map(excludePatternToRegex) : []

  for (let L = targetDepth; L >= 1; L--) {
    try {
      const opts: any = { maxDepth: L }
      if (excludeRegexes.length) opts.exclude = excludeRegexes
      let stdout: string = tree(projectRoot, opts)
      let treeStr = stdout.replace(rootPattern, "/codebase")
      const lines = treeStr.split("\n")
      if (lines[0] === dirName) {
        lines[0] = "/codebase"
        treeStr = lines.join("\n")
      }
      const sizeBytes = Buffer.byteLength(treeStr, "utf-8")
      if (sizeBytes <= MAX_TREE_BYTES) {
        return { tree: treeStr, depth: L, sizeBytes }
      }
    } catch {
      // try lower depth
    }
  }

  try {
    let entries = readdirSync(projectRoot).sort()
    if (excludeRegexes.length) {
      entries = entries.filter((e) => !excludeRegexes.some((rx) => rx.test(e)))
    }
    const treeStr = ["/codebase", ...entries.map((e) => `\u251C\u2500\u2500 ${e}`)].join("\n")
    return {
      tree: treeStr,
      depth: 0,
      sizeBytes: Buffer.byteLength(treeStr, "utf-8"),
    }
  } catch {
    const treeStr = "/codebase\n(empty or inaccessible)"
    return { tree: treeStr, depth: 0, sizeBytes: treeStr.length }
  }
}

// ─── Helpers ───────────────────────────────────────────────

function fnmatch(str: string, pattern: string): boolean {
  let regex = "^"
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i]
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        regex += ".*"
        i += 2
        if (pattern[i] === "/") i++
        continue
      }
      regex += "[^/]*"
    } else if (c === "?") {
      regex += "[^/]"
    } else if (c === "[") {
      const end = pattern.indexOf("]", i)
      if (end === -1) regex += "\\["
      else {
        regex += pattern.slice(i, end + 1)
        i = end
      }
    } else if (".+^${}()|\\".includes(c)) {
      regex += "\\" + c
    } else {
      regex += c
    }
    i++
  }
  regex += "$"
  try {
    return new RegExp(regex).test(str)
  } catch {
    return false
  }
}

function globWalk(base: string, pattern: string, matches: string[], typeFilter: string): void {
  const isRecursive = pattern.includes("**")
  const walk = (dir: string, depth: number) => {
    if (matches.length >= 100) return
    if (!isRecursive && depth > 0) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (matches.length >= 100) return
      const fp = join(dir, entry)
      const relFromBase = relative(base, fp).replace(/\\/g, "/")
      let st: ReturnType<typeof lstatSync>
      try {
        st = lstatSync(fp)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) continue
      if (fnmatch(relFromBase, pattern) || fnmatch(entry, pattern)) {
        if (typeFilter === "file" && !st.isFile()) continue
        if (typeFilter === "directory" && !st.isDirectory()) continue
        matches.push(fp)
      }
      if (st.isDirectory() && !entry.startsWith(".") && isRecursive) {
        walk(fp, depth + 1)
      }
    }
  }
  walk(base, 0)
}
