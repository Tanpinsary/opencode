import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import nodePath from "node:path"
import type { ToolContext } from "@opencode-ai/plugin/tool"
import { applyPatch, deriveNewContentsFromChunks, seekSequence } from "./apply.js"

type AskInput = Parameters<ToolContext["ask"]>[0]
type MetadataInput = Parameters<ToolContext["metadata"]>[0]

describe("Codex apply_patch execution", () => {
  test("adds a file after edit permission", async () => {
    const fixture = await createFixture()
    const ctx = createContext(fixture)

    const result = await applyPatch(wrapPatch("*** Add File: add.txt\n+ab\n+cd"), ctx)

    expect(await readFile(nodePath.join(fixture.directory, "add.txt"), "utf8")).toBe("ab\ncd\n")
    expect(outputOf(result)).toBe("Success. Updated the following files:\nA subdir/add.txt")
    expect(ctx.calls.ask.map((input) => input.permission)).toEqual(["edit"])
    expect(ctx.calls.ask[0]?.patterns).toEqual(["subdir/add.txt"])
    expect(ctx.calls.metadata[0]?.metadata?.filepath).toBe("subdir/add.txt")
  })

  test("updates a file only after edit permission", async () => {
    const fixture = await createFixture()
    const target = nodePath.join(fixture.directory, "update.txt")
    await writeFile(target, "foo\nbar\n")
    const ctx = createContext(fixture, async (input) => {
      if (input.permission === "edit") expect(await readFile(target, "utf8")).toBe("foo\nbar\n")
    })

    const result = await applyPatch(wrapPatch("*** Update File: update.txt\n@@\n foo\n-bar\n+baz"), ctx)

    expect(await readFile(target, "utf8")).toBe("foo\nbaz\n")
    expect(outputOf(result)).toBe("Success. Updated the following files:\nM subdir/update.txt")
    expect(ctx.calls.ask.map((input) => input.permission)).toEqual(["edit"])
  })

  test("preserves trailing blank diff context for UI parsing", async () => {
    const fixture = await createFixture()
    const target = nodePath.join(fixture.directory, "blank-context.txt")
    await writeFile(target, "before\nold\n\nafter1\nafter2\n\nlater\n")
    const ctx = createContext(fixture)

    await applyPatch(wrapPatch("*** Update File: blank-context.txt\n@@\n-old\n+new\n \n after1\n after2\n "), ctx)

    const file = metadataFiles(ctx.calls.metadata[0]?.metadata)[0]
    expect(file?.patch).toContain("@@ -1,6 +1,6 @@")
    expect(file?.patch).toEndWith("\n ")
  })

  test("deletes a file", async () => {
    const fixture = await createFixture()
    const target = nodePath.join(fixture.directory, "delete.txt")
    await writeFile(target, "bye\n")
    const ctx = createContext(fixture)

    const result = await applyPatch(wrapPatch("*** Delete File: delete.txt"), ctx)

    expect(await Bun.file(target).exists()).toBe(false)
    expect(outputOf(result)).toBe("Success. Updated the following files:\nD subdir/delete.txt")
    expect(ctx.calls.ask[0]?.metadata.filepath).toBe("subdir/delete.txt")
  })

  test("moves an updated file and asks edit permission for source and destination", async () => {
    const fixture = await createFixture()
    const source = nodePath.join(fixture.directory, "src.txt")
    const dest = nodePath.join(fixture.directory, "nested", "dst.txt")
    await writeFile(source, "line\n")
    const ctx = createContext(fixture)

    const result = await applyPatch(
      wrapPatch("*** Update File: src.txt\n*** Move to: nested/dst.txt\n@@\n-line\n+line2"),
      ctx,
    )

    expect(await Bun.file(source).exists()).toBe(false)
    expect(await readFile(dest, "utf8")).toBe("line2\n")
    expect(outputOf(result)).toBe("Success. Updated the following files:\nM subdir/nested/dst.txt")
    expect(ctx.calls.ask[0]?.patterns).toEqual(["subdir/src.txt", "subdir/nested/dst.txt"])
  })

  test("plans multiple hunks against prior virtual file contents", async () => {
    const fixture = await createFixture()
    const target = nodePath.join(fixture.directory, "multi.txt")
    await writeFile(target, "one\ntwo\n")
    const ctx = createContext(fixture)

    await applyPatch(
      wrapPatch(`*** Update File: multi.txt
@@
-one
+ONE
*** Update File: multi.txt
@@
-two
+TWO`),
      ctx,
    )

    expect(await readFile(target, "utf8")).toBe("ONE\nTWO\n")
  })

  test("asks external_directory before reading or editing outside project", async () => {
    const fixture = await createFixture()
    const outside = nodePath.join(fixture.root, "outside", "external.txt")
    await mkdir(nodePath.dirname(outside), { recursive: true })
    const ctx = createContext(fixture, async (input) => {
      if (input.permission === "external_directory") expect(await Bun.file(outside).exists()).toBe(false)
    })

    await applyPatch(wrapPatch(`*** Add File: ${outside}\n+external`), ctx)

    expect(await readFile(outside, "utf8")).toBe("external\n")
    expect(ctx.calls.ask.map((input) => input.permission)).toEqual(["external_directory", "edit"])
    expect(ctx.calls.ask[0]?.patterns).toEqual([nodePath.join(nodePath.dirname(outside), "*").replaceAll("\\", "/")])
  })

  test("does not write when edit permission is rejected", async () => {
    const fixture = await createFixture()
    const target = nodePath.join(fixture.directory, "blocked.txt")
    const ctx = createContext(fixture, async (input) => {
      if (input.permission === "edit") throw new Error("denied")
    })

    await expect(applyPatch(wrapPatch("*** Add File: blocked.txt\n+nope"), ctx)).rejects.toThrow("denied")
    expect(await Bun.file(target).exists()).toBe(false)
  })

  test("ports Codex seekSequence and trailing newline replacement semantics", () => {
    expect(seekSequence(["    foo   ", "   bar\t"], ["foo", "bar"], 0, false)).toBe(0)
    expect(seekSequence(["quote “x”", "dash — y"], ['quote "x"', "dash - y"], 0, false)).toBe(0)
    expect(
      deriveNewContentsFromChunks("file.txt", [{ oldLines: ["old"], newLines: ["new"], isEndOfFile: true }], "old\n"),
    ).toBe("new\n")
  })
})

