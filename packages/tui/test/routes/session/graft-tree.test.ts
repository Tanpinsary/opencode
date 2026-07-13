import { describe, expect, test } from "bun:test"
import { graftRows, type GraftTree } from "../../../src/routes/session/graft-tree"

const tree: GraftTree = {
  root: "root",
  nodes: {
    root: { id: "root", name: "main", children: ["auth", "docs"], status: "active" },
    auth: { id: "auth", name: "auth", children: ["jwt"], status: "active" },
    jwt: { id: "jwt", name: "jwt", children: [], status: "merged" },
    docs: { id: "docs", name: "docs", children: [], status: "abandoned" },
  },
}

describe("graft tree rows", () => {
  test("shows the full tree expanded by default", () => {
    expect(graftRows(tree, "jwt").map((row) => [row.id, row.current, row.expanded])).toEqual([
      ["root", false, true],
      ["auth", false, true],
      ["jwt", true, false],
      ["docs", false, false],
    ])
  })

  test("hides descendants of collapsed forks without hiding siblings", () => {
    const rows = graftRows(tree, "jwt", new Set(["auth"]))

    expect(rows.map((row) => row.id)).toEqual(["root", "auth", "docs"])
    expect(rows.find((row) => row.id === "auth")?.expanded).toBe(false)
    expect(rows.find((row) => row.id === "docs")?.prefix).toBe("└── ")
  })

  test("can collapse the root to a single row", () => {
    expect(graftRows(tree, "root", new Set(["root"])).map((row) => row.id)).toEqual(["root"])
  })
})
