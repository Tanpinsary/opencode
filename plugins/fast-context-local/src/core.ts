// ─── Constants (aligned with fast-context-mcp) ────────────

import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"
import { z } from "zod/v4"
import type { JSONSchema } from "zod/v4/core"

export interface FastContextConfig {
  baseURL: string
  apiKey: string
  model: string
  max_turns: number
  max_commands: number
}

type ConfigFile = Partial<FastContextConfig> & { provider?: string }

export function loadConfig(projectDir: string, configDirectory = join(homedir(), ".config", "opencode")): FastContextConfig {
  const defaults: FastContextConfig = {
    baseURL: "http://localhost:8080/v1",
    apiKey: "",
    model: "swe-1.6-fast",
    max_turns: readIntEnv("FC_MAX_TURNS", 3, { min: 1, max: 5 }),
    max_commands: readIntEnv("FC_MAX_COMMANDS", 8, { min: 1, max: 20 }),
  }

  const readJson = (path: string): ConfigFile | undefined => {
    try {
      return JSON.parse(readFileSync(path, "utf-8")) as ConfigFile
    } catch {
      return
    }
  }

  const user = readJson(join(configDirectory, "fast-context-local.json")) ?? {}
  const provider = (() => {
    if (!user.provider) return {}
    const config = readJson(join(configDirectory, "opencode.json")) as
      | { provider?: Record<string, { options?: { baseURL?: string; apiKey?: string } }> }
      | undefined
    return config?.provider?.[user.provider]?.options ?? {}
  })()
  const project = (() => {
    let dir = projectDir
    while (true) {
      const config = readJson(join(dir, ".opencode", "fast-context-local.json"))
      if (config) return config
      const parent = dirname(dir)
      if (parent === dir) return {}
      dir = parent
    }
  })()

  return {
    baseURL: process.env.FAST_CONTEXT_ENDPOINT || user.baseURL || provider.baseURL || defaults.baseURL,
    apiKey: process.env.FAST_CONTEXT_API_KEY || user.apiKey || provider.apiKey || defaults.apiKey,
    model: process.env.FAST_CONTEXT_MODEL || user.model || defaults.model,
    max_turns: project.max_turns ?? user.max_turns ?? defaults.max_turns,
    max_commands: project.max_commands ?? user.max_commands ?? defaults.max_commands,
  }
}

function readIntEnv(name: string, defaultValue: number, opts?: { min?: number; max?: number }): number {
  const raw = process.env[name]
  const parsed = Number.parseInt(raw ?? "", 10)
  if (!Number.isFinite(parsed)) return defaultValue
  let v = parsed
  if (opts?.min != null) v = Math.max(opts.min, v)
  if (opts?.max != null) v = Math.min(opts.max, v)
  return v
}

