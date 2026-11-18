/**
 * The host-agent leg: one outbound WebSocket per host via `GET /v1/agent/ws`.
 *
 * The agent authenticates with a long-lived **room token** (minted by the
 * device-flow in `provision`, see the agent SDK). One live agent connection per
 * room: a second connection supersedes the first.
 */

import type { Scope } from "./envelope.ts";

export interface DeviceView {
  id: string;
  name: string;
  scope: Scope;
  connected: boolean;
}

// ---- agent → cloud ----

export interface AgentHello {
  t: "hello";
  roomToken: string;
  info: { name: string; version: string; capabilities?: string[] };
}
export interface AgentFrame {
  t: "frame";
  device: string;
  payload: unknown;
}
export interface AgentPresence {
  t: "presence";
  online: boolean;
  detail?: string;
}
export interface PairResponse {
  t: "pair.response";
  requestId: string;
  ok: boolean;
}
export interface AgentPing {
  t: "ping";
  n: number;
}
export type AgentToCloud = AgentHello | AgentFrame | AgentPresence | PairResponse | AgentPing;

// ---- cloud → agent ----

export interface CloudHelloAgent {
  t: "hello";
  roomId: string;
  roomName: string;
  devices: DeviceView[];
  resumed: boolean;
}
export interface CloudFrameAgent {
  t: "frame";
  device: string;
  payload: unknown;
}
export interface RoomUpdate {
  t: "room.update";
  devices: DeviceView[];
}
/** Approve-on-host: a device asked to pair with scope `act`; the host decides. */
export interface PairRequest {
  t: "pair.request";
  requestId: string;
  device: { name: string };
  scope: Scope;
}
export interface PongMsg {
  t: "pong";
  n: number;
}
export interface ErrMsg {
  t: "error";
  code: string;
  message?: string;
}
export type CloudToAgent = CloudHelloAgent | CloudFrameAgent | RoomUpdate | PairRequest | PongMsg | ErrMsg;
