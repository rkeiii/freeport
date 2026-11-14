// End to end: warm -> registry Worker -> fake ECR/S3 -> queue -> copier -> R2 -> hit.

import { createExecutionContext, env, reset, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { _resetMemo } from "../src/auth.js";
import { handleQueue } from "../src/copier.js";
import { handleRequest } from "../src/registry.js";
import { parseImage, platformMatches, warm } from "../src/warm.js";
import { digestOf, fakeAws, fakeMessage, fakeQueue, patterned } from "./fakes.js";

afterEach(async () => {
  _resetMemo();
  await reset();
});

async function setup() {
  const layers = [patterned(3000, 1), patterned(5000, 2)];
  const config = patterned(200, 3);
  const [l0, l1, c] = await Promise.all([...layers, config].map((b) => digestOf(b)));
  const image = JSON.stringify({ config: { digest: c }, layers: [{ digest: l0 }, { digest: l1 }] });
  const arm = await digestOf(patterned(100, 4));
  const index = JSON.stringify({
    manifests: [
      { digest: "sha256:" + "b".repeat(64), platform: { os: "linux", architecture: "amd64" } },
      { digest: "sha256:" + "e".repeat(64), platform: { os: "linux", architecture: "arm64" } },
    ],
  });
  const armImage = JSON.stringify({ config: { digest: arm }, layers: [] });
  const aws = fakeAws({
    repos: {
      "ml/worker": {
        manifests: {
          v2: { body: index, type: "application/vnd.oci.image.index.v1+json", digest: "sha256:" + "c".repeat(64) },
          ["sha256:" + "e".repeat(64)]: { body: armImage, type: "application/vnd.oci.image.manifest.v1+json", digest: "sha256:" + "e".repeat(64) },
          ["sha256:" + "b".repeat(64)]: { body: image, type: "application/vnd.oci.image.manifest.v1+json", digest: "sha256:" + "b".repeat(64) },
        },
        blobs: { [l0]: layers[0], [l1]: layers[1], [c]: config, [arm]: patterned(100, 4) },
      },
    },
  });
  const queue = fakeQueue();
  const workerEnv = { ...env, COPY: queue };
  // warm's fetch goes to the Worker, the Worker's to the fake AWS.
  const viaWorker = async (input, init) => {
    const ctx = createExecutionContext();
    const r = await handleRequest(new Request(input, init), workerEnv, ctx, aws);
    await waitOnExecutionContext(ctx);
    return r;
  };
  const drain = async () => {
    const messages = queue.sent.splice(0).map((b) => fakeMessage(b));
    await handleQueue({ messages }, env, aws);
  };
  return { aws, queue, viaWorker, drain, digests: [l0, l1, c], all: [l0, l1, c, arm] };
}

describe("parseImage", () => {
  it.each([
    ["h.io/a/b:t", { base: "https://h.io", host: "h.io", repo: "a/b", ref: "t" }],
    ["h.io/a/b", { base: "https://h.io", host: "h.io", repo: "a/b", ref: "latest" }],
    ["h.io:8443/a/b", { base: "https://h.io:8443", host: "h.io:8443", repo: "a/b", ref: "latest" }],
    ["h.io/a@sha256:" + "d".repeat(64), { base: "https://h.io", host: "h.io", repo: "a", ref: "sha256:" + "d".repeat(64) }],
    ["http://localhost:8787/a:t", { base: "http://localhost:8787", host: "localhost:8787", repo: "a", ref: "t" }],
  ])("%s", (image, want) => expect(parseImage(image)).toEqual(want));

  it("needs a host", () => expect(() => parseImage("ubuntu")).toThrow());
});

describe("platformMatches", () => {
  const amd = { platform: { os: "linux", architecture: "amd64" } };
  const armv8 = { platform: { os: "linux", architecture: "arm64", variant: "v8" } };
  const attestation = { platform: { os: "unknown", architecture: "unknown" } };
  it("matches everything with no filter", () => expect(platformMatches(undefined, armv8)).toBe(true));
  it("matches os/arch", () => expect(platformMatches("linux/amd64", amd)).toBe(true));
  it("rejects other arches", () => expect(platformMatches("linux/amd64", armv8)).toBe(false));
  it("matches variants", () => expect(platformMatches("linux/arm64/v8", armv8)).toBe(true));
  it("skips attestations", () => expect(platformMatches("linux/amd64", attestation)).toBe(false));
  it("keeps children with no platform", () => expect(platformMatches("linux/amd64", {})).toBe(true));
});

describe("warm", () => {
  it("queues every blob of every platform, downloading nothing", async () => {
    const { aws, queue, viaWorker, all } = await setup();
    const r = await warm({ image: "freeport.test/ml/worker:v2", password: "good-token", fetch: viaWorker });
    expect(r).toEqual({ blobs: 4, hits: 0, queued: 4, pending: 4 });
    expect(queue.sent.map((m) => m.digest).sort()).toEqual([...all].sort());
    expect(aws.calls.some((c) => c.url.includes("s3."))).toBe(false);
  });

  it("--platform warms only that platform", async () => {
    const { queue, viaWorker, digests } = await setup();
    const r = await warm({
      image: "freeport.test/ml/worker:v2",
      password: "good-token",
      fetch: viaWorker,
      platform: "linux/amd64",
    });
    expect(r.blobs).toBe(3);
    expect(queue.sent.map((m) => m.digest).sort()).toEqual([...digests].sort());
  });

  it("--wait returns once the copier has filled R2", async () => {
    const { viaWorker, drain } = await setup();
    const r = await warm({
      image: "freeport.test/ml/worker:v2",
      password: "good-token",
      fetch: viaWorker,
      platform: "linux/amd64",
      wait: true,
      sleep: drain, // the copier runs while warm waits
    });
    expect(r).toMatchObject({ blobs: 3, queued: 3, pending: 0 });
  });

  it("reports hits on a second run", async () => {
    const { viaWorker, drain } = await setup();
    await warm({ image: "freeport.test/ml/worker:v2", password: "good-token", fetch: viaWorker });
    await drain();
    const r = await warm({ image: "freeport.test/ml/worker:v2", password: "good-token", fetch: viaWorker });
    expect(r).toEqual({ blobs: 4, hits: 4, queued: 0, pending: 0 });
  });

  it("times out with blobs still pending", async () => {
    const { viaWorker } = await setup();
    const r = await warm({
      image: "freeport.test/ml/worker:v2",
      password: "good-token",
      fetch: viaWorker,
      wait: true,
      timeoutMs: 0,
    });
    expect(r.pending).toBe(4);
  });

  it("fails loudly on a bad login", async () => {
    const { viaWorker } = await setup();
    await expect(
      warm({ image: "freeport.test/ml/worker:v2", password: "nope", fetch: viaWorker }),
    ).rejects.toThrow(/HTTP 401/);
  });
});
