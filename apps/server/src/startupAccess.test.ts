import { expect, it } from "@effect/vitest";

import {
  formatHeadlessOpenAccessOutput,
  resolveHeadlessConnectionString,
} from "./startupAccess.ts";

it("resolves wildcard hosts to a concrete external interface when one is available", () => {
  const connectionString = resolveHeadlessConnectionString("0.0.0.0", 3773, {
    en0: [
      {
        address: "192.168.1.42",
        netmask: "255.255.255.0",
        family: "IPv4",
        mac: "00:00:00:00:00:00",
        internal: false,
        cidr: "192.168.1.42/24",
      },
    ],
    lo0: [
      {
        address: "127.0.0.1",
        netmask: "255.0.0.0",
        family: "IPv4",
        mac: "00:00:00:00:00:00",
        internal: true,
        cidr: "127.0.0.1/8",
      },
    ],
  });

  expect(connectionString).toBe("http://192.168.1.42:3773");
});

it("formats open-access headless output without a token and with a warning", () => {
  const output = formatHeadlessOpenAccessOutput("http://192.168.1.42:3773");

  expect(output).toContain("Connection string: http://192.168.1.42:3773");
  expect(output).toContain("Authentication is DISABLED");
  expect(output).not.toContain("Token:");
  expect(output).not.toContain("Pairing URL:");
});
