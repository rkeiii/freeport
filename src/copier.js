// Queue consumer: turn a miss into a hit. Downloads a blob from ECR's presigned S3 URL
// in fixed-size ranged parts and writes it to R2, checking the sha256 before the
// object becomes visible.
//
// Big blobs copy across several invocations. Each copies up to COPY_SLICE_BYTES, or until
// a timer fires at COPY_BUDGET_SECONDS and aborts the S3 fetches in flight; then it saves
// its progress to R2 (copies/<digest>: upload id, part etags, hash state) and re-queues
// itself. Any later message for the digest,
// including one from a fresh miss with a fresh URL, resumes from there.
//
// One invocation works on a digest at a time: the progress record carries a lease, is
// saved after every window of parts, and every save is conditional on the etag we last
// saw, so a copy that's been taken over stops at its next window.
//
// A failed copy is never an error for clients: they pull from S3 until it's a hit.

import { blobKey, pendingKey } from "./registry.js";
import { hexDigest, loadHash, newHash, saveHash } from "./sha256.js";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const R2_MIN_PART = 5 * MiB;
const R2_MAX_PARTS = 10_000;
// Renewed every window. Short, so a copy whose invocation crashed (e.g. out of memory,
// which kills the isolate without running our cleanup) is free to resume quickly.
export const LEASE_MS = 2 * 60 * 1000;
export const BUSY_DELAY_SECONDS = 60;
const BUSY_MAX_ROUNDS = 30; // a copy that's held for 30+ min is someone else's problem

export const progressKey = (digest) => `copies/${digest}`;

export class Retryable extends Error {}
export class Fatal extends Error {}
class Lost extends Error {} // another invocation holds the lease now
class UploadGone extends Error {} // multipart upload aborted (lifecycle) or unknown
class Deadline extends Error {} // this invocation's time is up

export async function handleQueue(batch, env, deps) {
  for (const message of batch.messages) {
    try {
      const result = await copyBlob(message.body, env, deps);
      if (result === "busy") {
        // Another copy holds it, or a crashed one did. Come back after its lease could
        // lapse; if the other copy finishes first, we'll find "exists" and stop.
        const rounds = (message.body.busyRounds ?? 0) + 1;
        if (rounds <= BUSY_MAX_ROUNDS) {
          await env.COPY.send({ ...message.body, busyRounds: rounds }, { delaySeconds: BUSY_DELAY_SECONDS });
        }
      }
      message.ack();
    } catch (err) {
      if (err instanceof Retryable && message.attempts < 3) {
        console.warn(`copy ${message.body.digest} retrying: ${err.message}`);
        message.retry({ delaySeconds: 10 });
      } else {
        console.error(`copy ${message.body.digest} stopped: ${err.message}`);
        // Let the next miss queue a copy (with a fresh URL) right away.
        await env.BLOBS.delete(pendingKey(message.body.digest));
        message.ack();
      }
    }
  }
}

function defaultDeps() {
  return { fetch: (...args) => fetch(...args), now: () => Date.now() };
}

function settings(env) {
  const partSize = Math.max(Number(env.PART_SIZE) || 8 * MiB, R2_MIN_PART);
  return {
    partSize: partSize - (partSize % 64), // hash state is saved at 64-byte block boundaries
    concurrency: Math.max(Number(env.COPY_CONCURRENCY) || 2, 1),
    sliceBytes: Number(env.COPY_SLICE_BYTES) || 32 * GiB,
    budgetMs: (Number(env.COPY_BUDGET_SECONDS) || 870) * 1000,
  };
}

