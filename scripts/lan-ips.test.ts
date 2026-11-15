import type { NetworkInterfaceInfo } from "node:os";
import { describe, expect, it } from "vitest";
import { lanIps } from "./lan-ips.js";

const nic = (address: string, family: "IPv4" | "IPv6", internal: boolean): NetworkInterfaceInfo =>
  family === "IPv4"
    ? { address, family, internal, netmask: "", mac: "", cidr: null }
    : { address, family, internal, netmask: "", mac: "", cidr: null, scopeid: 0 };

describe("lanIps", () => {
  it("内部でない IPv4 だけを、口の数だけ返す(loopback・IPv6 は入れない。重複は 1 つ)", () => {
    expect(
      lanIps({
        lo0: [nic("127.0.0.1", "IPv4", true), nic("::1", "IPv6", true)],
        en0: [nic("192.168.1.18", "IPv4", false), nic("fe80::1", "IPv6", false)],
        en1: [nic("192.168.1.22", "IPv4", false), nic("192.168.1.18", "IPv4", false)],
      }),
    ).toEqual(["192.168.1.18", "192.168.1.22"]);
  });

  it("LAN の口が無ければ空", () => {
    expect(lanIps({ lo0: [nic("127.0.0.1", "IPv4", true)] })).toEqual([]);
  });
});