export const SYSTEM_PROMPT_TEMPLATE = `You are an expert software engineer, responsible for providing context \
to another engineer to solve a code issue in the current codebase. \
The user will present you with a description of the issue, and it is \
your job to provide a series of file paths with associated line ranges \
that contain ALL the information relevant to understand and correctly \
address the issue.

# IMPORTANT:
- A relevant file does not mean only the files that must be modified to \
solve the task. It means any file that contains information relevant to \
planning and implementing the fix, such as the definitions of classes \
and functions that are relevant to the pieces of code that will have to \
be modified.
- You should include enough context around the relevant lines to allow \
the engineer to understand the task correctly. You must include ENTIRE \
semantic blocks (functions, classes, definitions, etc). For example:
If addressing the issue requires modifying a method within a class, then \
you should include the entire class definition, not just the lines around \
the method we want to modify.
- NEVER truncate these blocks unless they are very large (hundreds of \
lines or more, in which case providing only a relevant portion of the \
block is acceptable).
- Your job is to essentially alleviate the job of the other engineer by \
giving them a clean starting context from which to start working. More \
precisely, you should minimize the number of files the engineer has to \
read to understand and solve the task correctly (while not providing \
irrelevant code snippets).

# ENVIRONMENT
- Working directory: /codebase. Make sure to run commands in this \
directory, not \`.
- Tool access: use the restricted_exec tool ONLY
- Allowed sub-commands (schema-enforced):
  - rg: Search for patterns in files using ripgrep
    - Required: pattern (string), path (string)
    - Optional: include (array of globs), exclude (array of globs)
  - readfile: Read contents of a file with optional line range
    - Required: file (string)
    - Optional: start_line (int), end_line (int) — 1-indexed, inclusive
  - tree: Display directory structure as a tree
    - Required: path (string)
    - Optional: levels (int)

# THINKING RULES
- Think step-by-step. Plan, reason, and reflect before each tool call.
- Use tool calls liberally and purposefully to ground every conclusion \
in real code, not assumptions.
- If a command fails, rethink and try something different; do not \
complain to the user.

# FAST-SEARCH DEFAULTS (optimize rg/tree on large repos)
- Start NARROW, then widen only if needed. Prefer searching likely code \
roots first (e.g., \`src/\`, \`lib/\`, \`app/\`, \`packages/\`, \`services/\`) \
instead of \`/codebase\`.
- Prefer fixed-string search for literals: escape patterns or keep regex \
simple. Use smart case; avoid case-insensitive unless necessary.
- Prefer file-type filters and globs (in include) over full-repo scans.
- Default EXCLUDES for speed (apply via the exclude array): \
node_modules, .git, dist, build, coverage, .venv, venv, target, out, \
.cache, __pycache__, vendor, deps, third_party, logs, data, *.min.*
- Skip huge files where possible; when opening files, prefer reading \
only relevant ranges with readfile.
- Limit directory traversal with tree levels to quickly orient before \
deeper inspection.

# SOME EXAMPLES OF WORKFLOWS
- MAP – Use \`tree\` with small levels; \`rg\` on likely roots to grasp \
structure and hotspots.
- ANCHOR – \`rg\` for problem keywords and anchor symbols; restrict by \
language globs via include.
- TRACE – Follow imports with targeted \`rg\` in narrowed roots; open \
files with \`readfile\` scoped to entire semantic blocks.
- VERIFY – Confirm each candidate path exists by reading or additional \
searches; drop false positives (tests, vendored, generated) unless they \
must change.

# TOOL USE GUIDELINES
- You must use a SINGLE restricted_exec call in your answer, that lets \
you execute at most {max_commands} commands in a single turn. Each command must be \
an object with a \`type\` field of \`rg\`, \`readfile\`, or \`tree\` and the appropriate fields for that type.
- Example restricted_exec usage:
[TOOL_CALLS]restricted_exec[ARGS]{{
  "command1": {{
    "type": "rg",
    "pattern": "Controller",
    "path": "/codebase/slime",
    "include": ["**/*.py"],
    "exclude": ["**/node_modules/**", "**/.git/**", "**/dist/**", \
"**/build/**", "**/.venv/**", "**/__pycache__/**"]
  }},
  "command2": {{
    "type": "readfile",
    "file": "/codebase/slime/train.py",
    "start_line": 1,
    "end_line": 200
  }},
  "command3": {{
    "type": "tree",
    "path": "/codebase/slime/",
    "levels": 2
  }}
}}
- You have at most {max_turns} turns to interact with the environment by calling \
tools, so issuing multiple commands at once is necessary and encouraged \
to speed up your research.
- Each command result may be truncated to 50 lines; prefer multiple \
targeted reads/searches to build complete context.
- DO NOT EVER USE MORE THAN {max_commands} commands in a single turn, or you will \
be penalized.

# ANSWER FORMAT (strict format, including tags)
- You will output an XML structure with a root element "ANSWER" \
containing "file" elements. Each "file" element will have a "path" \
attribute and contain "range" elements.
- You will output this as your final response.
- The line ranges must be inclusive.

Output example inside the "answer" tool argument:
<ANSWER>
  <file path="/codebase/info_theory/formulas/entropy.py">
    <range>10-60</range>
    <range>150-210</range>
  </file>
  <file path="/codebase/info_theory/data_structures/bits.py">
    <range>1-40</range>
    <range>110-170</range>
  </file>
</ANSWER>


Remember: Prefer narrow, fixed-string, and type-filtered searches with \
aggressive excludes and size/depth limits. Widen scope only as needed. \
Use the restricted tools available to you, and output your answer in \
exactly the specified format.

# NO RESULTS POLICY
If after thorough searching you are confident that NO relevant files exist \
for the given query (e.g., the function/class/concept does not exist in the \
codebase), you MUST return an empty ANSWER:
<ANSWER></ANSWER>
Do NOT return irrelevant files (such as entry points or config files) just \
to provide some output. An empty answer is always better than a misleading one.

# RESULT COUNT
Aim to return at most {max_results} files in your answer. Focus on the most \
relevant files first. If fewer files are relevant, return fewer.
`

