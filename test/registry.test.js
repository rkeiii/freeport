import { createExecutionContext, env, reset, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetMemo } from "../src/auth.js";
import { blobKey, handleRequest, pendingKey } from "../src/registry.js";
import { digestOf, ECR, fakeAws, fakeQueue, GOOD, OTHER, patterned, S3 } from "./fakes.js";

const HOST = "https://freeport.test";
const layer = patterned(4096);
let digest;
let aws;
let queue;
let testEnv;

afterEach(() => reset());

beforeEach(async () => {
  _resetMemo();
  digest = await digestOf(layer);
  aws = fakeAws({
    repos: {
      "team/app": {
        manifests: {
          v1: { body: '{"schemaVersion":2}', type: "application/vnd.oci.image.manifest.v1+json", digest: "sha256:" + "a".repeat(64) },
        },
        blobs: { [digest]: layer },
      },
      other: { blobs: {} },
    },
  });
  queue = fakeQueue();
  testEnv = { ...env, COPY: queue };
});

async function call(path, { method = "GET", auth = GOOD, headers = {} } = {}) {
  const ctx = createExecutionContext();
  const h = new Headers(headers);
  if (auth) {
    h.set("Authorization", auth);
  }
  const response = await handleRequest(new Request(HOST + path, { method, headers: h }), testEnv, ctx, aws);
  await waitOnExecutionContext(ctx);
  return response;
}

async function cache(bytes, d) {
  await env.BLOBS.put(blobKey(d), bytes);
}

describe("login and pass-through", () => {
  it("relays ECR's Basic challenge with Freeport as the realm", async () => {
    const r = await call("/v2/", { auth: null });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBe(`Basic realm="${HOST}/",service="ecr.amazonaws.com"`);
  });

  it("accepts an ECR login token", async () => {
    const r = await call("/v2/");
    expect(r.status).toBe(200);
    expect(aws.ecrCalls()[0].headers.authorization).toBe(GOOD);
  });

  it("refuses writes", async () => {
    const r = await call("/v2/team/app/blobs/uploads/", { method: "POST" });
    expect(r.status).toBe(405);
    expect((await r.json()).errors[0].code).toBe("UNSUPPORTED");
    expect(aws.calls).toHaveLength(0);
  });

  it("404s non-registry paths without calling ECR", async () => {
    expect((await call("/favicon.ico")).status).toBe(404);
    expect(aws.calls).toHaveLength(0);
  });

  it("proxies manifests with Accept and the digest header", async () => {
    const accept = "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json";
    const r = await call("/v2/team/app/manifests/v1", { headers: { Accept: accept } });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('{"schemaVersion":2}');
    expect(r.headers.get("docker-content-digest")).toBe("sha256:" + "a".repeat(64));
    expect(aws.ecrCalls()[0].headers.accept).toBe(accept);
  });

  it("HEADs manifests with no body", async () => {
    const r = await call("/v2/team/app/manifests/v1", { method: "HEAD" });
    expect(r.status).toBe(200);
    expect(r.body).toBeNull();
  });

  it("proxies tags/list", async () => {
    const r = await call("/v2/team/app/tags/list");
    expect(await r.json()).toEqual({ name: "team/app", tags: ["v1"] });
  });

  it("rejects non-sha256 digests", async () => {
    expect((await call("/v2/team/app/blobs/md5:abc")).status).toBe(400);
  });
});

