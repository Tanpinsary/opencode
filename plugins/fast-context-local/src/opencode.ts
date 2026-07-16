import { type Plugin, tool } from "@opencode-ai/plugin"
import { externalDirectoryRequest, isExternalProjectPath, resolvePath } from "@opencode-plugins/utils"
import { search, loadConfig, FAST_CONTEXT_SEARCH_ARGS, FAST_CONTEXT_SEARCH_TOOL } from "./core"
import { ToolExecutor, getRepoMap } from "./executor"

const plugin: Plugin = async ({ directory, worktree }) => {
  const projectRoot = directory ?? worktree ?? process.cwd()

  return {
    tool: {
      [FAST_CONTEXT_SEARCH_TOOL.name]: tool({
        description: FAST_CONTEXT_SEARCH_TOOL.description,
        args: FAST_CONTEXT_SEARCH_ARGS,
        async execute(args, ctx) {
          const targetProjectRoot = resolvePath(ctx.directory, args?.project_path?.trim() || projectRoot)

          await ctx.ask({
            permission: FAST_CONTEXT_SEARCH_TOOL.name,
            patterns: [args.query],
            always: ["*"],
            metadata: { query: args.query, project_path: targetProjectRoot },
          })

          if (isExternalProjectPath(targetProjectRoot, { directory: ctx.directory, worktree: ctx.worktree })) {
            await ctx.ask(externalDirectoryRequest(targetProjectRoot, "directory"))
          }
          const config = loadConfig(targetProjectRoot)

          if (!config.apiKey) {
            return "Error: fast-context-local is unavailable because FAST_CONTEXT_API_KEY or the user-level fast-context-local.json apiKey is not configured. Fall back to rg, Glob, and Read."
          }

          const executor = new ToolExecutor(targetProjectRoot)

          const result = await search({
            query: args.query,
            projectRoot: executor.root,
            baseUrl: config.baseURL,
            upstreamKey: config.apiKey,
            upstreamModel: config.model,
            maxTurns: args.max_turns,
            maxCommands: config.max_commands,
            maxResults: args.max_results,
            treeDepth: args.tree_depth,
            excludePaths: args.exclude_paths ?? [],
            getRepoMap: (root, depth, excludes) => getRepoMap(root, depth, excludes),
            execToolCall: (toolArgs) => executor.execToolCallAsync(toolArgs),
            rgPatterns: () => executor.collectedRgPatterns,
          })

          if (result.error) {
            return (
              `${result.error}\n\n` +
              `[hint] Suggestions: reduce tree_depth, add exclude_paths, narrow project.\n` +
              `${result._meta ? `[config] tree_depth=${result._meta.treeDepth}` : ""}`
            )
          }

          const files = result.files.flatMap((file) => {
            const path = executor.answerPath(file.path)
            return path ? [{ ...file, path }] : []
          })
          const fileLines = files.flatMap((f) => f.ranges.map(([s, e]) => `${f.path}:${s}-${e}`)).join("\n")
          const rgHint = result.rg_patterns?.length
            ? `\n\n[grep keywords]\n${result.rg_patterns.map((p) => `  rg "${p}"`).join("\n")}`
            : ""

          return (
            `${fileLines}${rgHint}\n\n` +
            `[files: ${files.length}] [ranges: ${files.reduce((s, f) => s + f.ranges.length, 0)}]`
          )
        },
      }),
    },
  }
}

export default plugin
