import {
  cliCommand,
  defineCli,
  experimental_getRelativeHostPath,
  PluginCliError,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import {
  fileInput,
  fileLinkHostRpc,
  fileLinkRpc,
  type FileInput,
} from "./contract.js";

export default function remoteFileLinks(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: fileLinkHostRpc });
  const empty = { permalink: null, current: null, default: null };

  async function resolveTarget(
    target: FileInput["target"],
    signal?: AbortSignal,
  ) {
    if (target.kind === "workspace") {
      const environment = await bb.sdk.environments.get({
        environmentId: target.environmentId,
        signal,
      });
      return environment.status === "ready" && environment.path
        ? {
            hostId: environment.hostId,
            root: environment.path,
            path: target.path,
            ref: target.experimental_ref,
          }
        : null;
    }

    // A plugin page can open a project checkout preview without project context.
    const projects = target.projectId
      ? [await bb.sdk.projects.get({ projectId: target.projectId, signal })]
      : await bb.sdk.projects.list({ signal });
    const sources = projects
      .flatMap((project) => project.sources)
      .filter((source) => source.hostId === target.hostId)
      .sort((a, b) => b.path.length - a.path.length);
    for (const source of sources) {
      const path = experimental_getRelativeHostPath({
        rootPath: source.path,
        candidatePath: target.path,
      });
      if (path) return { hostId: source.hostId, root: source.path, path };
    }
    return null;
  }

  async function resolve(
    { target, location, contentSha256 }: FileInput,
    signal?: AbortSignal,
  ) {
    const workspace = await resolveTarget(target, signal);
    if (!workspace) return empty;
    const { hostId, ...file } = workspace;
    return host.call(
      "resolve",
      { ...file, location, contentSha256 },
      { hostId, timeoutMs: 15_000, signal },
    );
  }

  bb.rpc.register(fileLinkRpc, {
    resolve: (input, context) => resolve(input, context.experimental_signal),
  });
  bb.cli.register(
    defineCli({
      name: "file-link",
      summary: "Resolve GitHub links for a workspace file",
      commands: {
        resolve: cliCommand({
          summary:
            "Print permalink and branch URLs for a workspace-relative file",
          positionals: [
            {
              name: "environment",
              description: "BB environment ID",
              required: true,
            },
            {
              name: "path",
              description: "Workspace-relative file path",
              required: true,
            },
          ],
          options: {
            ref: {
              type: "string",
              description: "HEAD or a commit SHA for a snapshot",
            },
            line: {
              type: "string",
              description: "One-based line number or range, such as 20-24",
            },
          },
          async run({ positionals, options }) {
            const range = options.line?.match(/^(\d+)(?:-(\d+))?$/);
            if (options.line !== undefined && !range)
              throw new PluginCliError(
                "Use a line number or range, such as 20-24.",
              );
            const input = fileInput.safeParse({
              target: {
                kind: "workspace",
                environmentId: positionals.environment,
                path: positionals.path,
                experimental_ref: options.ref,
              },
              location: range
                ? {
                    kind: "range",
                    startLine: Number(range[1]),
                    endLine: Number(range[2] ?? range[1]),
                  }
                : null,
            });
            if (!input.success)
              throw new PluginCliError("Invalid path, ref, or line range.");
            return {
              exitCode: 0,
              stdout: `${JSON.stringify(await resolve(input.data), null, 2)}\n`,
            };
          },
        }),
      },
    }),
  );
}
