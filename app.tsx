import type { ComponentType } from "react";
import { toast } from "sonner";
import {
  definePluginApp,
  experimental_copyToClipboard,
  useBbContext,
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

const hostPreviewInput = fileInput.extend({
  target: z.object({
    kind: z.literal("host"),
    hostId: z.string(),
    path: z.string(),
  }),
});

function panelInput(input: unknown, projectId: string | null): FileInput | null {
  const parsed = fileInput.safeParse(input);
  if (parsed.success) return parsed.data;
  const preview = hostPreviewInput.safeParse(input);
  if (!preview.success) return null;
  const scoped = fileInput.safeParse({
    ...preview.data,
    target: {
      ...preview.data.target,
      kind: "project",
      projectId: projectId ?? undefined,
    },
  });
  return scoped.success ? scoped.data : null;
}

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
  const { projectId } = useBbContext();
  const input = panelInput({ target, location, contentSha256 }, projectId);
  if (!input) return null;
  return choices.map(([kind, label]) => (
    <Item
      key={kind}
      label={label}
      onSelect={() => {
        void rpc.call("resolve", input)
          .then((links) => copyLink(links, kind))
          .catch(() => toast.error("Could not resolve the GitHub link"));
      }}
    />
  ));
}

function activeFile({
  projectId,
  experimental_panel,
  experimental_getActiveFile,
}: PluginCommandContext & {
  experimental_getActiveFile?: () => unknown;
}): FileInput | null {
  const viewerFile = experimental_getActiveFile?.();
  if (viewerFile) return panelInput(viewerFile, projectId);
  const panel = experimental_panel.getTabs();
  const tab = panel.open
    ? panel.tabs.find((entry) => entry.key === panel.selectedKey)
    : undefined;
  if (!tab) return null;
  if ("experimental_fileAction" in tab.detail) {
    return panelInput(tab.detail.experimental_fileAction, projectId);
  }
  if (
    tab.detail.kind === "plugin" &&
    tab.detail.tab.id.startsWith("file-opener:")
  ) {
    const parsed = z
      .object({
        path: z.string(),
        source: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("workspace"), environmentId: z.string() }),
          z.object({ kind: z.literal("host"), experimental_hostId: z.string() }),
        ]),
      })
      .safeParse(tab.detail.params);
    if (!parsed.success) return null;
    const { path, source } = parsed.data;
    const target = source.kind === "workspace"
      ? { kind: "workspace", environmentId: source.environmentId, path }
      : { kind: "host", hostId: source.experimental_hostId, path };
    return panelInput({ target, location: null }, projectId);
  }
  if (tab.detail.kind !== "file" || tab.status !== null) return null;
  const match = /^(workspace|host)-file-preview:[^:]+:([^:]+)$/.exec(tab.key);
  if (!match) return null;
  let scope: string;
  try {
    scope = decodeURIComponent(match[2]);
  } catch {
    return null;
  }
  const path = tab.detail.path;
  if (match[1] === "workspace" && scope.startsWith("env_")) {
    return panelInput(
      { target: { kind: "workspace", environmentId: scope, path }, location: null },
      projectId,
    );
  }
  if (match[1] === "host" && scope.startsWith("host:")) {
    return panelInput(
      { target: { kind: "host", hostId: scope.slice(5), path }, location: null },
      projectId,
    );
  }
  return null;
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
