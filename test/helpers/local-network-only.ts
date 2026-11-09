import net from "node:net";
import dns from "node:dns";

const allowed = (host: string) => host === "127.0.0.1" || host === "::1" || host === "localhost";
const connect = net.Socket.prototype.connect;
const normalize = (net as unknown as { _normalizeArgs: (args: unknown[]) => [{ path?: string; host?: string }] })._normalizeArgs;
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
  const options = normalize(args)[0];
  if (options.path === undefined && !allowed(options.host ?? "localhost")) {
    throw new Error(`test forbids outbound network: ${options.host}`);
  }
  return Reflect.apply(connect, this, args) as net.Socket;
} as typeof connect;
const lookup = dns.lookup;
dns.lookup = function (this: unknown, host: string, ...args: unknown[]) {
  if (!allowed(host)) throw new Error(`test forbids outbound DNS: ${host}`);
  return Reflect.apply(lookup, this, [host, ...args]);
} as typeof lookup;
