import { env, reset } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { copyBlob, Fatal, handleQueue, LEASE_MS, progressKey, Retryable } from "../src/copier.js";
import { blobKey, pendingKey } from "../src/registry.js";
import { digestOf, fakeAws, fakeMessage, fakeQueue, GOOD, patterned, S3 } from "./fakes.js";

const MiB = 1024 * 1024;

afterEach(() => reset());

// Put a blob behind the fake ECR and return the presigned URL a miss would produce.
async function presigned(bytes, s3 = {}) {
  const digest = await digestOf(bytes);
  const aws = fakeAws({ repos: { app: { blobs: { [digest]: bytes } } }, s3 });
  const r = await aws.fetch(`https://${env.ECR_REGISTRY}/v2/app/blobs/${digest}`, {
    headers: { Authorization: GOOD },
  });
  aws.calls.length = 0;
  return { digest, url: r.headers.get("location"), aws };
}

// Digest of what R2 holds (comparing multi-MiB arrays with toEqual blows the heap).
async function stored(digest) {
  const object = await env.BLOBS.get(blobKey(digest));
  return object && digestOf(await object.arrayBuffer());
}

describe("copyBlob", () => {
  it("copies a small blob in one put", async () => {
    const bytes = patterned(1000);
    const { digest, url, aws } = await presigned(bytes);
    await env.BLOBS.put(pendingKey(digest), "");
    expect(await copyBlob({ digest, url }, env, aws)).toBe("copied");
    expect(await stored(digest)).toBe(digest);
    expect(await env.BLOBS.head(pendingKey(digest))).toBeNull();
    expect(aws.calls).toHaveLength(1);
  });

  it("copies a large blob in ranged multipart parts", async () => {
    const bytes = patterned(12 * MiB + 123);
    const { digest, url, aws } = await presigned(bytes);
    const e = { ...env, PART_SIZE: String(5 * MiB), COPY_CONCURRENCY: "2" };
    expect(await copyBlob({ digest, url }, e, aws)).toBe("copied");
    expect(await stored(digest)).toBe(digest);
    expect(aws.calls.map((c) => c.headers.range)).toEqual([
      `bytes=0-${5 * MiB - 1}`,
      `bytes=${5 * MiB}-${10 * MiB - 1}`,
      `bytes=${10 * MiB}-${15 * MiB - 1}`,
    ]);
  });

  it("refuses a small blob whose bytes don't match its digest", async () => {
    const bytes = patterned(1000);
    const { digest, url, aws } = await presigned(bytes, { corrupt: true });
    await expect(copyBlob({ digest, url }, env, aws)).rejects.toThrow(/R2 rejected/);
    expect(await stored(digest)).toBeNull();
  });

  it("refuses a multipart blob whose bytes don't match its digest", async () => {
    const bytes = patterned(11 * MiB);
    const { digest, url, aws } = await presigned(bytes, { corrupt: true });
    const e = { ...env, PART_SIZE: String(5 * MiB) };
    await expect(copyBlob({ digest, url }, e, aws)).rejects.toThrow(/downloaded as/);
    expect(await stored(digest)).toBeNull();
  });

  it("skips a blob already in R2", async () => {
    const bytes = patterned(1000);
    const { digest, url, aws } = await presigned(bytes);
    await env.BLOBS.put(blobKey(digest), bytes);
    expect(await copyBlob({ digest, url }, env, aws)).toBe("exists");
    expect(aws.calls).toHaveLength(0);
  });

  it("copies when S3 ignores Range and sends it all", async () => {
    const bytes = patterned(1000);
    const { digest, url, aws } = await presigned(bytes, { ignoreRange: true });
    expect(await copyBlob({ digest, url }, env, aws)).toBe("copied");
    expect(await stored(digest)).toBe(digest);
  });
});

