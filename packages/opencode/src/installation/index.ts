import path from "path"
import { Process } from "@/util/process"

export type Method = "curl" | "npm" | "yarn" | "pnpm" | "bun" | "brew" | "scoop" | "choco" | "unknown"

async function text(cmd: string[]) {
  const result = await Process.run(cmd, { nothrow: true })
  return result.stdout.toString("utf8")
}

export async function method(): Promise<Method> {
  if (process.execPath.includes(path.join(".opencode", "bin"))) return "curl"
  if (process.execPath.includes(path.join(".local", "bin"))) return "curl"
  const exec = process.execPath.toLowerCase()

  const checks: Array<{ name: Method; command: () => Promise<string> }> = [
    { name: "npm", command: () => text(["npm", "list", "-g", "--depth=0"]) },
    { name: "yarn", command: () => text(["yarn", "global", "list"]) },
    { name: "pnpm", command: () => text(["pnpm", "list", "-g", "--depth=0"]) },
    { name: "bun", command: () => text(["bun", "pm", "ls", "-g"]) },
    { name: "brew", command: () => text(["brew", "list", "--formula", "opencode"]) },
    { name: "scoop", command: () => text(["scoop", "list", "opencode"]) },
    { name: "choco", command: () => text(["choco", "list", "--limit-output", "opencode"]) },
  ]

  checks.sort((a, b) => {
    const aMatches = exec.includes(a.name)
    const bMatches = exec.includes(b.name)
    if (aMatches && !bMatches) return -1
    if (!aMatches && bMatches) return 1
    return 0
  })

  for (const check of checks) {
    const output = await check.command()
    const installedName =
      check.name === "brew" || check.name === "choco" || check.name === "scoop" ? "opencode" : "opencode-ai"
    if (output.includes(installedName)) {
      return check.name
    }
  }

  return "unknown"
}

export * as Installation from "."
