---
name: remote-file-links
description: Resolve GitHub permalinks and branch URLs for files opened in BB.
---

Use `bb file-link resolve <environment-id> <workspace-relative-path>` to
resolve a file in its containing Git repository, including nested repositories.
Pass `--line 12-18` for a one-based line range or `--ref <sha>` for a snapshot.
The output contains `permalink`, `current`, and `default` entries, each either
null or containing a URL, branch name, and `omittedLocation` flag.

The resolver reads cached GitHub tracking refs on the environment's host.
A missing result can mean the file or branch is local-only or the tracking
refs have not been fetched.
