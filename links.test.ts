import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveLinks } from "./links.ts";

test("uses the nested repo and only links lines in matching published blobs", async () => {
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
    const name = "notes #1.md";
    const path = join(repo, name);
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
    const unpublished = await resolveLinks({ path, location });
    assert.equal(unpublished.permalink, null);
    assert.equal(unpublished.current, null);
    assert.deepEqual(unpublished.default, {
      branch: "main",
      url: `${base}/main/notes%20%231.md`,
      omittedLocation: true,
    });

    git(repo, "update-ref", "refs/remotes/origin/feature/file-links", "HEAD");
    git(repo, "branch", "--set-upstream-to=origin/feature/file-links");
    const published = await resolveLinks({ path, location });
    assert.equal(
      published.permalink?.url,
      `${base}/${head}/notes%20%231.md?plain=1#L2-L3`,
    );
    assert.equal(
      published.current?.url,
      `${base}/feature/file-links/notes%20%231.md?plain=1#L2-L3`,
    );
    assert.equal(published.default?.omittedLocation, true);

    const displayed = createHash("sha256")
      .update("intro\nfirst\nsecond\nthird\n")
      .digest("hex");
    for (const contentSha256 of [null, "0".repeat(64)]) {
      const unsafe = await resolveLinks({ path, location, contentSha256 });
      assert.equal(unsafe.permalink, null);
      assert.equal(unsafe.current?.omittedLocation, true);
      assert.equal(unsafe.default?.omittedLocation, true);
    }
    assert.deepEqual(
      await resolveLinks({ path, location, contentSha256: displayed }),
      published,
    );

    const snapshot = await resolveLinks({ path, location, ref: main });
    assert.equal(
      snapshot.permalink?.url,
      `${base}/${main}/notes%20%231.md?plain=1#L2-L3`,
    );

    writeFileSync(path, "dirty\n");
    assert.equal((await resolveLinks({ path, location })).permalink, null);
    assert.equal(
      (await resolveLinks({ path, location })).current?.omittedLocation,
      true,
    );

    git(repo, "restore", "--", name);
    git(repo, "switch", "--detach", main);
    git(repo, "rm", "--", name);
    git(repo, "commit", "-qm", "remove file from default branch");
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    const removed = await resolveLinks({ path, location, ref: main });
    assert.equal(removed.default, null);
    assert.equal(removed.current, null);
    assert.equal(
      removed.permalink?.url,
      `${base}/${main}/notes%20%231.md?plain=1#L2-L3`,
    );

    const local = join(root, "local.md");
    writeFileSync(local, "local");
    assert.deepEqual(await resolveLinks({ path: local, location: null }), {
      permalink: null,
      current: null,
      default: null,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
