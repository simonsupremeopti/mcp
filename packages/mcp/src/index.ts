#!/usr/bin/env node
import { program } from "commander";

import type { Capability } from "@/contracts";
import { runThin } from "@/thin/server";
import { VERSION } from "@/version";

const CAPABILITIES: Capability[] = ["cdp"];

program
  .name("mcp-server-browsermcp")
  .version(VERSION)
  .option(
    "--caps <list>",
    `optional capabilities, comma-separated: ${CAPABILITIES.join(", ")}`,
  )
  .option(
    "--port <port>",
    "use the daemon on this port only (set the same port in the extension)",
  )
  .option(
    "--host <host>",
    "run the daemon on this address instead of 127.0.0.1, so browsers on other machines can reach it (a private network only)",
  )
  .action(async (options: { caps?: string; port?: string; host?: string }) => {
    const requested = (options.caps ?? "")
      .split(",")
      .map((cap) => cap.trim())
      .filter(Boolean);
    const unknown = requested.filter(
      (cap) => !CAPABILITIES.includes(cap as Capability),
    );
    if (unknown.length > 0) {
      console.error(
        `Unknown capabilities: ${unknown.join(", ")}. Available: ${CAPABILITIES.join(", ")}`,
      );
      process.exit(1);
    }
    const port = options.port ? Number.parseInt(options.port, 10) : undefined;
    if (port !== undefined && !(port > 0 && port < 65536)) {
      console.error(`Invalid port: ${options.port}`);
      process.exit(1);
    }
    await runThin({
      capabilities: requested as Capability[],
      port,
      host: options.host,
    });
  });

program.parse(process.argv);