describe("blob miss", () => {
  it("hands the client ECR's presigned S3 redirect and queues a copy", async () => {
    const r = await call(`/v2/team/app/blobs/${digest}`);
    expect(r.status).toBe(307);
    const location = r.headers.get("location");
    expect(location.startsWith(S3)).toBe(true);
    expect(r.headers.get("x-freeport-cache")).toBe("miss");
    expect(queue.sent).toEqual([{ digest, url: location }]);
    expect(await env.BLOBS.head(pendingKey(digest))).not.toBeNull();
    expect(aws.calls.some((c) => c.url.startsWith(S3))).toBe(false); // bytes never via Worker
  });

  it("queues one copy while one is pending", async () => {
    await call(`/v2/team/app/blobs/${digest}`);
    await call(`/v2/team/app/blobs/${digest}`);
    expect(queue.sent).toHaveLength(1);
  });

  it("leaves no marker when the queue send fails, so the next miss retries", async () => {
    testEnv.COPY = { send: async () => { throw new Error("queue down"); } };
    const r = await call(`/v2/team/app/blobs/${digest}`);
    expect(r.status).toBe(307); // the client still gets its layer
    expect(await env.BLOBS.head(pendingKey(digest))).toBeNull();
  });

  it("keeps a tiny blob ECR sends inline (no redirect, nothing to queue)", async () => {
    const tiny = patterned(32, 7);
    const t = await digestOf(tiny);
    aws = fakeAws({ repos: { "team/app": { blobs: { [t]: tiny } } }, inline: [t] });
    const r = await call(`/v2/team/app/blobs/${t}`);
    expect(r.status).toBe(200);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(tiny);
    expect(queue.sent).toHaveLength(0);
    const stored = await env.BLOBS.get(blobKey(t));
    expect(new Uint8Array(await stored.arrayBuffer())).toEqual(tiny);
    const hit = await call(`/v2/team/app/blobs/${t}`);
    expect(hit.headers.get("x-freeport-cache")).toBe("hit");
  });

  it("won't store an inline blob whose bytes don't match its digest", async () => {
    const tiny = patterned(32, 7);
    const wrong = "sha256:" + "f".repeat(64);
    aws = fakeAws({ repos: { "team/app": { blobs: { [wrong]: tiny } } }, inline: [wrong] });
    const r = await call(`/v2/team/app/blobs/${wrong}`);
    expect(r.status).toBe(200); // client still gets what ECR sent; Docker verifies digests
    expect(await env.BLOBS.head(blobKey(wrong))).toBeNull();
  });

  it("does not queue on HEAD", async () => {
    await call(`/v2/team/app/blobs/${digest}`, { method: "HEAD" });
    expect(queue.sent).toHaveLength(0);
  });

  it("passes ECR's denial through and queues nothing", async () => {
    const r = await call(`/v2/team/app/blobs/${digest}`, { auth: "Basic " + btoa("AWS:bad") });
    expect(r.status).toBe(401);
    expect(queue.sent).toHaveLength(0);
  });
});

describe("blob hit", () => {
  beforeEach(() => cache(layer, digest));

  it("serves bytes from R2 after one ECR check", async () => {
    const r = await call(`/v2/team/app/blobs/${digest}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("x-freeport-cache")).toBe("hit");
    expect(r.headers.get("docker-content-digest")).toBe(digest);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(layer);
    const checks = aws.ecrCalls();
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ method: "HEAD", url: `${ECR}/v2/team/app/blobs/${digest}` });
    expect(aws.calls.some((c) => c.url.startsWith(S3))).toBe(false);
  });

  it("remembers the verdict: the second hit doesn't ask ECR", async () => {
    await call(`/v2/team/app/blobs/${digest}`);
    await call(`/v2/team/app/blobs/${digest}`);
    expect(aws.ecrCalls()).toHaveLength(1);
  });

  it("remembers verdicts across isolates via the Cache API", async () => {
    await call(`/v2/team/app/blobs/${digest}`);
    _resetMemo();
    await call(`/v2/team/app/blobs/${digest}`);
    expect(aws.ecrCalls()).toHaveLength(1);
  });

  it("refuses a bad credential without sending bytes", async () => {
    const r = await call(`/v2/team/app/blobs/${digest}`, { auth: "Basic " + btoa("AWS:bad") });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain(HOST);
    expect(r.headers.get("x-freeport-cache")).toBeNull();
  });

  it("challenges a client with no credential", async () => {
    const r = await call(`/v2/team/app/blobs/${digest}`, { auth: null });
    expect(r.status).toBe(401);
  });

  it("refuses a credential that can't read this repo", async () => {
    const r = await call(`/v2/team/app/blobs/${digest}`, { auth: OTHER });
    expect(r.status).toBe(403);
  });

  it("won't leak a blob through a repo that doesn't contain it", async () => {
    // OTHER can read repo "other", and the blob is cached, but it isn't in "other".
    const r = await call(`/v2/other/blobs/${digest}`, { auth: OTHER });
    expect(r.status).toBe(404);
  });

  it("does not reuse one credential's verdict for another", async () => {
    await call(`/v2/team/app/blobs/${digest}`);
    const r = await call(`/v2/team/app/blobs/${digest}`, { auth: OTHER });
    expect(r.status).toBe(403);
  });

  it("answers HEAD with the size", async () => {
    const r = await call(`/v2/team/app/blobs/${digest}`, { method: "HEAD" });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-length")).toBe(String(layer.byteLength));
  });

  it("serves byte ranges (Docker resumes with them)", async () => {
    const r = await call(`/v2/team/app/blobs/${digest}`, { headers: { Range: "bytes=100-199" } });
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toBe(`bytes 100-199/${layer.byteLength}`);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(layer.slice(100, 200));
  });

  it("serves open-ended ranges", async () => {
    const r = await call(`/v2/team/app/blobs/${digest}`, { headers: { Range: "bytes=4000-" } });
    expect(r.status).toBe(206);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(layer.slice(4000));
  });

  it("416s an unsatisfiable range", async () => {
    const r = await call(`/v2/team/app/blobs/${digest}`, { headers: { Range: "bytes=999999-" } });
    expect(r.status).toBe(416);
  });

  it("works for repos with slashes", async () => {
    const r = await call(`/v2/team/app/blobs/${digest}`);
    expect(r.status).toBe(200);
  });
});
