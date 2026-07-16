import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import nodePath from "node:path"
import {
  contains,
  containsNormalized,
  containsProjectPath,
  externalDirectoryRequest,
  isExternalProjectPath,
  normalizePathPattern,
  resolvePath,
  windowsPath,
} from "./index.js"

const win32Ops = {
  relative: nodePath.win32.relative,
  parse: nodePath.win32.parse,
  isAbsolute: nodePath.win32.isAbsolute,
}

describe("utils path containment", () => {
  test("windowsPath translates common Unix-looking Windows drive paths", () => {
    expect(windowsPath("/c/repo/file.txt", "win32")).toBe("C:/repo/file.txt")
    expect(windowsPath("/C:/repo/file.txt", "win32")).toBe("C:/repo/file.txt")
    expect(windowsPath("/cygdrive/d/repo/file.txt", "win32")).toBe("D:/repo/file.txt")
    expect(windowsPath("/mnt/e/repo/file.txt", "win32")).toBe("E:/repo/file.txt")
  })

  test("containsNormalized rejects Windows cross-drive paths", () => {
    expect(containsNormalized("D:/", "C:/oc-perm-test/outside/secret.txt", win32Ops, "win32")).toBe(false)
    expect(containsNormalized("C:/repo", "D:/x.txt", win32Ops, "win32")).toBe(false)
    expect(containsNormalized("C:/repo", "C:/repo/file.txt", win32Ops, "win32")).toBe(true)
  })

  test("contains rejects symlink escape from inside project", async () => {
    if (process.platform === "win32") return

    const temp = await mkdtemp(nodePath.join(os.tmpdir(), "opencode-utils-"))
    const project = nodePath.join(temp, "project")
    const outside = nodePath.join(temp, "outside-secret")
    await mkdir(project, { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(nodePath.join(outside, "secret.txt"), "secret")
    await symlink(outside, nodePath.join(project, "linked-outside"))

    expect(contains(project, nodePath.join(project, "linked-outside", "secret.txt"))).toBe(false)
  })

  test("containsProjectPath uses directory first and ignores root worktree", () => {
    expect(containsProjectPath("/repo/sub/file.txt", { directory: "/repo/sub", worktree: "/repo" })).toBe(true)
    expect(containsProjectPath("/repo/other/file.txt", { directory: "/repo/sub", worktree: "/repo" })).toBe(true)
    expect(containsProjectPath("/outside/file.txt", { directory: "/repo/sub", worktree: "/" })).toBe(false)
    expect(isExternalProjectPath("/outside/file.txt", { directory: "/repo/sub", worktree: "/" })).toBe(true)
  })

  test("externalDirectoryRequest matches opencode permission shape", () => {
    expect(externalDirectoryRequest("/outside/secret.txt", "file", { platform: "linux" })).toEqual({
      permission: "external_directory",
      patterns: ["/outside/*"],
      always: ["/outside/*"],
      metadata: {
        filepath: "/outside/secret.txt",
        parentDir: "/outside",
      },
    })

    expect(externalDirectoryRequest("/outside", "directory", { platform: "linux" })).toEqual({
      permission: "external_directory",
      patterns: ["/outside/*"],
      always: ["/outside/*"],
      metadata: {
        filepath: "/outside",
        parentDir: "/outside",
      },
    })
  })

  test("normalizes Windows external directory glob patterns", () => {
    expect(normalizePathPattern("C:/repo/*", { platform: "win32", realpathNative: (path) => path })).toBe("C:\\repo\\*")
  })

  test("resolvePath follows opencode absolute-or-directory-relative behavior", () => {
    expect(resolvePath("/repo/sub", "file.txt", "linux")).toBe("/repo/sub/file.txt")
    expect(resolvePath("/repo/sub", "/tmp/file.txt", "linux")).toBe("/tmp/file.txt")
    expect(resolvePath("C:/repo/sub", "file.txt", "win32")).toBe("C:\\repo\\sub\\file.txt")
    expect(resolvePath("C:/repo/sub", "D:/tmp/file.txt", "win32")).toBe("D:/tmp/file.txt")
  })
})
