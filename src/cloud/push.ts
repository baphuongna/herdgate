import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIPv4 } from "node:net";
import { vapidHeader, type VapidKeys } from "./vapid.ts";

const providers = new Set(["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"]);

export function pushEndpoint(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash &&
      providers.has(url.hostname) ? url : null;
  } catch { return null; }
}

// Deliberately use IPv4 only for push: reject private, link-local, reserved and
// other non-global space. Connect to that exact checked address, not a second DNS lookup.
const nonPublic = new BlockList();
for (const [address, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) nonPublic.addSubnet(address, bits);

export function publicPushAddress(address: string): boolean {
  return isIPv4(address) && !nonPublic.check(address, "ipv4");
}

export async function sendWake(endpoint: URL, keys: VapidKeys, sub: string): Promise<void> {
  const { hostname, pathname, search, href } = endpoint;
  // Keep the DNS lookup part of the in-flight quota even if it is slow.
  const signal = AbortSignal.timeout(5000);
  const { address } = await lookup(hostname, { family: 4 });
  signal.throwIfAborted();
  if (!publicPushAddress(address)) throw new Error("push endpoint resolved to a non-public address");
  await new Promise<void>((resolve, reject) => {
    const req = request({
      hostname: address, servername: hostname, path: pathname + search,
      method: "POST", agent: false, rejectUnauthorized: true, signal,
      headers: {
        Host: hostname, TTL: "60", Urgency: "normal", "content-length": "0",
        Authorization: vapidHeader(href, keys, sub),
      },
    }, (res) => {
      // No response body or redirect is needed for a wake notification.
      res.destroy();
      if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) resolve();
      else reject(new Error("push provider rejected wake"));
    });
    req.once("error", reject);
    req.end();
  });
}
