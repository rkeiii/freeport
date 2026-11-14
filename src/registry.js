// The registry Worker: /v2/* for Docker clients. Read-only.
//   /v2/                     proxied to ECR (login challenge, credential check)
//   /v2/<repo>/manifests/*   proxied to ECR, never cached
//   /v2/<repo>/blobs/<dig>   R2 hit -> authorize, serve from R2
//                            R2 miss -> ECR's 307 to S3 goes to the client, copy queued
//   other GET/HEAD /v2/*     proxied to ECR (tags/list, referrers)

import { authorize, remember } from "./auth.js";
import { API_VERSION, ecrFetch, registryError, relay } from "./http.js";

const ROUTE = /^\/v2\/(.+)\/(manifests|blobs)\/([^/]+)$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const INLINE_MAX = 8 * 1024 * 1024; // inline ECR responses we'll buffer and keep
// A running copy refreshes this every window, so a stale marker means a dead copy.
export const PENDING_TTL_MS = 5 * 60 * 1000;

export const blobKey = (digest) => `blobs/${digest}`;
export const pendingKey = (digest) => `pending/${digest}`;

export async function handleRequest(request, env, ctx, deps = { fetch: (...args) => fetch(...args) }) {
  const url = new URL(request.url);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return registryError(405, "UNSUPPORTED", "Freeport is a read-only cache; push to ECR");
  }
  if (url.pathname === "/v2" || url.pathname === "/v2/") {
    return relay(await ecrFetch(request, env, deps, "/v2/"), request, env);
  }
  if (!url.pathname.startsWith("/v2/")) {
    return registryError(404, "NOT_FOUND", "Not a registry path");
  }
  const match = url.pathname.match(ROUTE);
  if (match && match[2] === "blobs") {
    return blob(request, env, ctx, deps, match[1], decodeURIComponent(match[3]));
  }
  return relay(await ecrFetch(request, env, deps, url.pathname + url.search), request, env);
}

async function blob(request, env, ctx, deps, repo, digest) {
  if (!DIGEST.test(digest)) {
    return registryError(400, "DIGEST_INVALID", "Only sha256 digests are supported");
  }
  const cached = await env.BLOBS.head(blobKey(digest));
  if (cached) {
    const denied = await authorize(request, env, ctx, deps, repo, digest);
    if (denied) {
      return denied;
    }
    return serve(request, env, cached, digest);
  }

  const upstream = await ecrFetch(request, env, deps, `/v2/${repo}/blobs/${digest}`);
  if (upstream.status < 400) {
    ctx.waitUntil(remember(request, repo, digest));
  }
  const location = upstream.headers.get("location");
  if (request.method === "GET" && upstream.status >= 300 && upstream.status < 400 && location) {
    ctx.waitUntil(
      enqueueCopy(env, digest, location).catch((err) => console.error(`enqueue ${digest}: ${err.message}`)),
    );
  }
  // ECR sends tiny blobs (e.g. the 32-byte empty layer) inline with a 200, no redirect.
  // Keep those as they pass: read, give the client its bytes, store if sha256 matches.
  const size = Number(upstream.headers.get("content-length"));
  if (
    request.method === "GET" &&
    upstream.status === 200 &&
    !request.headers.has("range") &&
    size > 0 &&
    size <= INLINE_MAX
  ) {
    const bytes = await upstream.arrayBuffer();
    ctx.waitUntil(
      env.BLOBS.put(blobKey(digest), bytes, { sha256: digest.slice("sha256:".length) }).catch((err) =>
        console.error(`inline store ${digest}: ${err.message}`),
      ),
    );
    const response = relay(new Response(bytes, upstream), request, env);
    response.headers.set("X-Freeport-Cache", "miss");
    return response;
  }

  const response = relay(upstream, request, env);
  response.headers.set("X-Freeport-Cache", "miss");
  return response;
}

// One copy per blob at a time: a fleet launch misses the same layer many times.
// The marker is advisory (a race costs one duplicate copy, never a wrong byte).
export async function enqueueCopy(env, digest, url) {
  const marker = await env.BLOBS.head(pendingKey(digest));
  if (marker && Date.now() - marker.uploaded.getTime() < PENDING_TTL_MS) {
    return false;
  }
  // Send first: a marker without a message would block copies for PENDING_TTL_MS.
  await env.COPY.send({ digest, url });
  await env.BLOBS.put(pendingKey(digest), "");
  return true;
}

async function serve(request, env, cached, digest) {
  const headers = new Headers({
    ...API_VERSION,
    "Content-Type": "application/octet-stream",
    "Docker-Content-Digest": digest,
    "Accept-Ranges": "bytes",
    ETag: `"${digest}"`,
    "X-Freeport-Cache": "hit",
  });
  if (request.method === "HEAD") {
    headers.set("Content-Length", String(cached.size));
    return new Response(null, { headers });
  }
  const ranged = request.headers.has("range");
  const start = /^bytes=(\d+)-/.exec(request.headers.get("range") ?? "");
  if (start && Number(start[1]) >= cached.size) {
    headers.set("Content-Range", `bytes */${cached.size}`);
    return new Response(null, { status: 416, headers });
  }
  let object;
  try {
    object = await env.BLOBS.get(blobKey(digest), ranged ? { range: request.headers } : {});
  } catch {
    headers.set("Content-Range", `bytes */${cached.size}`);
    return new Response(null, { status: 416, headers });
  }
  if (object === null) {
    return registryError(404, "BLOB_UNKNOWN", "Blob vanished from cache; retry");
  }
  if (ranged && object.range && "offset" in object.range) {
    const { offset, length } = object.range;
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${cached.size}`);
    headers.set("Content-Length", String(length));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(cached.size));
  return new Response(object.body, { headers });
}