// Returns "exists" | "copied" | "continued" | "busy". Throws Retryable/Fatal.
export async function copyBlob(body, env, deps) {
  const cfg = settings(env);
  // At the deadline, abort the S3 fetches in flight. The parts that finished are kept.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Deadline("budget")), cfg.budgetMs);
  deps = { ...defaultDeps(), ...deps, signal: deadline.signal };
  try {
    return await copy(body, env, deps, cfg);
  } catch (err) {
    if (err instanceof Lost) {
      return "busy";
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function copy({ digest, url }, env, deps, cfg) {
  const key = blobKey(digest);
  if (await env.BLOBS.head(key)) {
    await cleanup(env, digest);
    return "exists";
  }
  const started = deps.now();
  const progress = new Progress(env, digest, deps);
  let state = await progress.load();
  if (state && state.leaseUntil > started) {
    return "busy";
  }

  let upload;
  let hash;
  if (state) {
    await progress.save(state);
    upload = env.BLOBS.resumeMultipartUpload(key, state.uploadId);
    hash = loadHash(state.hash);
  } else {
    let first;
    try {
      first = await getRange(url, 0, cfg.partSize, deps);
    } catch (err) {
      if (err instanceof Deadline) {
        await env.COPY.send({ digest, url });
        return "continued";
      }
      throw err;
    }
    if (first.total <= cfg.partSize) {
      // R2 checks the sha256 itself and refuses the put on mismatch.
      try {
        await env.BLOBS.put(key, first.bytes, { sha256: digest.slice("sha256:".length) });
      } catch (err) {
        throw new Fatal(`R2 rejected ${digest}: ${err.message}`);
      }
      await cleanup(env, digest);
      return "copied";
    }
    const partCount = Math.ceil(first.total / cfg.partSize);
    if (partCount > R2_MAX_PARTS) {
      throw new Fatal(`${digest} needs ${partCount} parts; raise PART_SIZE`);
    }
    upload = await env.BLOBS.createMultipartUpload(key);
    hash = newHash();
    hash.update(first.bytes);
    const part = await upload.uploadPart(1, first.bytes);
    state = {
      uploadId: upload.uploadId,
      partSize: cfg.partSize,
      total: first.total,
      parts: [{ partNumber: part.partNumber, etag: part.etag }],
      hash: saveHash(hash),
    };
    await progress.save(state);
  }

  const partCount = Math.ceil(state.total / state.partSize);
  const continueLater = async () => {
    await progress.save(state, { release: true });
    await env.BLOBS.put(pendingKey(digest), ""); // still in progress: keep misses quiet
    await env.COPY.send({ digest, url });
    return "continued";
  };
  let copied = 0;
  try {
    while (state.parts.length < partCount) {
      if (copied >= cfg.sliceBytes || deps.signal.aborted) {
        return await continueLater();
      }
      const from = state.parts.length + 1;
      const to = Math.min(from + cfg.concurrency - 1, partCount);
      const window = [];
      for (let p = from; p <= to; p++) {
        window.push(copyPart(upload, url, p, state.partSize, deps));
      }
      // Hash strictly in part order, then record the parts.
      for (const { bytes, part } of await Promise.all(window)) {
        hash.update(bytes);
        copied += bytes.byteLength;
        state.parts.push({ partNumber: part.partNumber, etag: part.etag });
      }
      if (state.parts.length < partCount) {
        // Checkpoint every window: a killed invocation loses at most one window, and
        // the conditional write tells us at once if another copy took over.
        state.hash = saveHash(hash);
        await progress.save(state);
        await env.BLOBS.put(pendingKey(digest), ""); // still in progress: keep misses quiet
      }
    }
  } catch (err) {
    if (err instanceof Deadline) {
      return await continueLater(); // the window in flight is dropped, re-fetched next time
    }
    if (err instanceof UploadGone) {
      await progress.clear();
      throw new Retryable(`multipart upload for ${digest} is gone; restarting`);
    }
    // Keep what's done; the next message (retry, or a fresh miss's URL) resumes it.
    await progress.save(state, { release: true }).catch(() => {});
    throw err;
  }

  const actual = hexDigest(hash);
  if (`sha256:${actual}` !== digest) {
    await upload.abort().catch(() => {});
    await progress.clear();
    throw new Fatal(`${digest} downloaded as sha256:${actual}`);
  }
  try {
    await upload.complete(state.parts);
  } catch (err) {
    await progress.clear();
    throw new Retryable(`complete failed for ${digest}: ${err.message}`);
  }
  await cleanup(env, digest);
  return "copied";
}

async function cleanup(env, digest) {
  await env.BLOBS.delete([pendingKey(digest), progressKey(digest)]);
}

async function copyPart(upload, url, partNumber, partSize, deps) {
  const { bytes } = await getRange(url, (partNumber - 1) * partSize, partSize, deps);
  if (deps.signal?.aborted) {
    throw new Deadline("budget"); // don't upload a part we won't record
  }
  try {
    return { bytes, part: await upload.uploadPart(partNumber, bytes) };
  } catch (err) {
    throw new UploadGone(err.message);
  }
}

// The copies/<digest> record. Every write is conditional on the etag we last saw, so
// two invocations can't both think they own a copy.
class Progress {
  constructor(env, digest, deps) {
    this.env = env;
    this.key = progressKey(digest);
    this.deps = deps;
    this.etag = null;
  }

  async load() {
    const object = await this.env.BLOBS.get(this.key);
    if (!object) {
      return null;
    }
    this.etag = object.etag;
    return object.json();
  }

  // Holds the lease unless release is set.
  async save(state, { release = false } = {}) {
    const record = { ...state, leaseUntil: release ? 0 : this.deps.now() + LEASE_MS };
    // The first write is unconditional: R2 doesn't document a create-only-if-absent
    // condition. Two copies that start at once both write; the one overwritten fails its
    // next conditional save and stops (one wasted part, never a wrong byte).
    const options = this.etag ? { onlyIf: { etagMatches: this.etag } } : {};
    const written = await this.env.BLOBS.put(this.key, JSON.stringify(record), options);
    if (written === null) {
      throw new Lost("another copy took over");
    }
    this.etag = written.etag;
  }

  async clear() {
    await this.env.BLOBS.delete(this.key);
    this.etag = null;
  }
}

// GET bytes [start, start+length) of the presigned URL. Returns { bytes, total }.
export async function getRange(url, start, length, deps) {
  const timeUp = (err) => (deps.signal?.aborted ? new Deadline("budget") : err);
  let response;
  try {
    response = await deps.fetch(url, {
      headers: { Range: `bytes=${start}-${start + length - 1}` },
      signal: deps.signal,
    });
  } catch (err) {
    throw timeUp(new Retryable(`fetch failed: ${err.message}`));
  }
  if (response.status >= 500 || response.status === 429) {
    throw new Retryable(`upstream ${response.status}`);
  }
  // 403 here is an expired presigned URL; a retry can't fix it, a fresh miss can.
  if (response.status !== 200 && response.status !== 206) {
    throw new Fatal(`upstream ${response.status}`);
  }

  let bytes;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (err) {
    throw timeUp(new Retryable(`read failed: ${err.message}`));
  }
  let total;
  if (response.status === 206) {
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
    if (!m || Number(m[1]) !== start) {
      throw new Fatal(`bad Content-Range: ${response.headers.get("content-range")}`);
    }
    total = Number(m[3]);
  } else {
    // Server ignored Range and sent the whole blob.
    if (start !== 0) {
      throw new Fatal("upstream ignored Range");
    }
    total = bytes.byteLength;
  }
  const want = Math.min(length, total - start);
  if (bytes.byteLength !== want) {
    throw new Retryable(`short read: ${bytes.byteLength} of ${want} bytes`);
  }
  return { bytes, total };
}