describe("handleQueue", () => {
  it("acks a finished copy", async () => {
    const { digest, url, aws } = await presigned(patterned(1000));
    const m = fakeMessage({ digest, url });
    await handleQueue({ messages: [m] }, env, aws);
    expect(m.acked).toBe(true);
    expect(await stored(digest)).not.toBeNull();
  });

  it("drops an expired URL (403) and clears the pending marker", async () => {
    const { digest, url, aws } = await presigned(patterned(1000), { status: 403 });
    await env.BLOBS.put(pendingKey(digest), "");
    const m = fakeMessage({ digest, url });
    await handleQueue({ messages: [m] }, env, aws);
    expect(m.acked).toBe(true);
    expect(m.retried).toBe(false);
    expect(await env.BLOBS.head(pendingKey(digest))).toBeNull();
  });

  it("retries S3 5xx", async () => {
    const { digest, url, aws } = await presigned(patterned(1000), { status: 503 });
    const m = fakeMessage({ digest, url });
    await handleQueue({ messages: [m] }, env, aws);
    expect(m.retried).toBe(true);
    expect(m.acked).toBe(false);
  });

  it("gives up after the third attempt", async () => {
    const { digest, url, aws } = await presigned(patterned(1000), { status: 503 });
    const m = fakeMessage({ digest, url }, 3);
    await handleQueue({ messages: [m] }, env, aws);
    expect(m.acked).toBe(true);
  });
});

