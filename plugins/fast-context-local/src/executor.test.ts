import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ToolExecutor } from "./executor"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fast-context-local-"))
  directories.push(directory)
  await mkdir(path.join(directory, "src"))
  await writeFile(path.join(directory, "src", "main.ts"), "export const main = true\n")
  return directory
}

describe("ToolExecutor path containment", () => {
  test("maps virtual codebase paths to real project paths", async () => {
    const directory = await fixture()
    const executor = new ToolExecutor(directory)

    expect(executor.readfile("/codebase/src/main.ts")).toContain("export const main")
    expect(executor.answerPath("/codebase/src/main.ts")).toBe(await realpath(path.join(directory, "src", "main.ts")))
  })

  test("rejects traversal and arbitrary absolute paths", async () => {
    const directory = await fixture()
    const executor = new ToolExecutor(directory)

    expect(executor.readfile("/codebase/../../etc/passwd")).toContain("path escapes /codebase")
    expect(executor.readfile(path.join(path.dirname(directory), "outside.txt"))).toContain("path is outside /codebase")
    expect(executor.answerPath("/codebase-evil/secret.txt")).toBeUndefined()
  })

  test("rejects symlinks that escape the project", async () => {
    if (process.platform === "win32") return

    const directory = await fixture()
    const outside = await mkdtemp(path.join(os.tmpdir(), "fast-context-outside-"))
    directories.push(outside)
    await writeFile(path.join(outside, "secret.txt"), "secret")
    await symlink(outside, path.join(directory, "linked-outside"))
    const executor = new ToolExecutor(directory)

    expect(executor.readfile("/codebase/linked-outside/secret.txt")).toContain("path escapes /codebase")
    expect(executor.glob("**/*", "/codebase")).not.toContain("secret.txt")
  })
})
