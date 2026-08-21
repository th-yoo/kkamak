import { test, expect } from "bun:test"
import { unsafeReason } from "../src/extensions/gauge/guard.ts"

// A derived check is MODEL-GENERATED SHELL run with the user's permissions in
// a real repo. Shadow mode does not make it read-only. The guard rejects any
// check that could mutate state, reach the network, or escalate — refusing a
// legitimate check only costs an M1 data point; running a destructive one
// costs the user's repo.

test("read-only checks pass (the shapes haiku actually produced live)", () => {
  expect(unsafeReason("test -f multiply.ts && grep -q 'export.*multiply' multiply.ts")).toBeUndefined()
  expect(unsafeReason("bun test test/auth.test.ts")).toBeUndefined()
  expect(unsafeReason("[ -f hello.txt ] && [ \"$(cat hello.txt)\" = \"hello\" ]")).toBeUndefined()
  expect(unsafeReason("test -f a.ts && [ $(grep -c 'test(' a.test.ts) -eq 3 ]")).toBeUndefined()
  expect(unsafeReason("bunx tsc --noEmit")).toBeUndefined()
  expect(unsafeReason("git status --porcelain | grep -q .")).toBeUndefined()
  expect(unsafeReason("ls -la && wc -l < file.txt")).toBeUndefined()
})

test("destructive filesystem commands are rejected", () => {
  expect(unsafeReason("rm -rf build && bun test")).toBe("destructive-command")
  expect(unsafeReason("bun test; rmdir tmp")).toBe("destructive-command")
  expect(unsafeReason("mv src/a.ts src/b.ts")).toBe("destructive-command")
  expect(unsafeReason("chmod 777 script.sh")).toBe("destructive-command")
  expect(unsafeReason("truncate -s 0 log.txt")).toBe("destructive-command")
})

test("privilege escalation is rejected", () => {
  expect(unsafeReason("sudo bun test")).toBe("privilege-escalation")
  expect(unsafeReason("doas ls")).toBe("privilege-escalation")
  expect(unsafeReason("su -c 'ls'")).toBe("privilege-escalation")
})

test("network access is rejected", () => {
  expect(unsafeReason("curl https://example.com/health")).toBe("network-access")
  expect(unsafeReason("wget -q -O- http://x")).toBe("network-access")
  expect(unsafeReason("nc -z localhost 8080")).toBe("network-access")
  expect(unsafeReason("ssh host 'ls'")).toBe("network-access")
})

test("state-changing git/package commands are rejected", () => {
  expect(unsafeReason("git push origin main")).toBe("state-changing-command")
  expect(unsafeReason("git commit -am wip")).toBe("state-changing-command")
  expect(unsafeReason("git checkout main")).toBe("state-changing-command")
  expect(unsafeReason("git reset --hard")).toBe("state-changing-command")
  expect(unsafeReason("npm install lodash")).toBe("state-changing-command")
  expect(unsafeReason("bun add zod")).toBe("state-changing-command")
  // read-only git stays allowed (covered above): status/log/diff/show
  expect(unsafeReason("git diff --stat")).toBeUndefined()
  expect(unsafeReason("git log --oneline -1")).toBeUndefined()
})

test("output redirection that writes files is rejected; input/compare redirs allowed", () => {
  expect(unsafeReason("bun test > results.txt")).toBe("output-redirection")
  expect(unsafeReason("echo hi >> log.txt")).toBe("output-redirection")
  expect(unsafeReason("bun test 2> err.txt")).toBe("output-redirection")
  // /dev/null discards are fine, and these read/compare forms must survive
  expect(unsafeReason("bun test >/dev/null 2>&1")).toBeUndefined()
  expect(unsafeReason("wc -l < file.txt")).toBeUndefined()
  expect(unsafeReason("diff <(sort a) <(sort b)")).toBeUndefined()
})

test("in-place editors and shell-escape hatches are rejected", () => {
  expect(unsafeReason("sed -i 's/a/b/' file.ts")).toBe("in-place-edit")
  expect(unsafeReason("perl -i -pe 's/a/b/' f")).toBe("in-place-edit")
  expect(unsafeReason("eval \"$(cat x)\"")).toBe("shell-escape")
  expect(unsafeReason("bash -c 'rm x'")).toBe("shell-escape")
  expect(unsafeReason("kill -9 123")).toBe("process-control")
  expect(unsafeReason("pkill node")).toBe("process-control")
})

test("word-anchored: safe substrings do not trip the guard", () => {
  expect(unsafeReason("grep -q 'formula' notes.md")).toBeUndefined() // contains "rm"
  expect(unsafeReason("test -f sudoku.ts")).toBeUndefined() // contains "sudo"
  expect(unsafeReason("grep -q 'curly' style.css")).toBeUndefined() // contains "curl"
  expect(unsafeReason("test -f moved.txt")).toBeUndefined() // contains "mv"
})

test("empty / whitespace-only check → no reason (caller handles null checks)", () => {
  expect(unsafeReason("")).toBeUndefined()
  expect(unsafeReason("   ")).toBeUndefined()
})

test("backtick command substitution is refused — word-anchored rules cannot see verbs after an unspaced backtick (found via a3 routing T3 review, 2026-08-13)", () => {
  expect(unsafeReason("echo `rm important-file`")).toBe("backtick-substitution")
  expect(unsafeReason("x=`rm f`")).toBe("backtick-substitution")
  expect(unsafeReason("echo `sudo reboot`")).toBe("backtick-substitution")
  expect(unsafeReason("echo `chmod 777 /etc/passwd`")).toBe("backtick-substitution")
  // $() interiors ARE scanned ("(" is in the separator class) — stays legal
  // when the inner command is itself safe:
  expect(unsafeReason("test $(wc -l < f) -gt 3")).toBeUndefined()
  expect(unsafeReason("echo $(rm f)")).toBeDefined() // inner rm still caught
})