export const FINAL_FORCE_ANSWER =
  "You have no turns left. Now you MUST provide your final ANSWER, even if it's not complete."

interface CommandSchema {
  type: string
  const: string
  description?: string
}

interface OneOfSchema {
  properties: Record<string, unknown>
  required: string[]
}

function buildCommandSchema(n: number): Record<string, unknown> {
  return {
    type: "object",
    description: `Command ${n} to execute. Must be one of: rg, readfile, or tree.`,
    oneOf: [
      {
        properties: {
          type: {
            type: "string",
            const: "rg",
            description: "Search for patterns in files using ripgrep.",
          },
          pattern: {
            type: "string",
            description: "The regex pattern to search for.",
          },
          path: { type: "string", description: "The path to search in." },
          include: {
            type: "array",
            items: { type: "string" },
            description: "File patterns to include.",
          },
          exclude: {
            type: "array",
            items: { type: "string" },
            description: "File patterns to exclude.",
          },
        },
        required: ["type", "pattern", "path"],
      },
      {
        properties: {
          type: {
            type: "string",
            const: "readfile",
            description: "Read contents of a file with optional line range.",
          },
          file: { type: "string", description: "Path to the file to read." },
          start_line: {
            type: "integer",
            description: "Starting line number (1-indexed).",
          },
          end_line: {
            type: "integer",
            description: "Ending line number (1-indexed).",
          },
        },
        required: ["type", "file"],
      },
      {
        properties: {
          type: {
            type: "string",
            const: "tree",
            description: "Display directory structure as a tree.",
          },
          path: { type: "string", description: "Path to the directory." },
          levels: {
            type: "integer",
            description: "Number of directory levels.",
          },
        },
        required: ["type", "path"],
      },
      {
        properties: {
          type: {
            type: "string",
            const: "ls",
            description: "List files in a directory.",
          },
          path: { type: "string", description: "Path to the directory." },
          long_format: { type: "boolean" },
          all: { type: "boolean" },
        },
        required: ["type", "path"],
      },
      {
        properties: {
          type: {
            type: "string",
            const: "glob",
            description: "Find files matching a glob pattern.",
          },
          pattern: { type: "string" },
          path: { type: "string" },
          type_filter: { type: "string", enum: ["file", "directory", "all"] },
        },
        required: ["type", "pattern", "path"],
      },
    ],
  }
}

export function buildToolDefinitions(maxCommands: number = 8): string {
  const props: Record<string, unknown> = {}
  const required: string[] = []
  for (let i = 1; i <= maxCommands; i++) {
    props[`command${i}`] = buildCommandSchema(i)
    if (i === 1) required.push(`command${i}`)
  }
  const tools = [
    {
      type: "function",
      function: {
        name: "restricted_exec",
        description: "Execute restricted commands (rg, readfile, tree, ls, glob) in parallel.",
        parameters: { type: "object", properties: props, required },
      },
    },
    {
      type: "function",
      function: {
        name: "answer",
        description: "Final answer with relevant files and line ranges.",
        parameters: {
          type: "object",
          properties: {
            answer: {
              type: "string",
              description: "The final answer in XML format.",
            },
          },
          required: ["answer"],
        },
      },
    },
  ]
  return JSON.stringify(tools)
}

export interface MCPToolSchema {
  name: string
  description: string
  parameters: JSONSchema.BaseSchema
}

