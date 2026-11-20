# Remote File Links

Copy a GitHub permalink or branch link for a file you have open in BB.

## Install

Requires BB 0.50.1 or later and Git on the workspace machine.

```sh
bb plugin install 'git:https://github.com/strativd/bb-plugin-remote-file-links.git@^0.1.0'
```

## Use in BB

Open a file from a registered BB workspace or project checkout. In the command
palette (`⌘⇧P` on macOS), search for **Copy GitHub**. Choose a permalink, a link
to the current branch, or a link to the default branch.

The permalink shortcut is `⌘⌥⇧L` on macOS or `Ctrl+Alt+Shift+L` on Linux
and Windows. Change it in **Settings → Keyboard**.

The resolver works offline and uses local Git tracking refs for `github.com`.
It requires a matching branch and remote in Git's `FETCH_HEAD` record. If
Git lacks that record, for example after a fresh clone or after a fetch from
another remote, run `git fetch <remote>` in the repository to refresh it.
A permalink also requires a matching file version. Links to private
repositories can reveal the repository and file names to anyone you share
them with. Opening the file on GitHub requires repository access.

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
