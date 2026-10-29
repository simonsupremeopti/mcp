import { describe, expect, it } from "vitest";

import { isLoopbackHost, isPrivateHost } from "@/relay/hosts";

describe("isLoopbackHost", () => {
  it("knows the loopback addresses, and treats no host as loopback", () => {
    for (const host of [
      undefined,
      "127.0.0.1",
      "localhost",
      "LOCALHOST",
      "::1",
      "[::1]",
    ]) {
      expect(isLoopbackHost(host), String(host)).toBe(true);
    }
    for (const host of ["192.168.1.5", "10.0.0.1", "example.com", "0.0.0.0"]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });
});

describe("isPrivateHost", () => {
  it("allows private networks", () => {
    for (const host of [
      "127.0.0.1",
      "localhost",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.1.5",
      // Tailscale hands out carrier-grade NAT addresses
      "100.101.102.103",
      "169.254.1.1",
      "fd00::1",
      "fe80::1",
    ]) {
      expect(isPrivateHost(host), host).toBe(true);
    }
  });

  it("refuses anything routable from the internet, and every interface at once", () => {
    for (const host of [
      "0.0.0.0",
      "8.8.8.8",
      "172.32.0.1",
      "172.15.0.1",
      "100.63.0.1",
      "100.128.0.1",
      "2606:4700::1111",
      "example.com",
    ]) {
      expect(isPrivateHost(host), host).toBe(false);
    }
  });
});
