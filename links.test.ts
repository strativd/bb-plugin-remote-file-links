import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { symlinkSync } from "node:fs";
import { test } from "node:test";
import { resolveLinks } from "./links.ts";

test("uses fetched refs for a nested workspace repository and matches line links", async () => {
  const root = mkdtempSync(join(tmpdir(), "bb-remote-file-links-"));
  try {
    const repo = join(root, "src", "nested");
    mkdirSync(repo, { recursive: true });
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
    git(root, "init", "-q");
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.name", "Test");
    git(repo, "config", "user.email", "test@example.invalid");
    git(repo, "config", "commit.gpgSign", "false");
    const name = "notes #1.md";
    const path = join(repo, name);
    const resolveFile = (
      input: Omit<Parameters<typeof resolveLinks>[0], "root" | "path">,
    ) => resolveLinks({ root, path: relative(root, path), ...input });
    const noLinks = { permalink: null, current: null, default: null };
    writeFileSync(path, "first\nsecond\nthird\n");
    git(repo, "add", "--", name);
    git(repo, "commit", "-qm", "main");
    git(repo, "remote", "add", "origin", "git@github.com:example/nested.git");
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(
      repo,
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    );
    const main = git(repo, "rev-parse", "HEAD");
    git(repo, "switch", "-qc", "feature/file-links");
    writeFileSync(path, "intro\nfirst\nsecond\nthird\n");
    git(repo, "commit", "-qam", "feature");
    const head = git(repo, "rev-parse", "HEAD");
    const location = { kind: "range" as const, startLine: 2, endLine: 3 };
    const base = "https://github.com/example/nested/blob";
    const fetchHead = join(repo, ".git", "FETCH_HEAD");
    const fetched = (commit: string, branch: string) =>
      `${commit}\tnot-for-merge\tbranch '${branch}' of github.com:example/nested\n`;
    assert.deepEqual(await resolveFile({ location }), noLinks);
    writeFileSync(fetchHead, fetched(main, "main"));
    const unpublished = await resolveFile({ location });
    assert.equal(unpublished.permalink, null);
    assert.equal(unpublished.current, null);
    assert.deepEqual(unpublished.default, {
      branch: "main",
      url: `${base}/main/notes%20%231.md`,
      omittedLocation: true,
    });

    git(repo, "update-ref", "refs/remotes/origin/feature/file-links", "HEAD");
    git(repo, "branch", "--set-upstream-to=origin/feature/file-links");
    writeFileSync(
      fetchHead,
      fetched(main, "main") + fetched(head, "feature/file-links"),
    );
    const published = await resolveFile({ location });
    assert.equal(
      published.permalink?.url,
      `${base}/${head}/notes%20%231.md?plain=1#L2-L3`,
    );
    assert.equal(
      published.current?.url,
      `${base}/feature/file-links/notes%20%231.md?plain=1#L2-L3`,
    );
    assert.equal(published.default?.omittedLocation, true);

    const worktree = join(root, "linked");
    git(repo, "worktree", "add", "--quiet", "--detach", worktree, head);
    const linked = await resolveLinks({
      root: worktree,
      path: name,
      location,
      ref: head,
    });
    assert.deepEqual(linked.permalink, published.permalink);

    git(
      repo, "remote", "set-url", "origin", "https://github.com/example/another.git",
    );
    assert.deepEqual(await resolveFile({ location, ref: head }), noLinks);
    git(
      repo, "remote", "set-url", "origin", "https://github.com/example/nested.git",
    );
    assert.deepEqual(await resolveFile({ location }), published);

    const displayed = createHash("sha256")
      .update("intro\nfirst\nsecond\nthird\n")
      .digest("hex");
    for (const contentSha256 of [null, "0".repeat(64)]) {
      for (const unsafeLocation of [location, null]) {
        const unsafe = await resolveFile({ location: unsafeLocation, contentSha256 });
        assert.equal(unsafe.permalink, null);
        if (unsafeLocation === location)
          assert.equal(unsafe.current?.omittedLocation, true);
      }
    }
    assert.deepEqual(
      await resolveFile({ location, contentSha256: displayed }),
      published,
    );

    const snapshot = await resolveFile({ location, ref: main });
    assert.equal(
      snapshot.permalink?.url,
      `${base}/${main}/notes%20%231.md?plain=1#L2-L3`,
    );

    writeFileSync(path, "dirty\n");
    assert.equal((await resolveFile({ location })).permalink, null);
    assert.equal(
      (await resolveFile({ location })).current?.omittedLocation,
      true,
    );

    git(repo, "restore", "--", name);
    git(repo, "switch", "--detach", main);
    git(repo, "rm", "--", name);
    git(repo, "commit", "-qm", "remove file from default branch");
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    writeFileSync(fetchHead, fetched(git(repo, "rev-parse", "HEAD"), "main"));
    const removed = await resolveFile({ location, ref: main });
    assert.equal(removed.default, null);
    assert.equal(removed.current, null);
    assert.equal(
      removed.permalink?.url,
      `${base}/${main}/notes%20%231.md?plain=1#L2-L3`,
    );

    const local = join(root, "local.md");
    writeFileSync(local, "local");
    assert.deepEqual(
      await resolveLinks({ root, path: relative(root, local), location: null }),
      noLinks,
    );

    // A published repository outside the workspace stays unreachable.
    const escape = join(root, "escape");
    mkdirSync(escape);
    git(escape, "init", "-q", "-b", "main");
    git(escape, "config", "user.name", "Test");
    git(escape, "config", "user.email", "test@example.invalid");
    git(escape, "config", "commit.gpgSign", "false");
    writeFileSync(join(escape, "secret.txt"), "secret\n");
    git(escape, "add", "secret.txt");
    git(escape, "commit", "-qm", "escape");
    git(escape, "remote", "add", "origin", "https://github.com/example/secret.git");
    git(escape, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(
      escape,
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    );
    writeFileSync(
      join(escape, ".git", "FETCH_HEAD"),
      `${git(escape, "rev-parse", "HEAD")}\tnot-for-merge\tbranch 'main' of https://github.com/example/secret\n`,
    );
    const escapeSha = git(escape, "rev-parse", "HEAD");
    symlinkSync(escape, join(repo, "leak"));
    for (const path of [
      "../escape/secret.txt",
      join("leak", "secret.txt"),
      "nested/../../escape/secret.txt",
    ]) {
      assert.deepEqual(
        await resolveLinks({ root, path, location: null }),
        noLinks,
      );
      assert.deepEqual(
        await resolveLinks({ root, path, location: null, ref: escapeSha }),
        noLinks,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
