import { createMemo, onMount } from "solid-js"
import { useSync } from "../../context/sync"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import type { TextPart } from "@opencode-ai/sdk/v2"
import { Locale } from "../../util/locale"
import { useSDK } from "../../context/sdk"
import { useRoute } from "../../context/route"
import { useDialog } from "../../ui/dialog"
import type { PromptInfo } from "../../component/prompt/history"
import { stripPromptPartIDs as strip } from "../../prompt/part"
import { DialogPrompt } from "../../ui/dialog-prompt"

export function DialogForkFromTimeline(props: { sessionID: string; onMove: (messageID?: string) => void }) {
  const sync = useSync()
  const dialog = useDialog()
  const sdk = useSDK()
  const route = useRoute()

  const fork = async (messageID?: string, prompt?: PromptInfo) => {
    const name = await DialogPrompt.show(dialog, "Name fork", {
      placeholder: "fix-auth",
    })
    if (!name?.trim()) return
    const goal = await DialogPrompt.show(dialog, "Fork goal", {
      placeholder: "Optional one-line goal",
    })
    if (goal === null) return

    const forked = await sdk.client.session.fork({
      sessionID: props.sessionID,
      messageID,
      name: name.trim(),
      goal: goal.trim() || undefined,
    })
    route.navigate({
      sessionID: forked.data!.id,
      type: "session",
      prompt,
    })
    dialog.clear()
  }

  onMount(() => {
    dialog.setSize("large")
  })

  const options = createMemo((): DialogSelectOption<string | undefined>[] => {
    const messages = sync.data.message[props.sessionID] ?? []
    const fullSession = {
      title: "Full session",
      value: undefined,
      onSelect: async () => {
        await fork()
      },
    } satisfies DialogSelectOption<string | undefined>
    const result = [] as DialogSelectOption<string | undefined>[]
    for (const message of messages) {
      if (message.role !== "user") continue
      const part = (sync.data.part[message.id] ?? []).find(
        (x) => x.type === "text" && !x.synthetic && !x.ignored,
      ) as TextPart
      if (!part) continue
      result.push({
        title: part.text.replace(/\n/g, " "),
        value: message.id,
        footer: Locale.time(message.time.created),
        onSelect: async () => {
          const parts = sync.data.part[message.id] ?? []
          const prompt = parts.reduce(
            (agg, part) => {
              if (part.type === "text") {
                if (!part.synthetic) agg.input += part.text
              }
              if (part.type === "file") agg.parts.push(strip(part))
              return agg
            },
            { input: "", parts: [] as PromptInfo["parts"] },
          )
          await fork(message.id, prompt)
        },
      })
    }
    return [fullSession, ...result.reverse()]
  })

  return <DialogSelect onMove={(option) => props.onMove(option.value)} title="Fork session" options={options()} />
}
