import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { devNull } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";
import type { ExperimentalFileLocation } from "@get-bb/plugin-sdk";

const exec = promisify(execFile);
type Link = { url: string; branch: string; omittedLocation: boolean };
type Links = {
  permalink: Link | null;
  current: Link | null;
  default: Link | null;
};
type RemoteBranch = { remote: string; branch: string };
type RemoteRef = RemoteBranch & { repoUrl: string; commit: string; blob: string };

const empty: Links = { permalink: null, current: null, default: null };
const maxFetchHeadSize = 1024 * 1024;

async function readFetchHead(path: string): Promise<string> {
  try {
    if (!(await lstat(path)).isFile()) return "";
    const file = await open(
      path,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > maxFetchHeadSize) return "";
      const bytes = Buffer.alloc(stat.size + 1);
      const { bytesRead } = await file.read(bytes);
      return bytesRead === stat.size ? bytes.toString("utf8", 0, bytesRead) : "";
    } finally {
      await file.close();
    }
  } catch {
    return "";
  }
}

function githubRepo(remote: string): string | null {
  const ssh = /^(?:git@)?github\.com:(.*)$/i.exec(remote);
  let path = ssh?.[1];
  if (path === undefined) {
    try {
      const url = new URL(remote);
      if (
        url.hostname.toLowerCase() !== "github.com" ||
        (url.protocol !== "https:" && url.protocol !== "ssh:") ||
        url.port ||
        url.search ||
        url.hash
      )
        return null;
      path = url.pathname.slice(1);
    } catch {
      return null;
    }
  }
  path = path.replace(/\/$/, "").replace(/\.git$/, "");
  return /^[\w.-]+\/[\w.-]+$/.test(path) &&
    !path.split("/").some((part) => part === "." || part === "..")
    ? `https://github.com/${path}`
    : null;
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function isInside(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return (
    !isAbsolute(fromRoot) &&
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${sep}`)
  );
}

function isLocalAbsolute(path: string): boolean {
  return isAbsolute(path) && (sep !== "\\" || /^[a-z]:[/\\]/i.test(path));
}

export async function resolveLinks(
  {
    path,
    root,
    ref,
    location,
    contentSha256,
  }: {
    path: string;
    root: string;
    ref?: string;
    location: ExperimentalFileLocation | null;
    contentSha256?: string | null;
  },
  signal?: AbortSignal,
): Promise<Links> {
  if (
    !isLocalAbsolute(root) ||
    /^(?:[/\\]|[a-z]:)/i.test(path) ||
    path.split(/[/\\]/).includes("..") ||
    (sep === "\\" && path.includes(":"))
  ) {
    return empty;
  }
  signal?.throwIfAborted();
  const scope = await realpath(root).catch(() => null);
  if (!scope || !isLocalAbsolute(scope)) return empty;
  const file = resolve(scope, path);
  const parentPath = dirname(file);
  if (!isInside(scope, parentPath)) return empty;
  if (sep === "\\" && parentPath !== scope) {
    let folder = scope;
    for (const segment of relative(scope, parentPath).split(sep)) {
      folder = resolve(folder, segment);
      const stat = await lstat(folder).catch(() => null);
      if (!stat?.isDirectory() || stat.isSymbolicLink()) return empty;
    }
  }
  const parent = await realpath(parentPath).catch(() => null);
  if (!parent || !isInside(scope, parent)) return empty;

  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !/^git_/i.test(name)),
    ),
    GIT_ALLOW_PROTOCOL: "",
    GIT_GRAFT_FILE: devNull,
    GIT_NO_LAZY_FETCH: "1",
    GIT_TRACE: "0",
    GIT_TRACE2: "0",
    GIT_TRACE2_EVENT: "0",
    GIT_TRACE2_PERF: "0",
  };
  const gitArgs = (cwd: string, args: string[]) => [
    "--no-pager",
    "--no-optional-locks",
    "--no-replace-objects",
    "-C",
    cwd,
    ...args,
  ];
  async function git(cwd: string, ...args: string[]): Promise<string> {
    signal?.throwIfAborted();
    try {
      const { stdout } = await exec("git", gitArgs(cwd, args), {
        env,
        signal,
        timeout: 4500,
        maxBuffer: 128 * 1024,
        windowsHide: true,
      });
      return stdout.trimEnd();
    } catch {
      signal?.throwIfAborted();
      return "";
    }
  }

  const repo = await git(parent, "rev-parse", "--show-toplevel");
  if (!isLocalAbsolute(repo)) return empty;
  const canonicalRepo = await realpath(repo).catch(() => null);
  if (!canonicalRepo || !isInside(scope, canonicalRepo)) return empty;
  const localPath = resolve(parent, basename(file));
  if (localPath === canonicalRepo || !isInside(canonicalRepo, localPath))
    return empty;
  const filename = relative(canonicalRepo, localPath).split(sep).join("/");

  const [fetchHeadPath, commonDir] = await Promise.all([
    git(repo, "rev-parse", "--git-path", "FETCH_HEAD"),
    git(repo, "rev-parse", "--git-common-dir"),
  ]);
  // A linked worktree and the main checkout can have separate fetch records.
  const fetchHeadPaths = new Set(
    [fetchHeadPath, commonDir && resolve(repo, commonDir, "FETCH_HEAD")]
      .filter(Boolean)
      .map((path) => resolve(repo, path))
      .filter(isLocalAbsolute),
  );
  const fetched = new Set<string>();
  const fetchedKey = (repoUrl: string, branch: string, commit: string) =>
    `${repoUrl.toLowerCase()}\t${branch}\t${commit}`;
  for (const log of await Promise.all([...fetchHeadPaths].map(readFetchHead))) {
    for (const line of log.split("\n").slice(0, -1)) {
      const entry = /^([a-f0-9]{40}|[a-f0-9]{64})\t(?:not-for-merge)?\tbranch '(.+)' of (.+)$/.exec(
        line,
      );
      if (!entry) continue;
      const [, commit, branch, url] = entry;
      const repoUrl = githubRepo(url);
      if (repoUrl) fetched.add(fetchedKey(repoUrl, branch, commit));
    }
  }
  if (fetched.size === 0) return empty;

  const [remoteOutput, branchRef, desiredCommit] = await Promise.all([
    git(repo, "remote"),
    git(repo, "symbolic-ref", "--quiet", "HEAD"),
    ref && /^(HEAD|[a-f0-9]{4,64})$/i.test(ref)
      ? git(repo, "rev-parse", "--verify", `${ref}^{commit}`)
      : Promise.resolve(""),
  ]);
  if (ref && !desiredCommit) return empty;
  const remotes = remoteOutput.split("\n").filter(Boolean);
  const origin = remotes.includes("origin")
    ? "origin"
    : remotes.length === 1
      ? remotes[0]
      : undefined;
  const remoteNames = [...remotes].sort((a, b) => b.length - a.length);

  const branch = branchRef.startsWith("refs/heads/") ? branchRef.slice(11) : "";
  const upstream = branch
    ? await git(repo, "for-each-ref", "--format=%(upstream)", branchRef)
    : "";

  const remoteUrls = new Map<string, Promise<string | null>>();
  function remoteUrl(remote: string): Promise<string | null> {
    let url = remoteUrls.get(remote);
    if (!url) {
      url = git(repo, "remote", "get-url", "--", remote).then(githubRepo);
      remoteUrls.set(remote, url);
    }
    return url;
  }

  function remoteBranch(candidate: string): RemoteBranch | null {
    const remote = remoteNames.find((name) =>
      candidate.startsWith(`refs/remotes/${name}/`),
    );
    if (remote === undefined) return null;
    const branch = candidate.slice(`refs/remotes/${remote}/`.length);
    return branch && branch !== "HEAD" ? { remote, branch } : null;
  }

  async function publishedBranch(candidate: string, commit: string) {
    const target = remoteBranch(candidate);
    if (!target) return null;
    const repoUrl = await remoteUrl(target.remote);
    // Git keeps tracking refs when a remote URL changes.
    return repoUrl && fetched.has(fetchedKey(repoUrl, target.branch, commit))
      ? { ...target, repoUrl }
      : null;
  }

  async function readRemoteRef(candidate: string): Promise<RemoteRef | null> {
    if (!remoteBranch(candidate)) return null;
    const commit = await git(
      repo,
      "rev-parse",
      "--verify",
      `${candidate}^{commit}`,
    );
    if (!commit) return null;
    const target = await publishedBranch(candidate, commit);
    if (!target) return null;
    const blob = await git(
      repo,
      "rev-parse",
      "--verify",
      `${commit}:${filename}`,
    );
    if (!blob || (await git(repo, "cat-file", "-t", blob)) !== "blob")
      return null;
    return { ...target, commit, blob };
  }

  const [current, defaultRef, viewedBlob] = await Promise.all([
    readRemoteRef(
      upstream.split("\n")[0] ||
        (origin && branch ? `refs/remotes/${origin}/${branch}` : ""),
    ),
    origin
      ? git(
          repo,
          "symbolic-ref",
          "--quiet",
          `refs/remotes/${origin}/HEAD`,
        ).then(readRemoteRef)
      : null,
    desiredCommit
      ? git(repo, "rev-parse", "--verify", `${desiredCommit}:${filename}`)
      : lstat(localPath)
          .then((stat) =>
            stat.isFile()
              ? git(repo, "hash-object", "--no-filters", "--", localPath)
              : "",
          )
          .catch(() => ""),
  ]);

  async function blobSha256(blob: string): Promise<string | null> {
    signal?.throwIfAborted();
    try {
      const { stdout } = await exec(
        "git",
        gitArgs(repo, ["cat-file", "blob", blob]),
        {
          encoding: "buffer",
          env,
          signal,
          timeout: 4500,
          maxBuffer: 8 * 1024 * 1024,
          windowsHide: true,
        },
      );
      return createHash("sha256").update(stdout).digest("hex");
    } catch {
      signal?.throwIfAborted();
      return null;
    }
  }

  // undefined: the caller sent no hash; null: the viewer could not hash the content.
  const matchesViewer =
    contentSha256 === undefined ||
    (contentSha256 !== null &&
      Boolean(viewedBlob) &&
      contentSha256 === (await blobSha256(viewedBlob)));

  function makeLink(
    target: RemoteBranch & { repoUrl: string },
    revision: string,
    blob: string,
  ): Link {
    const exact = matchesViewer && blob === viewedBlob;
    let url = `${target.repoUrl}/blob/${encodePath(revision)}/${encodePath(filename)}`;
    if (location && exact) {
      if (/\.(?:md|markdown)$/i.test(filename)) url += "?plain=1";
      url +=
        location.kind === "line" || location.startLine === location.endLine
          ? `#L${location.kind === "line" ? location.line : location.startLine}`
          : `#L${location.startLine}-L${location.endLine}`;
    }
    return {
      url,
      branch: target.branch,
      omittedLocation: location !== null && !exact,
    };
  }

  const currentLink = current
    ? makeLink(current, current.branch, current.blob)
    : null;
  const defaultLink = defaultRef
    ? makeLink(defaultRef, defaultRef.branch, defaultRef.blob)
    : null;
  let permalink: Link | null = null;
  if (viewedBlob && matchesViewer) {
    if (desiredCommit) {
      const publishedRefs = await git(
        repo,
        "for-each-ref",
        `--contains=${desiredCommit}`,
        "--format=%(refname)%09%(objectname)",
        "refs/remotes",
      );
      for (const line of publishedRefs.split("\n")) {
        const [name, commit] = line.split("\t");
        if (!commit) continue;
        const candidate = await publishedBranch(name, commit);
        if (!candidate) continue;
        permalink = makeLink(candidate, desiredCommit, viewedBlob);
        break;
      }
    } else {
      for (const candidate of [current, defaultRef]) {
        if (!candidate || candidate.blob !== viewedBlob) continue;
        permalink = makeLink(candidate, candidate.commit, viewedBlob);
        break;
      }
    }
  }
  return { permalink, current: currentLink, default: defaultLink };
}
