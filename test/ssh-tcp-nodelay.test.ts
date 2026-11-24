/**
 * The raw TCP leg must not sit behind Nagle.
 *
 * ssh2 writes every SSH packet as its own small `write()`. With Nagle on, the
 * second packet of a burst waits for the client's ACK of the first — and a Linux
 * client delays that ACK by ~40 ms. Measured on loopback against the real sshd
 * (2026-11-24, /tmp/hg-conn/timing.py): the KEX phase took 59 ms over raw TCP
 * and 10 ms over the WS leg, which is a Duplex with no TCP in the way. The same
 * stall showed up again in the exec phase (98 ms vs 65 ms).
 *
 * The WS leg cannot regress (nothing to set); this pins the TCP leg.
 */
import assert from "node:assert/strict";
import test from "node:test";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { startCloud } from "../src/cloud/gateway.ts";

test("ssh tcp leg: accepted sockets get TCP_NODELAY", async () => {
  const dir = mkdtempSync(join(tmpdir(), "herdgate-nodelay-"));
  const real = net.Socket.prototype.setNoDelay;
  const noDelayOn: number[] = []; // remotePort of every socket switched to nodelay
  net.Socket.prototype.setNoDelay = function (this: net.Socket, noDelay?: boolean) {
    if (noDelay) noDelayOn.push(this.remotePort ?? -1);
    return real.call(this, noDelay);
  };
  const cloud = await startCloud({
    accounts: [{ id: "a1", name: "owner", token: "nodelay-account" }],
    log: () => {},
    ssh: { port: 0, keyPath: join(dir, "hostkey.json") },
  });
  const sock = net.connect(cloud.ssh?.port ?? 0, "127.0.0.1");
  try {
    await once(sock, "connect");
    const [banner] = (await once(sock, "data")) as [Buffer];
    assert.match(banner.toString(), /^SSH-2\.0-/, "the sshd answered over TCP");
    assert.ok(
      noDelayOn.includes(sock.localPort ?? -1),
      `the socket the sshd accepted from this client (port ${sock.localPort}) was set to nodelay; saw ports ${JSON.stringify(noDelayOn)}`,
    );
  } finally {
    net.Socket.prototype.setNoDelay = real;
    sock.destroy();
    await cloud.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
