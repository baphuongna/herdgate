/**
 * The device leg: browsers/PWAs (and anything else) → `GET /v1/device/ws`.
 *
 * v0 identity: the device authenticates with an **account token**; pairing
 * creates a device record inside one room, and the client re-presents its device
 * id on reconnect. Per-device secrets (so a leaked account token is not every
 * device) are on the roadmap — see DESIGN.md §6.
 */

import type { Scope } from "./envelope.ts";

// ---- device → cloud ----

export interface DeviceHello {
  t: "hello";
  accountToken: string;
  /** The device id from a previous `pair.granted`, to re-attach identity. */
  device?: string;
  name?: string;
  /** "phone" | "tablet-portrait" | ... — opaque to the cloud, passed to the host. */
  deviceClass?: string;
}
export interface DeviceFrame {
  t: "frame";
  payload: unknown;
}
/** Ask to pair this device to one room. `act` needs the host's approval. */
export interface PairBegin {
  t: "pair.begin";
  roomId: string;
  name: string;
  scope: Scope;
}
export interface DevicePing {
  t: "ping";
  n: number;
}
export type DeviceToCloud = DeviceHello | DeviceFrame | PairBegin | DevicePing;

// ---- cloud → device ----

export interface AgentView {
  roomId: string;
  name: string;
  online: boolean;
  /** This device's scope in that room; `null` when not paired there. */
  scope: Scope | null;
}
export interface DeviceSelfView {
  id: string;
  name: string;
  scope: Scope;
  roomId: string;
}
export interface CloudHelloDevice {
  t: "hello";
  session: string;
  resumed: boolean;
  device: DeviceSelfView | null;
  agents: AgentView[];
}
export interface CloudFrameDevice {
  t: "frame";
  payload: unknown;
}
export interface PairGranted {
  t: "pair.granted";
  device: DeviceSelfView;
}
export interface PairDenied {
  t:"pair.denied";
  reason: string;
}
export interface PresenceUpdate {
  t: "presence";
  roomId: string;
  online: boolean;
}
export type CloudToDevice =
  | CloudHelloDevice
  | CloudFrameDevice
  | PairGranted
  | PairDenied
  | PresenceUpdate
  | { t: "pong"; n: number }
  | { t: "error"; code: string; message?: string };
