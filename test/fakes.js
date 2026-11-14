// A fake ECR (Basic auth, manifests, 307-to-S3 blobs) and the S3 behind it.

import { env } from "cloudflare:test";

export const GOOD = "Basic " + btoa("AWS:good-token");
export const OTHER = "Basic " + btoa("AWS:other-token"); // valid, but only for repo "other"
export const ECR = `https://${env.ECR_REGISTRY}`;
export const S3 = "https://prod-us-east-1-starport-layer-bucket.s3.us-east-1.amazonaws.com";

export async function digestOf(bytes) {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return "sha256:" + [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function patterned(size, seed = 1) {
  const bytes = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    bytes[i] = x >>> 24;
  }
  return bytes;
}

// repos: { name: { manifests: { ref: {body, type, digest} }, blobs: { digest: bytes } } }
// grants: credential -> list of repo names it may read
// inline: digests ECR answers with a 200 and the bytes (it does this for tiny blobs).
export function fakeAws({ repos = {}, grants = { [GOOD]: null, [OTHER]: ["other"] }, s3 = {}, inline = [] } = {}) {
  const calls = [];
  const s3Objects = new Map(); // path -> bytes
  const fetch = async (input, init = {}) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    calls.push({ method: request.method, url: request.url, headers: Object.fromEntries(request.headers) });

    if (url.origin === S3) {
      if (s3.status) {
        return new Response("nope", { status: s3.status });
      }
      const bytes = s3Objects.get(url.pathname);
      if (!bytes) {
        return new Response("NoSuchKey", { status: 404 });
      }
      const body = s3.corrupt ? patterned(bytes.byteLength, 99) : bytes;
      const range = request.headers.get("range");
      if (!range || s3.ignoreRange) {
        return new Response(body);
      }
      const [, a, b] = /bytes=(\d+)-(\d+)/.exec(range);
      const start = Number(a);
      const end = Math.min(Number(b), body.byteLength - 1);
      return new Response(body.slice(start, end + 1), {
        status: 206,
        headers: { "Content-Range": `bytes ${start}-${end}/${body.byteLength}` },
      });
    }

    if (url.origin !== ECR) {
      throw new Error(`unexpected fetch ${request.url}`);
    }
    const challenge = {
      "WWW-Authenticate": `Basic realm="${ECR}/",service="ecr.amazonaws.com"`,
      "Docker-Distribution-API-Version": "registry/2.0",
    };
    const credential = request.headers.get("authorization");
    if (!(credential in grants)) {
      return new Response('{"errors":[{"code":"DENIED"}]}', { status: 401, headers: challenge });
    }
    if (url.pathname === "/v2/") {
      return new Response("{}", { headers: { "Docker-Distribution-API-Version": "registry/2.0" } });
    }
    const m = /^\/v2\/(.+)\/(manifests|blobs|tags)\/([^/]+)$/.exec(url.pathname);
    const repo = m && repos[m[1]];
    if (!repo) {
      return new Response('{"errors":[{"code":"NAME_UNKNOWN"}]}', { status: 404 });
    }
    const allowed = grants[credential];
    if (allowed && !allowed.includes(m[1])) {
      return new Response('{"errors":[{"code":"DENIED"}]}', { status: 403 });
    }
    if (m[2] === "tags") {
      return Response.json({ name: m[1], tags: Object.keys(repo.manifests ?? {}) });
    }
    if (m[2] === "manifests") {
      const manifest = repo.manifests?.[m[3]];
      if (!manifest) {
        return new Response('{"errors":[{"code":"MANIFEST_UNKNOWN"}]}', { status: 404 });
      }
      return new Response(request.method === "HEAD" ? null : manifest.body, {
        headers: { "Content-Type": manifest.type, "Docker-Content-Digest": manifest.digest },
      });
    }
    const bytes = repo.blobs?.[m[3]];
    if (!bytes) {
      return new Response('{"errors":[{"code":"BLOB_UNKNOWN"}]}', { status: 404 });
    }
    if (inline.includes(m[3])) {
      return new Response(request.method === "HEAD" ? null : bytes, {
        headers: { "Content-Length": String(bytes.byteLength), "Docker-Content-Digest": m[3] },
      });
    }
    const path = `/${m[3].slice(7)}`;
    s3Objects.set(path, bytes);
    return new Response(null, {
      status: 307,
      headers: { Location: `${S3}${path}?X-Amz-Signature=sig` },
    });
  };
  return { fetch, calls, ecrCalls: () => calls.filter((c) => c.url.startsWith(ECR)) };
}

export function fakeQueue() {
  const sent = [];
  return { sent, send: async (body) => void sent.push(body) };
}

export function fakeMessage(body, attempts = 1) {
  const m = { body, attempts, acked: false, retried: false };
  m.ack = () => (m.acked = true);
  m.retry = () => (m.retried = true);
  return m;
}
