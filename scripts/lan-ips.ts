import { networkInterfaces } from "node:os";

/** この機械の LAN の IP(内部でない IPv4 のすべて。口が複数あれば全部。重複は 1 つ)。 */
export function lanIps(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string[] {
  const ips: string[] = [];
  for (const list of Object.values(interfaces))
    for (const a of list ?? []) {
      // Node 18.0〜18.3 は family が数値の 4 を返す
      const v4 = a.family === "IPv4" || (a.family as unknown) === 4;
      if (v4 && !a.internal && !ips.includes(a.address)) ips.push(a.address);
    }
  return ips;
}
