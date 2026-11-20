// The standalone host and self-contained plugin enforce the same SSH policy.
import { createSshBridge as create, type SshBridgeOptions } from "../../plugin/server/ssh.mjs";
export { READ_METHODS, translateBootstrap, type SshBridge } from "../../plugin/server/ssh.mjs";

export function createSshBridge(options: Omit<SshBridgeOptions, "resolve"> & { resolveHc?: SshBridgeOptions["resolve"] }) {
  return create({ ...options, resolve: options.resolveHc });
}