export const FAST_CONTEXT_SEARCH_ARGS = {
  query: z
    .string()
    .describe(
      'Natural language search query (e.g. "where is auth handled", "database connection pool") in ENGLISH. Only use other language if you are SURE the keywords is DIRECTLY in that language. Avoid unnecessary complexity; simple queries often work best.',
    ),
  project_path: z.string().default("").describe("Absolute path to project root. Empty = current working directory."),
  tree_depth: z
    .number()
    .int()
    .min(1)
    .max(6)
    .default(3)
    .describe(
      "Directory tree depth for the initial repo map sent to the remote AI. Default 3. Use 1-2 for huge monorepos (>5000 files) or if payload size errors occur. Use 4-6 for small projects (<200 files) where deeper structure helps. Auto falls back to a lower depth if tree output exceeds 250KB.",
    ),
  max_turns: z
    .number()
    .int()
    .min(1)
    .max(5)
    .default(3)
    .describe(
      "Number of search rounds. Each round: remote AI generates search commands -> local execution -> results sent back. Default 3. Use 1 for quick simple lookups. Use 4-5 for complex queries requiring deep tracing.",
    ),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(30)
    .default(10)
    .describe(
      "Maximum number of files to return. Default 10. Use 3-5 for focused queries. Use 15-30 for broad exploration.",
    ),
  exclude_paths: z
    .array(z.string())
    .default([])
    .describe(
      "Directory/file patterns to exclude from tree and search context. Examples: ['node_modules', 'dist', '.git', 'build', 'coverage', '*.min.*']",
    ),
} satisfies z.ZodRawShape

export const FAST_CONTEXT_SEARCH_ARGS_SCHEMA = z.object(FAST_CONTEXT_SEARCH_ARGS)
export type FastContextSearchArgs = z.infer<typeof FAST_CONTEXT_SEARCH_ARGS_SCHEMA>

export const FAST_CONTEXT_SEARCH_TOOL = {
  name: "fast_context_search",
  description:
    "AI-driven semantic code search. " +
    "Searches a codebase with natural language and returns relevant file paths with line ranges, " +
    "plus suggested grep keywords for follow-up searches. " +
    "Parameter tuning guide: " +
    "tree_depth controls how much directory structure the remote AI sees. " +
    "REDUCE if payload/size errors occur. INCREASE for small projects where deeper structure helps. " +
    "max_turns controls search-execute-feedback rounds. " +
    "INCREASE if results are incomplete. Use 1 for quick lookups and at least 2 for big projects. " +
    "Response includes [config] and [diagnostic] lines to decide if retry with different parameters is needed.",
  parameters: z.toJSONSchema(FAST_CONTEXT_SEARCH_ARGS_SCHEMA),
} satisfies MCPToolSchema

// ─── Search function ───────────────────────────────────────

export interface SearchOptions {
  query: string
  projectRoot: string
  baseUrl: string
  upstreamKey: string
  upstreamModel: string
  maxTurns?: number
  maxCommands?: number
  maxResults?: number
  treeDepth?: number
  excludePaths?: string[]
  getRepoMap: (root: string, depth: number, excludes: string[]) => RepoMapResult
  execToolCall: (args: Record<string, unknown>) => Promise<string>
  rgPatterns?: () => string[]
  onProgress?: (msg: string) => void
}

export interface RepoMapResult {
  tree: string
  depth: number
  sizeBytes: number
}

