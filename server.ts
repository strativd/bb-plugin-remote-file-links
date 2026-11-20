import {
  cliCommand,
  defineCli,
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
  async function resolve({ target, location, contentSha256 }: FileInput) {
    if (target.kind === "host") {
      return host.call(
        "resolve",
        { path: target.path, location, contentSha256 },
        { hostId: target.hostId, timeoutMs: 15_000 },
      );
    }
    const environment = await bb.sdk.environments.get({
      environmentId: target.environmentId,
    });
    if (!environment.path)
      return { permalink: null, current: null, default: null };
    return host.call(
      "resolve",
      {
        path: target.path,
        root: environment.path,
        ref: target.experimental_ref,
        location,
        contentSha256,
      },
      { hostId: environment.hostId, timeoutMs: 15_000 },
    );
  }

  bb.rpc.register(fileLinkRpc, { resolve });
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
