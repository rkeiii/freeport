// Warm Freeport for one image: walk its manifests and ask for every blob, so the
// copier fills R2 before the fleet launches. Runs in CodeBuild (Node) after a push;
// pure fetch, so it's testable in the Workers runtime too.
//
// Per blob: HEAD. A hit says X-Freeport-Cache: hit. Otherwise GET without following
// the redirect: Freeport queues the copy and the 307 is dropped, so nothing downloads.

export const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

// "[http(s)://]host/repo/name:tag" or "host/repo@sha256:..." -> { base, host, repo, ref }
export function parseImage(image) {
  const scheme = /^(https?):\/\//.exec(image);
  const origin = scheme ? scheme[1] : "https";
  image = image.slice(scheme ? scheme[0].length : 0);
  const slash = image.indexOf("/");
  if (slash < 0) {
    throw new Error(`image needs a host: ${image}`);
  }
  const host = image.slice(0, slash);
  let rest = image.slice(slash + 1);
  let ref = "latest";
  const at = rest.indexOf("@");
  if (at >= 0) {
    ref = rest.slice(at + 1);
    rest = rest.slice(0, at);
  } else {
    const colon = rest.lastIndexOf(":");
    if (colon > rest.lastIndexOf("/")) {
      ref = rest.slice(colon + 1);
      rest = rest.slice(0, colon);
    }
  }
  return { base: `${origin}://${host}`, host, repo: rest, ref };
}

// "linux/amd64" matches a child manifest's platform. Children with no platform match;
// attestation manifests ("unknown/unknown") don't.
export function platformMatches(platform, child) {
  if (!platform) {
    return true;
  }
  if (!child.platform) {
    return true;
  }
  const [os, architecture, variant] = platform.split("/");
  return (
    child.platform.os === os &&
    child.platform.architecture === architecture &&
    (!variant || child.platform.variant === variant)
  );
}

export async function collectBlobs(base, repo, ref, auth, fetch, platform, seen = new Set()) {
  const r = await fetch(`${base}/v2/${repo}/manifests/${ref}`, {
    headers: { Authorization: auth, Accept: MANIFEST_TYPES },
  });
  if (!r.ok) {
    throw new Error(`manifest ${repo}:${ref}: HTTP ${r.status} ${await r.text()}`);
  }
  const manifest = await r.json();
  if (Array.isArray(manifest.manifests)) {
    for (const child of manifest.manifests.filter((c) => platformMatches(platform, c))) {
      await collectBlobs(base, repo, child.digest, auth, fetch, platform, seen);
    }
  } else {
    for (const blob of [manifest.config, ...(manifest.layers ?? [])]) {
      if (blob?.digest) {
        seen.add(blob.digest);
      }
    }
  }
  return seen;
}

async function isHit(base, repo, digest, auth, fetch) {
  const r = await fetch(`${base}/v2/${repo}/blobs/${digest}`, {
    method: "HEAD",
    headers: { Authorization: auth },
  });
  if (r.status >= 400) {
    throw new Error(`blob ${digest}: HTTP ${r.status}`);
  }
  return r.headers.get("x-freeport-cache") === "hit";
}

async function requestCopy(base, repo, digest, auth, fetch) {
  const r = await fetch(`${base}/v2/${repo}/blobs/${digest}`, {
    headers: { Authorization: auth },
    redirect: "manual",
  });
  await r.body?.cancel();
  if (r.status >= 400) {
    throw new Error(`blob ${digest}: HTTP ${r.status}`);
  }
}

// password: an `aws ecr get-login-password` token. Returns { blobs, hits, queued, pending }.
export async function warm({
  image,
  password,
  fetch,
  platform,
  wait = false,
  timeoutMs = 30 * 60 * 1000,
  pollMs = 10_000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = () => {},
}) {
  const { base, repo, ref } = parseImage(image);
  const auth = "Basic " + btoa(`AWS:${password}`);
  const blobs = [...(await collectBlobs(base, repo, ref, auth, fetch, platform))];
  log(`${image}: ${blobs.length} blobs`);

  let pending = [];
  let hits = 0;
  for (const digest of blobs) {
    if (await isHit(base, repo, digest, auth, fetch)) {
      hits++;
    } else {
      await requestCopy(base, repo, digest, auth, fetch);
      pending.push(digest);
    }
  }
  const queued = pending.length;
  log(`${hits} cached, ${queued} queued`);

  const deadline = Date.now() + timeoutMs;
  while (wait && pending.length > 0 && Date.now() < deadline) {
    await sleep(pollMs);
    const still = [];
    for (const digest of pending) {
      if (!(await isHit(base, repo, digest, auth, fetch))) {
        still.push(digest);
      }
    }
    pending = still;
    log(`${blobs.length - pending.length}/${blobs.length} cached`);
  }
  return { blobs: blobs.length, hits, queued, pending: wait ? pending.length : queued };
}
