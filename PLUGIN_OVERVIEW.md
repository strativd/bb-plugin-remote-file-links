Share the exact version of a file or give someone a link that follows a branch. Open a workspace file in BB’s file panel and search the command palette for **Copy GitHub**.

## What you get

- Copy a permalink for a file version that matches locally fetched GitHub history.
- Copy a link to the current branch or the default branch when that file exists on the branch.
- Run `bb file-link resolve` to get available URLs as JSON for a workspace file, with an optional line range or commit.

## Requirements

Use BB 0.50.1 or later and a workspace Git repository with a GitHub remote. The resolver uses Git tracking refs with a matching local fetch record. Fetch the relevant remote if a link is unavailable. Anyone opening a private repository link needs access to that repository.
