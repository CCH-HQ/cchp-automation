import { expect, test } from "bun:test"
import { buildPatchIndex } from "./patch-index"

test("buildPatchIndex: maps each path to its hunk headers in order", () => {
  const patch =
    "diff --git a/a.go b/a.go\n--- a/a.go\n+++ b/a.go\n@@ -1,2 +1,3 @@\n x\n+y\n@@ -10 +11 @@\n-z\n+w\n" +
    "diff --git a/b.txt b/b.txt\nnew file mode 100644\n--- /dev/null\n+++ b/b.txt\n@@ -0,0 +1 @@\n+hi\n"
  const idx = buildPatchIndex(patch)
  expect(idx["a.go"]).toEqual(["@@ -1,2 +1,3 @@", "@@ -10 +11 @@"])
  expect(idx["b.txt"]).toEqual(["@@ -0,0 +1 @@"])
})

test("buildPatchIndex: a deleted file (+++ /dev/null) keys on the old path", () => {
  const patch =
    "diff --git a/gone.go b/gone.go\ndeleted file mode 100644\n--- a/gone.go\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n"
  const idx = buildPatchIndex(patch)
  expect(idx["gone.go"]).toEqual(["@@ -1,2 +0,0 @@"])
})

test("buildPatchIndex: registers a file even when it has no hunks", () => {
  const patch = "diff --git a/pure/dst b/pure/dst\nrename from pure/src\nrename to pure/dst\n--- a/pure/src\n+++ b/pure/dst\n"
  const idx = buildPatchIndex(patch)
  expect(idx["pure/dst"]).toEqual([])
})

test("buildPatchIndex: empty patch → empty index", () => {
  expect(buildPatchIndex("")).toEqual({})
})