function wrapPatch(body: string) {
  return `*** Begin Patch\n${body}\n*** End Patch`
}

async function createFixture() {
  const root = await mkdtemp(nodePath.join(os.tmpdir(), "codex-apply-patch-"))
  const directory = nodePath.join(root, "project", "subdir")
  const worktree = nodePath.join(root, "project")
  await mkdir(directory, { recursive: true })
  return { root, directory, worktree }
}

function createContext(fixture: Awaited<ReturnType<typeof createFixture>>, onAsk?: (input: AskInput) => Promise<void>) {
  const calls: { ask: AskInput[]; metadata: MetadataInput[] } = { ask: [], metadata: [] }
  const controller = new AbortController()
  const ctx: ToolContext & { calls: typeof calls } = {
    sessionID: "session",
    messageID: "message",
    agent: "build",
    directory: fixture.directory,
    worktree: fixture.worktree,
    abort: controller.signal,
    metadata(input) {
      calls.metadata.push(input)
    },
    async ask(input) {
      calls.ask.push(input)
      await onAsk?.(input)
    },
    calls,
  }
  return ctx
}

function outputOf(result: Awaited<ReturnType<typeof applyPatch>>) {
  if (typeof result === "string") return result
  return result.output
}

function metadataFiles(metadata: MetadataInput["metadata"] | undefined) {
  const files = metadata?.files
  if (!Array.isArray(files)) return []
  return files.flatMap((file) =>
    typeof file === "object" && file !== null && "patch" in file && typeof file.patch === "string" ? [file] : [],
  )
}
