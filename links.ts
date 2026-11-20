import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
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
type RemoteRef = RemoteBranch & { commit: string; blob: string };

const empty: Links = { permalink: null, current: null, default: null };

async function git(cwd: string, ...args: string[]): Promise<string> {
  try {
    const { stdout } = await exec(
      "git",
      ["--no-optional-locks", "-C", cwd, ...args],
      {
        timeout: 4500,
        maxBuffer: 128 * 1024,
        windowsHide: true,
        env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
      },
    );
    return stdout.trimEnd();
  } catch {
    return "";
  }
}

async function blobSha256(repo: string, blob: string): Promise<string | null> {
  try {
    const { stdout } = await exec(
      "git",
      ["--no-optional-locks", "-C", repo, "cat-file", "blob", blob],
      {
        encoding: "buffer",
        timeout: 4500,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
      },
    );
    return createHash("sha256").update(stdout).digest("hex");
  } catch {
    return null;
  }
}

function githubRepo(remote: string): string | null {
  const ssh = /^git@github\.com:(.*)$/i.exec(remote);
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
  path = path.replace(/\.git$|\/$/g, "");
  return /^[\w.-]+\/[\w.-]+$/.test(path) &&
    !path.split("/").some((part) => part === "." || part === "..")
    ? `https://github.com/${path}`
    : null;
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export async function resolveLinks({
  path,
  root,
  ref,
  location,
  contentSha256,
}: {
  path: string;
  root?: string;
  ref?: string;
  location: ExperimentalFileLocation | null;
  contentSha256?: string | null;
}): Promise<Links> {
  if (
    (!root && !isAbsolute(path)) ||
    (root && (isAbsolute(path) || path.split(/[/\\]/).includes("..")))
  ) {
    return empty;
  }
  const file = resolve(root ?? "", path);
  const parent = await realpath(dirname(file)).catch(() => null);
  if (!parent) return empty;
  if (root) {
    const scope = await realpath(root).catch(() => null);
    if (!scope) return empty;
    const fromScope = relative(scope, parent);
    if (
      isAbsolute(fromScope) ||
      fromScope === ".." ||
      fromScope.startsWith(`..${sep}`)
    )
      return empty;
  }
  const repo = await git(parent, "rev-parse", "--show-toplevel");
  if (!repo) return empty;
  const canonicalRepo = await realpath(repo).catch(() => null);
  if (!canonicalRepo) return empty;
  const localPath = resolve(parent, basename(file));
  const filename = relative(canonicalRepo, localPath).split(sep).join("/");
  if (!filename || filename === ".." || filename.startsWith("../"))
    return empty;

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

  function remoteBranch(candidate: string): RemoteBranch | null {
    const remote = remoteNames.find((name) =>
      candidate.startsWith(`refs/remotes/${name}/`),
    );
    if (remote === undefined) return null;
    const branch = candidate.slice(`refs/remotes/${remote}/`.length);
    return branch && branch !== "HEAD" ? { remote, branch } : null;
  }

  async function readRemoteRef(candidate: string): Promise<RemoteRef | null> {
    const target = remoteBranch(candidate);
    if (!target) return null;
    const commit = await git(
      repo,
      "rev-parse",
      "--verify",
      `${candidate}^{commit}`,
    );
    if (!commit) return null;
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

  const canLinkViewedLines =
    location === null ||
    contentSha256 === undefined ||
    (contentSha256 !== null &&
      Boolean(viewedBlob) &&
      contentSha256 === (await blobSha256(repo, viewedBlob)));

  async function makeLink(
    target: RemoteBranch,
    revision: string,
    blob: string,
  ): Promise<Link | null> {
    const repoUrl = githubRepo(
      await git(repo, "remote", "get-url", "--", target.remote),
    );
    if (!repoUrl) return null;
    const exact = canLinkViewedLines && blob === viewedBlob;
    let url = `${repoUrl}/blob/${encodePath(revision)}/${encodePath(filename)}`;
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

  const [currentLink, defaultLink] = await Promise.all([
    current ? makeLink(current, current.branch, current.blob) : null,
    defaultRef
      ? makeLink(defaultRef, defaultRef.branch, defaultRef.blob)
      : null,
  ]);
  let permalink = null;
  if (viewedBlob && canLinkViewedLines) {
    if (desiredCommit) {
      const publishedRefs = await git(
        repo,
        "for-each-ref",
        `--contains=${desiredCommit}`,
        "--format=%(refname)",
        "refs/remotes",
      );
      for (const ref of publishedRefs.split("\n")) {
        const candidate = remoteBranch(ref);
        if (!candidate) continue;
        permalink = await makeLink(candidate, desiredCommit, viewedBlob);
        if (permalink) break;
      }
    } else {
      for (const candidate of [current, defaultRef]) {
        if (!candidate || candidate.blob !== viewedBlob) continue;
        permalink = await makeLink(candidate, candidate.commit, viewedBlob);
        if (permalink) break;
      }
    }
  }
  return { permalink, current: currentLink, default: defaultLink };
}
