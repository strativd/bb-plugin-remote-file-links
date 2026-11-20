import { useState, useEffect, type ComponentType } from "react";
import { toast } from "sonner";
import {
  definePluginApp,
  experimental_copyToClipboard,
  useRpc,
  type PluginCommandContext,
} from "@get-bb/plugin-sdk/app";
import { fileInput, fileLinkRpc, type FileInput } from "./contract.js";
import { z } from "zod";

type Links = z.infer<typeof fileLinkRpc.resolve.output>;
type LinkKind = keyof Links;
type MenuProps = {
  target: unknown;
  location: unknown;
  contentSha256?: string | null;
  Item: ComponentType<{ label: string; disabled?: boolean; onSelect(): void }>;
};

const choices = [
  ["permalink", "Copy GitHub permalink"],
  ["current", "Copy GitHub link on current branch"],
  ["default", "Copy GitHub link on default branch"],
] as const;

async function copyLink(links: Links, kind: LinkKind) {
  const link = links[kind];
  if (!link) {
    toast.info(
      kind === "permalink"
        ? "This file version has no known GitHub permalink"
        : "No GitHub link for this branch",
    );
    return;
  }
  if (!(await experimental_copyToClipboard({ text: link.url }))) {
    toast.error("Could not copy the GitHub link");
    return;
  }
  toast.success(
    link.omittedLocation
      ? "GitHub link copied without line numbers. The file differs on that branch."
      : "GitHub link copied",
  );
}

function FileMenu({ target, location, contentSha256, Item }: MenuProps) {
  const rpc = useRpc<typeof fileLinkRpc>();
  const input = JSON.stringify({ target, location, contentSha256 });
  const [result, setResult] = useState<{
    input: string;
    links: Links | null;
  } | null>(null);
  useEffect(() => {
    const parsed = fileInput.safeParse(JSON.parse(input));
    if (!parsed.success) return;
    let active = true;
    void rpc.call("resolve", parsed.data).then(
      (links) => {
        if (active) setResult({ input, links });
      },
      () => {
        if (active) setResult({ input, links: null });
      },
    );
    return () => {
      active = false;
    };
  }, [input, rpc]);

  const links = result?.input === input ? result.links : null;
  return links
    ? choices.map(([kind, label]) => {
        const link = links[kind];
        return link ? (
          <Item
            key={kind}
            label={kind === "permalink" ? label : `${label} (${link.branch})`}
            onSelect={() => {
              void copyLink(links, kind);
            }}
          />
        ) : null;
      })
    : null;
}

function activeFile({
  experimental_panel,
  experimental_getActiveFile,
}: PluginCommandContext & {
  experimental_getActiveFile?: () => unknown;
}): FileInput | null {
  const viewerFile = experimental_getActiveFile?.();
  if (viewerFile) {
    const parsed = fileInput.safeParse(viewerFile);
    return parsed.success ? parsed.data : null;
  }
  const panel = experimental_panel.getTabs();
  const tab = panel.open
    ? panel.tabs.find((entry) => entry.key === panel.selectedKey)
    : undefined;
  if (!tab) return null;
  if ("experimental_fileAction" in tab.detail) {
    const parsed = fileInput.safeParse(tab.detail.experimental_fileAction);
    return parsed.success ? parsed.data : null;
  }
  if (
    tab.detail.kind === "plugin" &&
    tab.detail.tab.id.startsWith("file-opener:")
  ) {
    const parsed = z
      .object({
        path: z.string(),
        source: z.object({
          kind: z.string(),
          environmentId: z.string().nullable(),
          experimental_hostId: z.string().optional(),
        }),
      })
      .safeParse(tab.detail.params);
    if (!parsed.success) return null;
    const { path, source } = parsed.data;
    if (source.kind === "workspace" && source.environmentId) {
      return {
        target: {
          kind: "workspace",
          environmentId: source.environmentId,
          path,
        },
        location: null,
      };
    }
    if (source.kind === "host" && source.experimental_hostId) {
      return {
        target: { kind: "host", hostId: source.experimental_hostId, path },
        location: null,
      };
    }
    return null;
  }
  if (tab.detail.kind !== "file") return null;
  const match = /^(workspace|host)-file-preview:[^:]+:([^:]+)$/.exec(tab.key);
  if (!match) return null;
  let scope: string;
  try {
    scope = decodeURIComponent(match[2]);
  } catch {
    return null;
  }
  const hostId =
    match[1] === "host" && scope.startsWith("host:") ? scope.slice(5) : null;
  const environmentId =
    match[1] === "workspace" && scope.startsWith("env_") ? scope : null;
  if (hostId)
    return {
      target: { kind: "host", hostId, path: tab.detail.path },
      location: null,
    };
  if (!environmentId || tab.status !== null) return null;
  return {
    target: { kind: "workspace", environmentId, path: tab.detail.path },
    location: null,
  };
}

async function resolveFromCommand(input: FileInput): Promise<Links> {
  const response = await fetch(
    "/api/v1/plugins/remote-file-links/rpc/resolve",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  const parsed = z
    .object({ ok: z.literal(true), result: fileLinkRpc.resolve.output })
    .safeParse(await response.json());
  if (!response.ok || !parsed.success)
    throw new Error("Could not resolve the GitHub link");
  return parsed.data.result;
}

export default definePluginApp((app) => {
  const slots: typeof app.slots & {
    experimental_fileAction?: (registration: {
      id: string;
      component: ComponentType<MenuProps>;
    }) => void;
  } = app.slots;
  slots.experimental_fileAction?.({
    id: "copy-github-link",
    component: FileMenu,
  });
  for (const [kind, label] of choices) {
    app.commands.register({
      id: `copy-${kind}`,
      title: `${label} for active file`,
      ...(kind === "permalink"
        ? { defaultShortcut: { key: "l", mod: true, alt: true, shift: true } }
        : {}),
      isAvailable: (context) => activeFile(context) !== null,
      async run(context) {
        const input = activeFile(context);
        if (!input) return;
        try {
          await copyLink(await resolveFromCommand(input), kind);
        } catch {
          toast.error("Could not resolve the GitHub link");
        }
      },
    });
  }
});
