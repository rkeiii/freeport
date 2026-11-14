# Freeport

A pull-through Docker registry on Cloudflare. Source of truth stays AWS ECR; layers
are cached in R2 so GPU hosts pull bytes from Cloudflare, not from AWS.

**Why:** ECR data egress to hosts outside AWS is billed per GB, per pull. Images can be
tens of GB. R2 egress is free.

## Shape

```
GPU host                        Cloudflare                        AWS
  docker pull  ──────────►  Registry Worker  ──── manifests ────►  ECR
                                  │
                            blob in R2?
                              yes ──►  stream from R2            (no AWS traffic)
                              no  ──►  307 to ECR's presigned S3 URL ──► client
                                       + enqueue copy
                                            │
                                    Copier (queue consumer)
                                       ranged GET ──► R2 multipart
```

## Design choices

**Credentials pass through. Freeport holds none.**
The GPU host keeps `aws ecr get-login-password | docker login <freeport-host>`. Docker sends
that as a Basic header; the Worker relays it to ECR and lets ECR authorize. No IAM user, no
SigV4, no shared registry password, no rotation. Authorization stays in IAM where it already
lives.

On a cache **hit** the Worker serves from R2 without contacting ECR, so it must still check
the credential: `HEAD /v2/<repo>/blobs/<digest>` to ECR with the client's header and
`redirect: "manual"` (no bytes move). Verdict cached ~5 min keyed by
hash(credential + repo + digest).

The check must include the digest, not just the repo. R2 is global by digest, so a
repo-only check would let anyone who can read repo A fetch repo B's layers by asking
for `/v2/A/blobs/<B's digest>`. The per-blob HEAD proves both "caller can read this repo"
and "this blob is in this repo".

**Only blobs are cached. Manifests are a pure proxy.**
All the bytes are in blobs. All the correctness risk (a mutable tag going stale) is in
manifests. Proxying manifests is kilobytes per pull and deletes the invalidation problem
outright.

**Bytes never pass through the Worker on a miss.**
The Worker sets `redirect: "manual"`, captures ECR's 307 `Location`, and hands that presigned
S3 URL to the client. The pull runs at full speed and the Worker stays out of the data path.
Populating R2 happens separately, after the client is gone.

Cost: a cold miss from outside AWS pays egress **twice** (client + copier). The warm step
below avoids that: CodeBuild's pull is redirected to S3 in the same region (no egress), so
the copier's GET is the only egress for a blob, ever.

Hits honor `Range` (Docker resumes layer downloads with it); R2 `get()` supports ranges.

**Blobs are keyed by digest, flat and global.**
Content-addressed, so dedup across repos and tags is free and nothing is ever invalidated.
No D1, no index.

**Copies stream in fixed-size ranged parts, and resume.**
Worker memory is 128 MB, and R2 `put()` needs a known length. One invocation runs a loop:
ranged GET 16 MiB into memory → hash it → `uploadPart` → drop it, a few parts in flight.
Each byte is read once.

A queue invocation gets 15 min wall and 5 min CPU. So a copy works in slices: up to 32 GiB,
or until a timer at 14.5 min aborts the S3 fetches in flight (finished parts are kept). It
saves progress to R2 (`copies/<digest>`: upload id, part etags,
hash state) and re-queues itself. WebCrypto can't save a running hash, and Workers can't
compile WASM at runtime, so the hash is `@noble/hashes` (pure JS, ~300 MB/s) with its
eight state words saved at part boundaries.

Progress is saved after every window of parts, with an etag precondition and a lease. A
killed invocation loses one window; a copy that's been taken over stops at its next save.

**A failed copy is not an error.**
ECR's presigned URL lasts ~1 hour. If it expires mid-copy, the copy stops with progress
saved; the next pull is a miss with a fresh URL and resumes it. The cache is an
optimization, never a source of truth.

Queues deliver at least once, and a fleet launch misses the same blob many times. The copier
skips a digest that's already in R2 or leased by another copy, so duplicates cost an R2 call
or two. The copier checks the sha256 before `complete()`, so a bad copy can't become a hit.

**Warm on build, don't wait for a listener to pay for it.**
CodeBuild does one pull through Freeport after pushing to ECR. R2 is populated before any
launch, so the fleet never eats the miss. Same code path as any other pull.

**Backend-agnostic in name only, for now.**
R2 is assumed throughout. The name carries no storage vendor so a swap costs no rename.

## Components

**Cloudflare**
- R2 bucket — blobs by digest
- Queue — one message per blob to copy
- One Worker, two handlers (one deploy, one config):
  - `fetch` (`src/registry.js`) — `/v2/*`: ping, auth relay, manifest proxy, blob hit/miss
  - `queue` (`src/copier.js`) — ranged GET → R2 multipart
- Custom domain (`var.hostname`)
- All of it in Terraform (`terraform/`); state in S3

**AWS**
- ECR repos, unchanged. No IAM changes; Freeport holds no AWS credentials.

**Pipeline**
- CodeBuild warm step after push (`scripts/warm.mjs`): walks the manifests and asks for each
  blob without following the redirect, so copies are queued but nothing is downloaded
- Host launch env: repoint image refs at the Freeport host, keep the existing ECR login

## Build order

1. Registry Worker: `/v2/` ping + manifest proxy + blob passthrough to ECR. No R2 yet.
   Correctness first — a working, uncached registry.
2. R2 read path: serve hits, plus the hit-path credential check.
3. Queue + copier: turn misses into hits.
4. CodeBuild warm step.
5. Repoint one pool, measure egress, then the rest.

Step 1 is shippable on its own and proves the auth relay, which is the only novel part.

## Notes

- JavaScript. Workers is a V8 isolate; everything else is WASM, and WASM makes a pure-streaming
  proxy worse for no gain.
- Nothing like this exists publicly — GitHub has no ECR-upstream + R2 Worker cache. The closest
  prior art is `lihongjie0209/cf-docker-registry` (Workers + R2 + D1, pull-through, chunked
  multipart) and `Lotto24/aws-ecr-http-proxy` (nginx, ECR token refresh). Read both; depend on
  neither.
- Verified against live ECR (and a real `crane pull` through `wrangler dev`):
  - `/v2/` challenges `Basic realm="https://<registry>/"`, not `Bearer`. No token-realm dance.
  - Blob `HEAD` → 200 with size, no redirect, no bytes. That's the hit-path check.
  - Blob `GET` → 307 to a presigned S3 URL, `X-Amz-Expires=3600`. S3 honors `Range` (206).
  - The same blob asked for through a repo that doesn't contain it → 404.
  - No credential → 401; a garbage credential → 400.
