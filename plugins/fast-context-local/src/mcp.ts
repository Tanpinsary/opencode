#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import type { AnySchema } from "@modelcontextprotocol/sdk/server/zod-compat.js"

import { search, FAST_CONTEXT_SEARCH_ARGS, FAST_CONTEXT_SEARCH_TOOL, loadConfig } from "./core"
import { ToolExecutor, getRepoMap } from "./executor"

const config = loadConfig(process.cwd())
const MAX_COMMANDS = config.max_commands
type McpFastContextSearchArgsShape = {
  [K in keyof typeof FAST_CONTEXT_SEARCH_ARGS]: AnySchema
}

const MCP_FAST_CONTEXT_SEARCH_ARGS = FAST_CONTEXT_SEARCH_ARGS as unknown as McpFastContextSearchArgsShape

if (!config.apiKey) {
  console.error("fast-context-local: apiKey is required. Set FAST_CONTEXT_API_KEY env var")
  process.exit(1)
}

const server = new McpServer({
  name: "fast-context-local",
  version: "0.1.0",
})

server.registerTool(
  FAST_CONTEXT_SEARCH_TOOL.name,
  {
    description: FAST_CONTEXT_SEARCH_TOOL.description,
    inputSchema: MCP_FAST_CONTEXT_SEARCH_ARGS,
  },
  async ({ query, project_path, tree_depth, max_turns, max_results, exclude_paths }) => {
    const projectRoot = project_path || process.cwd()

    try {
      const { statSync } = await import("node:fs")
      if (!statSync(projectRoot).isDirectory()) {
        return { content: [{ type: "text", text: `Error: project path does not exist: ${projectRoot}` }] }
      }
    } catch {
      return { content: [{ type: "text", text: `Error: project path does not exist: ${projectRoot}` }] }
    }

    const executor = new ToolExecutor(projectRoot)

    const result = await search({
      query,
      projectRoot,
      baseUrl: config.baseURL,
      upstreamKey: config.apiKey,
      upstreamModel: config.model,
      maxTurns: max_turns,
      maxCommands: MAX_COMMANDS,
      maxResults: max_results,
      treeDepth: tree_depth,
      excludePaths: exclude_paths,
      getRepoMap: (root, depth, excludes) => getRepoMap(root, depth, excludes),
      execToolCall: (args) => executor.execToolCallAsync(args),
    })

    if (result.error) {
      return {
        content: [
          {
            type: "text",
            text:
              `${result.error}\n\n` +
              `[hint] Suggestions:\n` +
              `  - Reduce tree_depth (current: ${tree_depth})\n` +
              `  - Add exclude_paths to filter large directories\n` +
              `  - Narrow project_path to a subdirectory\n` +
              `  - Reduce max_turns (current: ${max_turns})\n` +
              `${result._meta ? `[config] tree_depth=${result._meta.treeDepth} turn=${result._meta.turn}` : ""}`,
          },
        ],
      }
    }

    const fileLines = result.files.flatMap((f) => f.ranges.map(([s, e]) => `${f.path}:${s}-${e}`)).join("\n")
    const rgHint = result.rg_patterns?.length
      ? `\n\n[grep keywords]\n${result.rg_patterns.map((p) => `  rg "${p}"`).join("\n")}`
      : ""

    return {
      content: [
        {
          type: "text",
          text:
            `${fileLines}${rgHint}\n\n` +
            `[files: ${result.files.length}] [ranges: ${result.files.reduce((s, f) => s + f.ranges.length, 0)}]`,
        },
      ],
    }
  },
)

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
