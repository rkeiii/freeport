// Hit-path authorization. R2 serves bytes without asking ECR, so before a hit we ask
// ECR one cheap question with the caller's own credential: can you read this blob in
// this repo? The digest is part of the question because R2 is global by digest; a
// repo-only check would leak other repos' layers. Yes-answers are remembered briefly.

import { ecrFetch, relay, sha256Hex } from "./http.js";

export const VERDICT_TTL_SECONDS = 300;
const MEMO_MAX = 10_000;
const memo = new Map(); // verdict key -> expiry (ms)

// The Workers Cache API only stores Request -> Response pairs, so a verdict is saved as a
// fake response under a made-up URL. `.invalid` is a reserved TLD (RFC 2606): the URL can
// never be fetched or collide with a real one. The key is a hash, so no credential is in it.
function verdictRequest(key) {
  return new Request(`https://freeport-verdict.invalid/${key}`);
}

async function verdictKey(credential, repo, digest) {
  return sha256Hex(`${credential}\n${repo}\n${digest}`);
}

async function known(key) {
  const expiry = memo.get(key);
  if (expiry !== undefined && expiry > Date.now()) {
    return true;
  }
  const cached = await caches.default.match(verdictRequest(key));
  if (cached) {
    memo.set(key, Date.now() + VERDICT_TTL_SECONDS * 1000);
    return true;
  }
  return false;
}

// Record that this credential may read this blob in this repo.
export async function remember(request, repo, digest) {
  const credential = request.headers.get("authorization");
  if (credential === null) {
    return;
  }
  const key = await verdictKey(credential, repo, digest);
  if (memo.size >= MEMO_MAX) {
    memo.clear();
  }
  memo.set(key, Date.now() + VERDICT_TTL_SECONDS * 1000);
  await caches.default.put(
    verdictRequest(key),
    new Response("ok", { headers: { "Cache-Control": `max-age=${VERDICT_TTL_SECONDS}` } }),
  );
}

// null when allowed; otherwise the ECR response to give the client (401, 403, 404...).
export async function authorize(request, env, ctx, deps, repo, digest) {
  const credential = request.headers.get("authorization");
  if (credential !== null && (await known(await verdictKey(credential, repo, digest)))) {
    return null;
  }
  const upstream = await ecrFetch(request, env, deps, `/v2/${repo}/blobs/${digest}`, "HEAD");
  if (upstream.status < 400) {
    ctx.waitUntil(remember(request, repo, digest));
    return null;
  }
  return relay(upstream, new Request(request.url, { method: "HEAD" }), env);
}

export function _resetMemo() {
  memo.clear();
}
