import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { fileLinkHostRpc } from "./contract.js";
import { resolveLinks } from "./links.js";

export default experimental_defineHostEntry({
  contract: fileLinkHostRpc,
  handlers: { resolve: (input, { signal }) => resolveLinks(input, signal) },
});
