#!/usr/bin/env node
// Fill Freeport's R2 cache for an image, using the same ECR login as docker:
//
//   aws ecr get-login-password | node scripts/warm.mjs <freeport-host>/<repo>:<tag> \
//     [--platform linux/amd64] [--wait] [--timeout <seconds>]
//
// --platform warms one platform of a multi-platform image (default: all).
// --wait blocks until every blob is cached (exit 1 on timeout, default 1800 s).

import { warm } from "../src/warm.js";

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const image = args.find((a, i) => !a.startsWith("--") && !["--timeout", "--platform"].includes(args[i - 1]));
const waitFlag = args.includes("--wait");
const platform = option("--platform");
const timeoutMs = Number(option("--timeout") ?? 1800) * 1000;

if (!image) {
  console.error("usage: aws ecr get-login-password | warm.mjs <freeport-host>/<repo>:<tag> [--platform os/arch] [--wait] [--timeout <s>]");
  process.exit(2);
}

let password = process.env.ECR_PASSWORD ?? "";
if (!password) {
  for await (const chunk of process.stdin) {
    password += chunk;
  }
}
password = password.trim();
if (!password) {
  console.error("no ECR password on stdin (or ECR_PASSWORD)");
  process.exit(2);
}

try {
  const result = await warm({ image, password, fetch, platform, wait: waitFlag, timeoutMs, log: console.log });
  if (waitFlag && result.pending > 0) {
    console.error(`timed out with ${result.pending} blobs uncached`);
    process.exit(1);
  }
} catch (err) {
  console.error(err.cause ? `${err.message}: ${err.cause.message ?? err.cause}` : err.message);
  process.exit(1);
}
