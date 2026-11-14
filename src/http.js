// Talking to ECR, and shaping responses the way Docker expects.

export const API_VERSION = { "Docker-Distribution-API-Version": "registry/2.0" };

// Request headers worth sending upstream. Everything else stays at the edge.
const FORWARD = ["authorization", "accept", "user-agent", "range"];

export function ecrOrigin(env) {
  return `https://${env.ECR_REGISTRY}`;
}

// Same method and credential as the client's request, aimed at ECR. Never follows
// redirects: ECR's 307 Location is a presigned S3 URL we hand back, not fetch.
export function ecrFetch(request, env, deps, path, method = request.method) {
  const headers = new Headers();
  for (const name of FORWARD) {
    const value = request.headers.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }
  return deps.fetch(ecrOrigin(env) + path, { method, headers, redirect: "manual" });
}

// Relay an ECR response, with anything naming ECR's host pointed back at Freeport
// so Docker keeps talking to us (login challenge, relative-to-ECR redirects).
export function relay(upstream, request, env) {
  const ours = new URL(request.url).origin;
  const theirs = ecrOrigin(env);
  const headers = new Headers(upstream.headers);
  for (const name of ["www-authenticate", "location"]) {
    const value = headers.get(name);
    if (value !== null) {
      headers.set(name, value.replaceAll(theirs, ours));
    }
  }
  const body = request.method === "HEAD" ? null : upstream.body;
  return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers });
}

export function registryError(status, code, message) {
  return Response.json(
    { errors: [{ code, message }] },
    { status, headers: API_VERSION },
  );
}

export async function sha256Hex(text) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return hex(bytes);
}

export function hex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
