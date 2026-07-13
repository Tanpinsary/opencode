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
import { graftRows, parseGraftTree, type GraftStatus, type GraftTree } from "./graft-tree"

export function Sidebar(props: { sessionID: string; overlay?: boolean }) {
  const pluginRuntime = usePluginRuntime()
  const project = useProject()
  const sync = useSync()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const session = createMemo(() => sync.session.get(props.sessionID))
  const [graftTree, setGraftTree] = createSignal<GraftTree>()
  const [collapsedGraftNodes, setCollapsedGraftNodes] = createSignal<ReadonlySet<string>>(new Set())
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
    return graftRows(tree, props.sessionID, collapsedGraftNodes())
  })
  const toggleGraftNode = (id: string) => {
    setCollapsedGraftNodes((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
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
  const isRunning = (sessionID: string) => {
    const status = sync.data.session_status[sessionID]
    return status !== undefined && status.type !== "idle"
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
                <box>
                  <For each={rows()}>
                    {(row) => (
                      <box width="100%" onMouseDown={() => row.children.length > 0 && toggleGraftNode(row.id)}>
                        <text fg={row.current ? theme.text : theme.textMuted} wrapMode="none">
                          {row.current ? "› " : "  "}
                          {row.prefix}
                          {row.children.length > 0 ? (row.expanded ? "▾ " : "▸ ") : "  "}
                          <span style={{ fg: statusColor(row.status) }}>{isRunning(row.id) ? "◉" : statusIcon(row.status)}</span>{" "}
                          {row.name}
                          <Show when={isRunning(row.id)}> <span style={{ fg: theme.warning }}>running</span></Show>
                        </text>
                      </box>
                    )}
                  </For>
                </box>
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
