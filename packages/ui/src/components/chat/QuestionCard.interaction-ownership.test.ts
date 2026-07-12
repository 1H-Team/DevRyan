import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const source = readFileSync(
  fileURLToPath(new URL("./QuestionCard.tsx", import.meta.url)),
  "utf8",
)

describe("QuestionCard option interaction ownership", () => {
  test("delegates option rows without nested interactive checkbox or radio controls", () => {
    expect(source).toContain("<QuestionOptionRow")
    expect(source).not.toContain("<Checkbox")
    expect(source).not.toContain("<Radio")
    expect(source).not.toContain("@/components/ui/checkbox")
    expect(source).not.toContain("@/components/ui/radio")
  })
})
