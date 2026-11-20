# Remote File Links

Copy a GitHub permalink or branch link for a file you have open in BB.

## Install

Requires BB 0.50.1 or later and Git on the workspace machine.

```sh
bb plugin install 'git:https://github.com/strativd/bb-plugin-remote-file-links.git@^0.1.0'
```

## Use in BB

Open a file in BB’s file panel. In the command palette (`⌘⇧P` on macOS),
search for **Copy GitHub**. Choose a permalink, a link to the current branch,
or a link to the default branch.

The permalink shortcut is `⌘⌥⇧L` on macOS or `Ctrl+Alt+Shift+L` on Linux
and Windows. Change it in **Settings → Keyboard**.

The plugin uses local Git remote-tracking refs for `github.com`. A permalink
requires a matching published file version. Fetch the relevant branches if
an expected link is missing. Recipients need repository access for private
links.

## CLI

```sh
bb file-link resolve <environment-id> <workspace-relative-path> --line 12-18
```

Use `--ref HEAD` or pass a commit SHA for a snapshot. The command prints
JSON with the permalink, current branch, and default branch links when
available. A branch link omits line numbers if the file version differs on
that branch. The plugin also exposes the `resolve` RPC.

## Development

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
bb plugin build
bb plugin install .
```

The plugin also accepts menu actions from BB builds with the experimental
file-action SDK. Viewer-owned menus and selections require support in both
the BB build and the viewer.

## License

[MIT](./LICENSE)