describe("resumable copies", () => {
  const sliced = (extra = {}) => ({
    ...env,
    COPY: fakeQueue(),
    PART_SIZE: String(5 * MiB),
    COPY_CONCURRENCY: "1",
    ...extra,
  });
  const s3Ranges = (aws) => aws.calls.filter((c) => c.url.startsWith(S3)).map((c) => c.headers.range);

  // S3 that answers `status` after `n` good responses.
  function failingAfter(aws, n, status) {
    let left = n;
    return {
      ...aws,
      fetch: async (input, init) => {
        if (String(input).startsWith(S3) && left-- <= 0) {
          return new Response("expired", { status });
        }
        return aws.fetch(input, init);
      },
    };
  }

  it("copies in slices, re-queuing itself, and never re-downloads a part", async () => {
    const bytes = patterned(23 * MiB);
    const { digest, url, aws } = await presigned(bytes);
    const e = sliced({ COPY_SLICE_BYTES: String(10 * MiB) });

    expect(await copyBlob({ digest, url }, e, aws)).toBe("continued");
    expect(e.COPY.sent).toEqual([{ digest, url }]);
    const progress = await (await env.BLOBS.get(progressKey(digest))).json();
    expect(progress.parts).toHaveLength(3);
    expect(progress.leaseUntil).toBe(0);
    expect(await env.BLOBS.head(pendingKey(digest))).not.toBeNull();

    expect(await copyBlob(e.COPY.sent[0], e, aws)).toBe("copied");
    expect(await stored(digest)).toBe(digest);
    expect(await env.BLOBS.head(progressKey(digest))).toBeNull();
    expect(await env.BLOBS.head(pendingKey(digest))).toBeNull();
    const ranges = s3Ranges(aws);
    expect(ranges).toHaveLength(5);
    expect(new Set(ranges).size).toBe(5);
  });

  // S3 that takes `ms` per response and honors AbortSignal, like real fetch.
  function slow(aws, ms) {
    return {
      ...aws,
      fetch: (input, init = {}) =>
        new Promise((resolve, reject) => {
          const t = setTimeout(() => resolve(aws.fetch(input, init)), ms);
          init.signal?.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    };
  }

  it("a timer stops it at the budget, mid-fetch, keeping finished parts", async () => {
    const { digest, url, aws } = await presigned(patterned(23 * MiB));
    const e = sliced({ COPY_BUDGET_SECONDS: "0.25" }); // 100 ms per part, 5 parts
    expect(await copyBlob({ digest, url }, e, slow(aws, 100))).toBe("continued");
    expect(e.COPY.sent).toEqual([{ digest, url }]);
    const progress = await (await env.BLOBS.get(progressKey(digest))).json();
    expect(progress.parts.length).toBeGreaterThanOrEqual(1); // finished parts kept
    expect(progress.parts.length).toBeLessThan(5); // stopped early
    expect(progress.leaseUntil).toBe(0);

    let result;
    do {
      result = await copyBlob({ digest, url }, e, slow(aws, 100));
    } while (result === "continued");
    expect(result).toBe("copied");
    expect(await stored(digest)).toBe(digest);
  });

  it("a timer that fires during the first fetch just re-queues", async () => {
    const { digest, url, aws } = await presigned(patterned(12 * MiB));
    const e = sliced({ COPY_BUDGET_SECONDS: "0.05" });
    expect(await copyBlob({ digest, url }, e, slow(aws, 200))).toBe("continued");
    expect(e.COPY.sent).toHaveLength(1);
    expect(await env.BLOBS.head(progressKey(digest))).toBeNull();
  });

  it("keeps progress when the URL expires; a fresh miss's URL finishes it", async () => {
    const bytes = patterned(23 * MiB);
    const { digest, url, aws } = await presigned(bytes);
    const e = sliced();
    await expect(copyBlob({ digest, url }, e, failingAfter(aws, 2, 403))).rejects.toThrow(Fatal);
    const progress = await (await env.BLOBS.get(progressKey(digest))).json();
    expect(progress.parts).toHaveLength(2);
    expect(progress.leaseUntil).toBe(0);

    aws.calls.length = 0;
    expect(await copyBlob({ digest, url: url + "&fresh=1" }, e, aws)).toBe("copied");
    expect(await stored(digest)).toBe(digest);
    expect(s3Ranges(aws)[0]).toBe(`bytes=${10 * MiB}-${15 * MiB - 1}`);
  });

  it("resumes after a retryable S3 error", async () => {
    const { digest, url, aws } = await presigned(patterned(16 * MiB));
    const e = sliced();
    await expect(copyBlob({ digest, url }, e, failingAfter(aws, 2, 503))).rejects.toThrow(Retryable);
    expect(await copyBlob({ digest, url }, e, aws)).toBe("copied");
    expect(await stored(digest)).toBe(digest);
  });

  it("leaves a copy alone while another invocation holds the lease", async () => {
    const { digest, url, aws } = await presigned(patterned(12 * MiB));
    await env.BLOBS.put(progressKey(digest), JSON.stringify({ leaseUntil: Date.now() + LEASE_MS }));
    expect(await copyBlob({ digest, url }, sliced(), aws)).toBe("busy");
    expect(aws.calls).toHaveLength(0);
  });

  it("stops when its record changes underneath it", async () => {
    const { digest, url, aws } = await presigned(patterned(23 * MiB));
    const e = sliced();
    // Rewrite the record after the first S3 read, i.e. while this copy holds it.
    const meddling = {
      ...aws,
      fetch: async (input, init) => {
        const r = await aws.fetch(input, init);
        if (String(input).startsWith(S3) && (await env.BLOBS.head(progressKey(digest)))) {
          await env.BLOBS.put(progressKey(digest), JSON.stringify({ leaseUntil: Date.now() + LEASE_MS }));
        }
        return r;
      },
    };
    expect(await copyBlob({ digest, url }, e, meddling)).toBe("busy");
    expect(await stored(digest)).toBeNull();
  });

  it("takes over an expired lease", async () => {
    const bytes = patterned(23 * MiB);
    const { digest, url, aws } = await presigned(bytes);
    const e = sliced({ COPY_SLICE_BYTES: String(5 * MiB) });
    await copyBlob({ digest, url }, e, aws);
    const progress = await (await env.BLOBS.get(progressKey(digest))).json();
    await env.BLOBS.put(progressKey(digest), JSON.stringify({ ...progress, leaseUntil: Date.now() - 1 }));
    let result;
    do {
      result = await copyBlob({ digest, url }, e, aws);
    } while (result === "continued");
    expect(result).toBe("copied");
    expect(await stored(digest)).toBe(digest);
  });

  it("restarts when the multipart upload is gone", async () => {
    const { digest, url, aws } = await presigned(patterned(16 * MiB));
    const e = sliced({ COPY_SLICE_BYTES: String(5 * MiB) });
    expect(await copyBlob({ digest, url }, e, aws)).toBe("continued");
    const progress = await (await env.BLOBS.get(progressKey(digest))).json();
    await env.BLOBS.resumeMultipartUpload(blobKey(digest), progress.uploadId).abort();

    await expect(copyBlob({ digest, url }, e, aws)).rejects.toThrow(/gone; restarting/);
    expect(await env.BLOBS.head(progressKey(digest))).toBeNull();
    let result;
    do {
      result = await copyBlob({ digest, url }, e, aws);
    } while (result === "continued");
    expect(await stored(digest)).toBe(digest);
  });

  it("refuses a resumed copy whose bytes changed", async () => {
    const bytes = patterned(16 * MiB);
    const { digest, url, aws } = await presigned(bytes);
    const e = sliced({ COPY_SLICE_BYTES: String(5 * MiB) });
    expect(await copyBlob({ digest, url }, e, aws)).toBe("continued");
    const { aws: bad } = await presigned(bytes, { corrupt: true });
    let err;
    try {
      while ((await copyBlob({ digest, url }, e, bad)) === "continued") {}
    } catch (e2) {
      err = e2;
    }
    expect(err).toBeInstanceOf(Fatal);
    expect(await stored(digest)).toBeNull();
    expect(await env.BLOBS.head(progressKey(digest))).toBeNull();
  });

  it("handleQueue re-schedules a busy copy instead of dropping it", async () => {
    const { digest, url, aws } = await presigned(patterned(12 * MiB));
    await env.BLOBS.put(progressKey(digest), JSON.stringify({ leaseUntil: Date.now() + LEASE_MS }));
    const e = sliced();
    const sent = [];
    e.COPY = { send: async (body, opts) => void sent.push({ body, opts }) };
    const m = fakeMessage({ digest, url });
    await handleQueue({ messages: [m] }, e, aws);
    expect(m.acked).toBe(true);
    expect(sent).toEqual([{ body: { digest, url, busyRounds: 1 }, opts: { delaySeconds: 60 } }]);
  });

  it("stops re-scheduling a copy that stays busy too long", async () => {
    const { digest, url, aws } = await presigned(patterned(12 * MiB));
    await env.BLOBS.put(progressKey(digest), JSON.stringify({ leaseUntil: Date.now() + LEASE_MS }));
    const e = sliced();
    const m = fakeMessage({ digest, url, busyRounds: 30 });
    await handleQueue({ messages: [m] }, e, aws);
    expect(e.COPY.sent).toHaveLength(0);
  });

  it("a crashed copy (lease never released) resumes once the short lease lapses", async () => {
    const { digest, url, aws } = await presigned(patterned(23 * MiB));
    const e = sliced({ COPY_SLICE_BYTES: String(5 * MiB) });
    expect(await copyBlob({ digest, url }, e, aws)).toBe("continued");
    // Simulate a crash mid-slice: record left holding a lease.
    const rec = await (await env.BLOBS.get(progressKey(digest))).json();
    await env.BLOBS.put(progressKey(digest), JSON.stringify({ ...rec, leaseUntil: Date.now() + LEASE_MS }));
    expect(await copyBlob({ digest, url }, e, aws)).toBe("busy");
    const later = { ...aws, now: () => Date.now() + LEASE_MS + 1 };
    let result;
    do {
      result = await copyBlob({ digest, url }, e, later);
    } while (result === "continued");
    expect(result).toBe("copied");
    expect(await stored(digest)).toBe(digest);
  });

  it("handleQueue acks a continued copy (the next slice is its own message)", async () => {
    const { digest, url, aws } = await presigned(patterned(16 * MiB));
    const e = sliced({ COPY_SLICE_BYTES: String(5 * MiB) });
    const m = fakeMessage({ digest, url });
    await handleQueue({ messages: [m] }, e, aws);
    expect(m.acked).toBe(true);
    expect(e.COPY.sent).toHaveLength(1);
  });
});
