/**
 * What a host app (bom-herdr, or an adapter over anything else) implements to
 * sit behind herdgate. The SDK owns the connection, reconnection and envelope;
 * the adapter owns everything the cloud cannot see.
 */
import type { DeviceView } from "../protocol/agent.ts";

export interface PairAsk {
  requestId: string;
  device: { name: string };
  scope: "read" | "act";
}

export interface AgentAdapter {
  /** Reported in `hello`; the account's devices see `name`. */
  info(): { name: string; version: string; capabilities?: string[] };
  /** An opaque payload from one paired device (its scope is in `devices`). */
  onFrame(device: string, payload: unknown): void;
  /** The paired-device list changed (pair, revoke, connect state). */
  onDevices(devices: DeviceView[]): void;
  /** A device asked for `act`; returning true pairs it. May prompt a human. */
  onPairAsk(ask: PairAsk): boolean | Promise<boolean>;
}
