import type { PluginInput } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"
import { applyPatch } from "./apply.js"

type AiSdkTool = {
  execute?: (args: unknown, options: unknown) => Promise<unknown> | unknown
  toModelOutput?: (args: { output: unknown }) => Promise<unknown> | unknown
}

type AiSdkRequestInput = {
  model: unknown
  provider: {
    options?: Record<string, unknown>
  }
}

type AiSdkRequestOutput = {
  request: {
    tools?: Record<string, AiSdkTool>
    activeTools?: string[]
    [key: string]: unknown
  }
}

const APPLY_PATCH_DESCRIPTION = "Use the `apply_patch` tool to edit files."

const APPLY_PATCH_FREEFORM_DESCRIPTION =
  "Use the `apply_patch` tool to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON."

const APPLY_PATCH_LARK_GRAMMAR = String.raw`start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
`

const applyPatchTool = tool({
  description: APPLY_PATCH_DESCRIPTION,
  args: {
    patch: tool.schema.string().describe("A complete Codex apply_patch payload."),
  },
  async execute({ patch }, ctx) {
    return applyPatch(patch, ctx)
  },
})

export default {
  id: "codex-apply-patch",
  async server(_input: PluginInput) {
    return {
      tool: {
        apply_patch: applyPatchTool,
      },
      "ai-sdk.request": handleAiSdkRequest,
    }
  },
}

export async function handleAiSdkRequest(input: AiSdkRequestInput, output: AiSdkRequestOutput) {
  const option = input.provider.options?.codexApplyPatch
  if (option === undefined) return

  const tools = output.request.tools
  if (option === false || !isCodexApplyPatchEnabled(input)) {
    removeApplyPatchTool(output.request)
    return
  }

  if (!tools) return
  const normalApplyPatch = tools.apply_patch
  if (!normalApplyPatch?.execute) {
    removeApplyPatchTool(output.request)
    return
  }

  const { openai } = await import("@ai-sdk/openai")
  tools.apply_patch = openai.tools.customTool({
    name: "apply_patch",
    description: APPLY_PATCH_FREEFORM_DESCRIPTION,
    format: {
      type: "grammar",
      syntax: "lark",
      definition: APPLY_PATCH_LARK_GRAMMAR,
    },
    async execute(patch, options) {
      return normalApplyPatch.execute?.({ patch }, options)
    },
    toModelOutput({ output }) {
      return { type: "text", value: outputText(output) }
    },
  }) as AiSdkTool
}

export function isCodexApplyPatchEnabled(input: Pick<AiSdkRequestInput, "model" | "provider">) {
  const option = input.provider.options?.codexApplyPatch
  if (option === true) return true
  if (option === false || option === undefined) return false
  if (typeof option !== "string") return false

  try {
    const pattern = new RegExp(option)
    return modelMatcherValues(input.model).some((value) => pattern.test(value))
  } catch {
    return false
  }
}

function outputText(result: unknown) {
  if (typeof result === "string") return result
  if (isRecord(result) && typeof result.output === "string") return result.output
  return JSON.stringify(result)
}

function removeApplyPatchTool(request: AiSdkRequestOutput["request"]) {
  delete request.tools?.apply_patch
  if (request.activeTools) request.activeTools = request.activeTools.filter((tool) => tool !== "apply_patch")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function modelMatcherValues(model: unknown) {
  if (!isRecord(model)) return []
  return ["id", "modelID", "name"].flatMap((key) => {
    const value = model[key]
    return typeof value === "string" ? [value] : []
  })
}