export interface SearchResult {
  files: Array<{ path: string; ranges: Array<[number, number]> }>
  rg_patterns?: string[]
  error?: string
  _meta?: Record<string, unknown>
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool"
  content: string | null
  tool_calls?: Array<{
    id: string
    type: "function"
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

export async function search(opts: SearchOptions): Promise<SearchResult> {
  const {
    query,
    projectRoot,
    baseUrl,
    upstreamKey,
    upstreamModel,
    maxTurns = 3,
    maxCommands = 8,
    maxResults = 10,
    treeDepth = 3,
    excludePaths = [],
    getRepoMap,
    execToolCall,
    rgPatterns = () => [],
    onProgress,
  } = opts

  const log = (msg: string) => onProgress?.(msg)

  const systemPrompt = SYSTEM_PROMPT_TEMPLATE.replaceAll("{max_turns}", String(maxTurns))
    .replaceAll("{max_commands}", String(maxCommands))
    .replaceAll("{max_results}", String(maxResults))

  const toolDefs = buildToolDefinitions(maxCommands)

  const repoMap = getRepoMap(projectRoot, treeDepth, excludePaths)
  log(
    `Repo map: tree -L ${repoMap.depth} (${(repoMap.sizeBytes / 1024).toFixed(1)}KB)` +
      (repoMap.depth < treeDepth ? ` [fell back from L=${treeDepth}]` : ""),
  )

  const userContent = `Problem Statement: ${query}\n\nRepo Map (tree -L ${repoMap.depth} /codebase):\n\`\`\`text\n${repoMap.tree}\n\`\`\``

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ]

  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`
  const totalTurns = maxTurns + 1 // +1 for final answer round
  let compensatedTurns = 0
  const MAX_COMPENSATIONS = 2
  let forceAnswerInjected = false

  for (let turn = 0; turn < totalTurns + compensatedTurns; turn++) {
    log(`Turn ${turn + 1}/${totalTurns}`)

    const reqBody = {
      model: upstreamModel,
      messages,
      tools: JSON.parse(toolDefs),
      stream: false,
    }

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${upstreamKey}`,
      },
      body: JSON.stringify(reqBody),
    })

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "")
      return {
        files: [],
        error: `HTTP ${resp.status}: ${errText.slice(0, 500)}`,
        _meta: { treeDepth: repoMap.depth, turn },
      }
    }

    const json = (await resp.json()) as any
    const choice = json.choices?.[0]
    if (!choice) {
      return { files: [], error: "no choice in response", _meta: { turn } }
    }

    const finishReason: string = choice.finish_reason ?? "stop"

    if (finishReason === "tool_calls") {
      const toolCalls = choice.message?.tool_calls
      if (!toolCalls || toolCalls.length === 0) {
        log(`Turn compensation: tool_calls finish but no tool_calls array, skipping`)
        compensatedTurns++
        if (compensatedTurns > MAX_COMPENSATIONS) break
        continue
      }

      let foundRestrictedExec = false
      let validCommands = 0

      for (const tc of toolCalls) {
        const fn = tc.function
        if (fn.name === "answer") {
          const args = JSON.parse(fn.arguments)
          const answerXml: string = args.answer || ""
          log("Received final answer")
          const files = parseAnswerXml(answerXml)
          return {
            files,
            rg_patterns: rgPatterns(),
            _meta: { treeDepth: repoMap.depth, turn },
          }
        }

        if (fn.name === "restricted_exec") {
          foundRestrictedExec = true
          const args = JSON.parse(fn.arguments)
          validCommands = Object.keys(args).filter((k) => k.startsWith("command")).length

          const callId = tc.id ?? crypto.randomUUID()
          const results = await execToolCall(args)
          messages.push({
            role: "assistant",
            content: choice.message?.content ?? null,
            tool_calls: [
              {
                id: callId,
                type: "function",
                function: { name: "restricted_exec", arguments: fn.arguments },
              },
            ],
          })
          messages.push({
            role: "tool",
            content: results,
            tool_call_id: callId,
          })
        }
      }

      if (!foundRestrictedExec && compensatedTurns < MAX_COMPENSATIONS) {
        compensatedTurns++
        log(`Turn compensation: no valid tool calls, extending (${compensatedTurns}/${MAX_COMPENSATIONS})`)
      }

      const effectiveTurn = turn - compensatedTurns
      if (effectiveTurn >= maxTurns - 1 && !forceAnswerInjected) {
        messages.push({ role: "user", content: FINAL_FORCE_ANSWER })
        forceAnswerInjected = true
        log("Injected force-answer prompt")
      }
    } else {
      // final answer (no more tool calls)
      const content = choice.message?.content ?? ""
      const files = parseAnswerXml(content)
      return {
        files,
        rg_patterns: rgPatterns(),
        _meta: { treeDepth: repoMap.depth, turn },
      }
    }
  }

  return {
    files: [],
    error: "Max turns reached without getting an answer",
    _meta: { treeDepth: repoMap.depth },
  }
}

function parseAnswerXml(xml: string): Array<{ path: string; ranges: Array<[number, number]> }> {
  const files: Array<{ path: string; ranges: Array<[number, number]> }> = []
  const fileRegex = /<file\s+path="([^"]+)">([\s\S]*?)<\/file>/g
  let fm: RegExpExecArray | null
  while ((fm = fileRegex.exec(xml)) !== null) {
    const vpath = fm[1]
    const ranges: Array<[number, number]> = []
    const rangeRegex = /<range>(\d+)-(\d+)<\/range>/g
    let rm: RegExpExecArray | null
    while ((rm = rangeRegex.exec(fm[2])) !== null) {
      ranges.push([parseInt(rm[1], 10), parseInt(rm[2], 10)])
    }
    files.push({ path: vpath, ranges })
  }
  return files
}
