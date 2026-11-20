import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const id = z.string().min(1).max(128);
export const filePath = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[^\u0000\r\n]+$/);
const ref = z.string().regex(/^(HEAD|[a-f0-9]{4,64})$/i);
const contentSha256 = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .nullable()
  .optional();
const line = z.number().int().min(1).max(2_147_483_647);

const location = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("line"), line, column: line.nullable() }),
    z.object({ kind: z.literal("range"), startLine: line, endLine: line }),
  ])
  .refine(
    (value) => value.kind !== "range" || value.startLine <= value.endLine,
  );

export const fileInput = z.object({
  target: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("workspace"),
      environmentId: id,
      path: filePath,
      experimental_ref: ref.optional(),
    }),
    z.object({ kind: z.literal("host"), hostId: id, path: filePath }),
  ]),
  location: location.nullable(),
  contentSha256,
});

const link = z.object({
  url: z.url({ protocol: /^https$/, hostname: /^github\.com$/ }),
  branch: z.string(),
  omittedLocation: z.boolean(),
});
const links = z.object({
  permalink: link.nullable(),
  current: link.nullable(),
  default: link.nullable(),
});

export const fileLinkRpc = defineRpcContract({
  resolve: { input: fileInput, output: links },
});

export const fileLinkHostRpc = defineRpcContract({
  resolve: {
    input: z.object({
      path: filePath,
      root: filePath.optional(),
      ref: ref.optional(),
      location: location.nullable(),
      contentSha256,
    }),
    output: links,
    experimental_retryable: true,
  },
});

export type FileInput = z.infer<typeof fileInput>;
