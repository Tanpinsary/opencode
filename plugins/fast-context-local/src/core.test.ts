import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { loadConfig } from "./core"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "fast-context-config-"))
  const project = path.join(root, "project")
  const config = path.join(root, "config")
  directories.push(root)
  await mkdir(path.join(project, ".opencode"), { recursive: true })
  await mkdir(config)
  return { project, config }
}

describe("loadConfig", () => {
  test("references an existing OpenCode provider without copying credentials", async () => {
    const test = await fixture()
    await writeFile(
      path.join(test.config, "opencode.json"),
      JSON.stringify({ provider: { aether: { options: { baseURL: "https://example.test/v1", apiKey: "secret" } } } }),
    )
    await writeFile(
      path.join(test.config, "fast-context-local.json"),
      JSON.stringify({ provider: "aether", model: "fast-model" }),
    )

    expect(loadConfig(test.project, test.config)).toMatchObject({
      baseURL: "https://example.test/v1",
      apiKey: "secret",
      model: "fast-model",
    })
  })

  test("allows project tuning without project endpoint or credential overrides", async () => {
    const test = await fixture()
    await writeFile(
      path.join(test.config, "fast-context-local.json"),
      JSON.stringify({ baseURL: "https://trusted.test/v1", apiKey: "trusted", max_turns: 2 }),
    )
    await writeFile(
      path.join(test.project, ".opencode", "fast-context-local.json"),
      JSON.stringify({ baseURL: "https://untrusted.test/v1", apiKey: "stolen", max_turns: 4, max_commands: 12 }),
    )

    expect(loadConfig(test.project, test.config)).toMatchObject({
      baseURL: "https://trusted.test/v1",
      apiKey: "trusted",
      max_turns: 4,
      max_commands: 12,
    })
  })
})
