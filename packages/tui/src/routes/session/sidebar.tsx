import { useProject } from "../../context/project"
import { useSync } from "../../context/sync"
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { useTuiConfig } from "../../config"
import { InstallationChannel, InstallationVersion } from "@opencode-ai/core/installation/version"
import { usePluginRuntime } from "../../plugin/runtime"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { getScrollAcceleration } from "../../util/scroll"
import { WorkspaceLabel } from "../../component/workspace-label"

type GraftStatus = "active" | "merged" | "abandoned"

type GraftNode = {
  id: string
  name: string
  children: string[]
  status: GraftStatus
}

type GraftTree = {
  root: string
  nodes: Record<string, GraftNode>
}

type GraftRow = GraftNode & {
  prefix: string
  current: boolean
}

function parseGraftTree(raw: string): GraftTree | undefined {
  const value: unknown = JSON.parse(raw)
  if (!value || typeof value !== "object") return
  if (!("root" in value) || typeof value.root !== "string") return
  if (!("nodes" in value) || !value.nodes || typeof value.nodes !== "object") return
  return value as GraftTree
}

function graftRows(tree: GraftTree, sessionID: string): GraftRow[] {
  const rows: GraftRow[] = []
  const visited = new Set<string>()

  function visit(id: string, indent: string, last: boolean, root: boolean) {
    if (visited.has(id)) return
    const node = tree.nodes[id]
    if (!node) return
    visited.add(id)
    rows.push({
      ...node,
      prefix: root ? "" : `${indent}${last ? "└── " : "├── "}`,
      current: id === sessionID,
    })
    const nextIndent = root ? "" : `${indent}${last ? "    " : "│   "}`
    node.children.forEach((child, index) => visit(child, nextIndent, index === node.children.length - 1, false))
  }

  visit(tree.root, "", true, true)
  return rows
}

export function Sidebar(props: { sessionID: string; overlay?: boolean }) {
  const pluginRuntime = usePluginRuntime()
  const project = useProject()
  const sync = useSync()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const session = createMemo(() => sync.session.get(props.sessionID))
  const [graftTree, setGraftTree] = createSignal<GraftTree>()
  let graftRaw = ""

  async function refreshGraftTree() {
    const directory = project.instance.directory()
    if (!directory) return
    try {
      const raw = await readFile(join(directory, ".opencode", "session-tree.json"), "utf8")
      if (raw === graftRaw) return
      const tree = parseGraftTree(raw)
      if (!tree) return
      graftRaw = raw
      setGraftTree(tree)
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        graftRaw = ""
        setGraftTree(undefined)
      }
    }
  }

  onMount(() => {
    void refreshGraftTree()
    const timer = setInterval(() => void refreshGraftTree(), 1000)
    onCleanup(() => clearInterval(timer))
  })

  const rows = createMemo(() => {
    const tree = graftTree()
    if (!tree) return []
    return graftRows(tree, props.sessionID)
  })
  const statusIcon = (status: GraftStatus) => {
    if (status === "merged") return "✓"
    if (status === "abandoned") return "×"
    return "●"
  }
  const statusColor = (status: GraftStatus) => {
    if (status === "merged") return theme.success
    if (status === "abandoned") return theme.error
    return theme.primary
  }
  const workspace = () => {
    const workspaceID = session()?.workspaceID
    if (!workspaceID) return
    return project.workspace.get(workspaceID)
  }
  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))

  return (
    <Show when={session()}>
      <box
        backgroundColor={theme.backgroundPanel}
        width={42}
        height="100%"
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        position={props.overlay ? "absolute" : "relative"}
      >
        <scrollbox
          flexGrow={1}
          scrollAcceleration={scrollAcceleration()}
          verticalScrollbarOptions={{
            trackOptions: {
              backgroundColor: theme.background,
              foregroundColor: theme.borderActive,
            },
          }}
        >
          <box flexShrink={0} gap={1} paddingRight={1}>
            <pluginRuntime.Slot
              name="sidebar_title"
              mode="single_winner"
              session_id={props.sessionID}
              title={session()!.title}
              share_url={session()!.share?.url}
            >
              <box paddingRight={1}>
                <text fg={theme.text}>
                  <b>{session()!.title}</b>
                </text>
                <Show when={InstallationChannel !== "latest"}>
                  <text fg={theme.textMuted}>{props.sessionID}</text>
                </Show>
                <Show when={session()!.workspaceID}>
                  <text fg={theme.textMuted}>
                    <Show
                      when={workspace()}
                      fallback={<WorkspaceLabel type="unknown" name={session()!.workspaceID!} status="error" icon />}
                    >
                      {(item) => (
                        <WorkspaceLabel
                          type={item().type}
                          name={item().name}
                          status={project.workspace.status(item().id) ?? "error"}
                          icon
                        />
                      )}
                    </Show>
                  </text>
                </Show>
                <Show when={session()!.share?.url}>
                  <text fg={theme.textMuted}>{session()!.share!.url}</text>
                </Show>
              </box>
            </pluginRuntime.Slot>
            <box gap={1} paddingRight={1} paddingTop={1}>
              <text fg={theme.text}>
                <b>Fork Tree</b>
              </text>
              <Show when={rows().length > 0} fallback={<text fg={theme.textMuted}>No forks yet</text>}>
                <For each={rows()}>
                  {(row) => (
                    <text fg={row.current ? theme.text : theme.textMuted}>
                      {row.current ? "› " : "  "}
                      {row.prefix}
                      <span style={{ fg: statusColor(row.status) }}>{statusIcon(row.status)}</span> {row.name}
                    </text>
                  )}
                </For>
              </Show>
            </box>
            <pluginRuntime.Slot name="sidebar_content" session_id={props.sessionID} />
          </box>
        </scrollbox>

        <box flexShrink={0} gap={1} paddingTop={1}>
          <pluginRuntime.Slot name="sidebar_footer" mode="single_winner" session_id={props.sessionID}>
            <text fg={theme.textMuted}>
              <span style={{ fg: theme.success }}>•</span> <b>Open</b>
              <span style={{ fg: theme.text }}>
                <b>Code</b>
              </span>{" "}
              <span>{InstallationVersion}</span>
            </text>
          </pluginRuntime.Slot>
        </box>
      </box>
    </Show>
  )
}
