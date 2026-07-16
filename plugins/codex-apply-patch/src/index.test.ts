import { describe, expect, test } from "bun:test"
import { handleAiSdkRequest, isCodexApplyPatchEnabled } from "./index.js"

describe("codexApplyPatch option matcher", () => {
  test("undefined and false disable the AI SDK freeform hook", () => {
    expect(isCodexApplyPatchEnabled(input(undefined, { id: "gpt-5-codex" }))).toBe(false)
    expect(isCodexApplyPatchEnabled(input(false, { id: "gpt-5-codex" }))).toBe(false)
  })

  test("true enables the AI SDK freeform hook for every model", () => {
    expect(isCodexApplyPatchEnabled(input(true, { id: "claude-sonnet" }))).toBe(true)
  })

  test("string option is treated as regex over model id fields", () => {
    expect(isCodexApplyPatchEnabled(input("gpt-", { id: "gpt-5-codex" }))).toBe(true)
    expect(isCodexApplyPatchEnabled(input("^gpt-", { modelID: "gpt-5.1" }))).toBe(true)
    expect(isCodexApplyPatchEnabled(input("codex$", { name: "gpt-5-codex" }))).toBe(true)
    expect(isCodexApplyPatchEnabled(input("^gpt-", { id: "claude-sonnet" }))).toBe(false)
  })

  test("invalid regex and unsupported values disable the hook", () => {
    expect(isCodexApplyPatchEnabled(input("[", { id: "gpt-5-codex" }))).toBe(false)
    expect(isCodexApplyPatchEnabled(input({ models: ["gpt-5-codex"] }, { id: "gpt-5-codex" }))).toBe(false)
  })
})

describe("ai-sdk.request apply_patch exposure", () => {
  test("undefined config leaves the model request unchanged", async () => {
    const output = requestOutput()
    const original = output.request.tools?.apply_patch

    await handleAiSdkRequest(input(undefined, { id: "gpt-5-codex" }), output)

    expect(output.request.tools?.apply_patch).toBe(original)
    expect(output.request.activeTools).toEqual(["apply_patch", "read"])
  })

  test("false config removes plain apply_patch from the model request", async () => {
    const output = requestOutput()

    await handleAiSdkRequest(input(false, { id: "gpt-5-codex" }), output)

    expect(output.request.tools?.apply_patch).toBeUndefined()
    expect(output.request.activeTools).toEqual(["read"])
  })

  test("nonmatching regex removes plain apply_patch from the model request", async () => {
    const output = requestOutput()

    await handleAiSdkRequest(input("^gpt-", { id: "claude-sonnet" }), output)

    expect(output.request.tools?.apply_patch).toBeUndefined()
    expect(output.request.activeTools).toEqual(["read"])
  })

  test("matching config replaces plain apply_patch with freeform custom tool", async () => {
    const output = requestOutput()
    const original = output.request.tools?.apply_patch
    const structuredResult = {
      title: "apply_patch x.ts",
      output: "Success. Updated the following files:\nM x.ts",
      metadata: { files: [{ relativePath: "x.ts", patch: "@@\n-old\n+new" }] },
    }

    await handleAiSdkRequest(input("^gpt-", { id: "gpt-5-codex" }), output)

    expect(output.request.tools?.apply_patch).toBeDefined()
    expect(output.request.tools?.apply_patch).not.toBe(original)
    expect(output.request.activeTools).toEqual(["apply_patch", "read"])

    const tool = output.request.tools?.apply_patch as
      | {
          execute?: (args: unknown, options: unknown) => Promise<unknown> | unknown
          toModelOutput?: (args: { output: unknown }) => unknown
        }
      | undefined
    await expect(tool?.execute?.("raw patch", { toolCallId: "call_1" })).resolves.toEqual(structuredResult)
    expect(tool?.toModelOutput?.({ output: structuredResult })).toEqual({
      type: "text",
      value: structuredResult.output,
    })
  })
})

function input(codexApplyPatch: unknown, model: unknown) {
  return { model, provider: { options: codexApplyPatch === undefined ? {} : { codexApplyPatch } } }
}

function requestOutput() {
  const structuredResult = {
    title: "apply_patch x.ts",
    output: "Success. Updated the following files:\nM x.ts",
    metadata: { files: [{ relativePath: "x.ts", patch: "@@\n-old\n+new" }] },
  }

  return {
    request: {
      tools: {
        apply_patch: {
          async execute(args: unknown, options: unknown) {
            expect(args).toEqual({ patch: "raw patch" })
            expect(options).toEqual({ toolCallId: "call_1" })
            return structuredResult
          },
        },
        read: {},
      },
      activeTools: ["apply_patch", "read"],
    },
  }
}
