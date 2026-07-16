import { describe, expect, test } from "bun:test"
import nodePath from "node:path"
import {
  InvalidHunkError,
  InvalidPatchError,
  ParseMode,
  type ApplyPatchArgs,
  type Hunk,
  parseOneHunk,
  parsePatchText,
  parseUpdateFileChunk,
  resolveHunkPath,
} from "./parser.js"

describe("Codex apply_patch parser", () => {
  test("parseOneHunk rejects invalid hunk headers", () => {
    expectInvalidHunk(
      () => parseOneHunk(["bad"], 234),
      "'bad' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'",
      234,
    )
  })

  test("parseUpdateFileChunk matches Codex parser cases", () => {
    expectInvalidHunk(
      () => parseUpdateFileChunk(["bad"], 123, false),
      "Expected update hunk to start with a @@ context marker, got: 'bad'",
      123,
    )
    expectInvalidHunk(() => parseUpdateFileChunk(["@@"], 123, false), "Update hunk does not contain any lines", 124)
    expectInvalidHunk(
      () => parseUpdateFileChunk(["@@", "bad"], 123, false),
      "Unexpected line found in update hunk: 'bad'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)",
      124,
    )
    expectInvalidHunk(
      () => parseUpdateFileChunk(["@@", "*** End of File"], 123, false),
      "Update hunk does not contain any lines",
      124,
    )

    expect(
      parseUpdateFileChunk(
        ["@@ change_context", "", " context", "-remove", "+add", " context2", "*** End Patch"],
        123,
        false,
      ),
    ).toEqual({
      chunk: {
        changeContext: "change_context",
        oldLines: ["", "context", "remove", "context2"],
        newLines: ["", "context", "add", "context2"],
        isEndOfFile: false,
      },
      parsedLines: 6,
    })

    expect(parseUpdateFileChunk(["@@", "+line", "*** End of File"], 123, false)).toEqual({
      chunk: {
        changeContext: undefined,
        oldLines: [],
        newLines: ["line"],
        isEndOfFile: true,
      },
      parsedLines: 3,
    })
  })

  test("parsePatchText matches core Codex parser cases", () => {
    expectInvalidPatch(
      () => parsePatchText("bad", ParseMode.Strict),
      "The first line of the patch must be '*** Begin Patch'",
    )
    expectInvalidPatch(
      () => parsePatchText("*** Begin Patch\nbad", ParseMode.Strict),
      "The last line of the patch must be '*** End Patch'",
    )

    expect(parsePatchText("*** Begin Patch \n*** Add File: foo\n+hi\n *** End Patch", ParseMode.Strict).hunks).toEqual([
      { type: "add", path: "foo", contents: "hi\n" },
    ])

    expectInvalidHunk(
      () => parsePatchText("*** Begin Patch\n*** Update File: test.py\n*** End Patch", ParseMode.Strict),
      "Update file hunk for path 'test.py' is empty",
      2,
    )

    expect(parsePatchText("*** Begin Patch\n*** End Patch", ParseMode.Strict).hunks).toEqual([])

    expect(
      parsePatchText(
        `*** Begin Patch
*** Add File: path/add.py
+abc
+def
*** Delete File: path/delete.py
*** Update File: path/update.py
*** Move to: path/update2.py
@@ def f():
-    pass
+    return 123
*** End Patch`,
        ParseMode.Strict,
      ).hunks,
    ).toEqual([
      { type: "add", path: "path/add.py", contents: "abc\ndef\n" },
      { type: "delete", path: "path/delete.py" },
      {
        type: "update",
        path: "path/update.py",
        movePath: "path/update2.py",
        chunks: [
          {
            changeContext: "def f():",
            oldLines: ["    pass"],
            newLines: ["    return 123"],
            isEndOfFile: false,
          },
        ],
      },
    ])

    expect(
      parsePatchText(
        `*** Begin Patch
*** Update File: file.py
@@
+line
*** Add File: other.py
+content
*** End Patch`,
        ParseMode.Strict,
      ).hunks,
    ).toEqual([
      {
        type: "update",
        path: "file.py",
        movePath: undefined,
        chunks: [{ changeContext: undefined, oldLines: [], newLines: ["line"], isEndOfFile: false }],
      },
      { type: "add", path: "other.py", contents: "content\n" },
    ])

    expect(
      parsePatchText(
        `*** Begin Patch
*** Update File: file2.py
 import foo
+bar
*** End Patch`,
        ParseMode.Strict,
      ).hunks,
    ).toEqual([
      {
        type: "update",
        path: "file2.py",
        movePath: undefined,
        chunks: [
          {
            changeContext: undefined,
            oldLines: ["import foo"],
            newLines: ["import foo", "bar"],
            isEndOfFile: false,
          },
        ],
      },
    ])
  })

  test("parsePatchText accepts relative and absolute hunk paths", () => {
    const absoluteDelete = nodePath.resolve("/tmp", "absolute-delete.py")
    const absoluteUpdate = nodePath.resolve("/tmp", "absolute-update.py")
    const patchText = `*** Begin Patch
*** Add File: relative-add.py
+content
*** Delete File: ${absoluteDelete}
*** Update File: ${absoluteUpdate}
@@
-old
+new
*** End Patch`

    expect(parsePatchText(patchText, ParseMode.Strict).hunks).toEqual([
      { type: "add", path: "relative-add.py", contents: "content\n" },
      { type: "delete", path: absoluteDelete },
      {
        type: "update",
        path: absoluteUpdate,
        movePath: undefined,
        chunks: [{ changeContext: undefined, oldLines: ["old"], newLines: ["new"], isEndOfFile: false }],
      },
    ])
  })

  test("resolveHunkPath accepts relative and absolute paths", () => {
    const cwd = nodePath.resolve("/tmp", "codex-apply-patch-cwd")
    const absoluteAdd = nodePath.resolve("/tmp", "absolute-add.py")
    const absoluteDelete = nodePath.resolve("/tmp", "absolute-delete.py")
    const absoluteUpdate = nodePath.resolve("/tmp", "absolute-update.py")

    const cases: Array<[Hunk, string]> = [
      [{ type: "add", path: "relative-add.py", contents: "" }, nodePath.join(cwd, "relative-add.py")],
      [{ type: "delete", path: "relative-delete.py" }, nodePath.join(cwd, "relative-delete.py")],
      [
        { type: "update", path: "relative-update.py", movePath: undefined, chunks: [] },
        nodePath.join(cwd, "relative-update.py"),
      ],
      [{ type: "add", path: absoluteAdd, contents: "" }, absoluteAdd],
      [{ type: "delete", path: absoluteDelete }, absoluteDelete],
      [{ type: "update", path: absoluteUpdate, movePath: undefined, chunks: [] }, absoluteUpdate],
    ]

    for (const [hunk, expectedPath] of cases) expect(resolveHunkPath(hunk, cwd)).toBe(expectedPath)
  })

  test("parsePatchText supports Codex lenient heredoc parsing", () => {
    const patchText = `*** Begin Patch
*** Update File: file2.py
 import foo
+bar
*** End Patch`
    const expectedHunks: Hunk[] = [
      {
        type: "update",
        path: "file2.py",
        movePath: undefined,
        chunks: [
          {
            changeContext: undefined,
            oldLines: ["import foo"],
            newLines: ["import foo", "bar"],
            isEndOfFile: false,
          },
        ],
      },
    ]

    for (const opener of ["<<EOF", "<<'EOF'", '<<"EOF"']) {
      const patchTextInHeredoc = `${opener}\n${patchText}\nEOF\n`
      expectInvalidPatch(
        () => parsePatchText(patchTextInHeredoc, ParseMode.Strict),
        "The first line of the patch must be '*** Begin Patch'",
      )
      expect(parsePatchText(patchTextInHeredoc, ParseMode.Lenient)).toEqual({
        hunks: expectedHunks,
        patch: patchText,
        environmentId: undefined,
      } satisfies ApplyPatchArgs)
    }

    const mismatchedQuotesHeredoc = `<<"EOF'\n${patchText}\nEOF\n`
    expectInvalidPatch(
      () => parsePatchText(mismatchedQuotesHeredoc, ParseMode.Strict),
      "The first line of the patch must be '*** Begin Patch'",
    )
    expectInvalidPatch(
      () => parsePatchText(mismatchedQuotesHeredoc, ParseMode.Lenient),
      "The first line of the patch must be '*** Begin Patch'",
    )

    const missingClosingHeredoc = "<<EOF\n*** Begin Patch\n*** Update File: file2.py\nEOF\n"
    expectInvalidPatch(
      () => parsePatchText(missingClosingHeredoc, ParseMode.Strict),
      "The first line of the patch must be '*** Begin Patch'",
    )
    expectInvalidPatch(
      () => parsePatchText(missingClosingHeredoc, ParseMode.Lenient),
      "The last line of the patch must be '*** End Patch'",
    )
  })

  test("parsePatchText supports environment id preamble", () => {
    expect(
      parsePatchText(
        `*** Begin Patch
*** Environment ID: remote
*** Add File: hello.txt
+hello
*** End Patch`,
        ParseMode.Strict,
      ),
    ).toEqual({
      hunks: [{ type: "add", path: "hello.txt", contents: "hello\n" }],
      patch: "*** Begin Patch\n*** Environment ID: remote\n*** Add File: hello.txt\n+hello\n*** End Patch",
      environmentId: "remote",
    } satisfies ApplyPatchArgs)

    expectInvalidPatch(
      () =>
        parsePatchText(
          `*** Begin Patch
*** Environment ID:   
*** Add File: hello.txt
+hello
*** End Patch`,
          ParseMode.Strict,
        ),
      "apply_patch environment_id cannot be empty",
    )
  })
})

function expectInvalidPatch(fn: () => unknown, message: string) {
  expectInvalidError(fn, InvalidPatchError, `invalid patch: ${message}`)
}

function expectInvalidHunk(fn: () => unknown, message: string, lineNumber: number) {
  const error = expectInvalidError(fn, InvalidHunkError, `invalid hunk at line ${lineNumber}, ${message}`)
  if (!(error instanceof InvalidHunkError)) throw new Error("expected InvalidHunkError")
  expect(error.lineNumber).toBe(lineNumber)
}

function expectInvalidError(
  fn: () => unknown,
  errorClass: typeof InvalidPatchError | typeof InvalidHunkError,
  message: string,
) {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(errorClass)
    expect((error as Error).message).toBe(message)
    return error as Error
  }
  throw new Error("expected function to throw")
}
