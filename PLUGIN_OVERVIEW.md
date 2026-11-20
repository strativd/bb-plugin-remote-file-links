Share the exact version of a file or give someone a link that follows a branch. Open a file in BB’s file panel and search the command palette for **Copy GitHub**.

## What you get

- Copy a permalink for a file version known to be published on GitHub.
- Copy a link to the current branch or the default branch when that file exists on the branch.
- Run `bb file-link resolve` to get available URLs as JSON for a workspace file, with an optional line range or commit.

## Requirements

Use BB 0.50.1 or later and a workspace Git repository with a GitHub remote. The resolver uses the Git refs already fetched on the workspace machine. Anyone opening a private repository link needs access to that repository.
