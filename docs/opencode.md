# The opencode adapter (experimental)

kkamak's kernel is host-neutral, and this repo ships a second adapter for
opencode alongside the Claude Code one. It is **experimental**: it is unit
tested, but it has no packaged distribution, no marketplace equivalent, and
the end-to-end shape has not been confirmed against a live opencode build.
`gate.json` is shared — the same config drives both adapters.

## Installing

`src/adapters/opencode/plugin.ts` default-exports the plugin function opencode
loads. Its loader auto-loads any `.ts`/`.js` file under a `plugin/`-or-`plugins/`
directory — project-local (`.opencode/plugin/`) or global
(`~/.config/opencode/plugin/`) — with no config entry needed. There is no
packaged distribution, so symlink (not copy) the adapter file into one of them:

```bash
ln -s /path/to/kkamak/src/adapters/opencode/plugin.ts .opencode/plugin/kkamak.ts
```

The symlink works because the loader imports the path its directory scan found,
without first resolving it to a real path, and a module loaded that way still
resolves its own relative imports against its real target directory — so this
checkout's internal imports keep working. Both facts were confirmed by reading
opencode's loader and reproducing the mechanism locally. What is *not*
confirmed live: that opencode still expects this repo's exact plugin shape end
to end.

## How a block is delivered

opencode has no blocking stop hook. A block is delivered by continuing the
session instead: the adapter injects a user message prefixed `[kkamak-gate]`
carrying the check's output, rather than refusing the stop.

`marker` rides that same continuation-prompt mechanism. `notice` is logged to
stderr only and is never injected.

## Confirm it loaded

kkamak fails open, so a plugin that never loaded is indistinguishable from a
check that always passes. On first use, point `check` at something that fails,
edit a file, and let opencode go idle — you should see the `[kkamak-gate]`
message. Silence means it is not running.
