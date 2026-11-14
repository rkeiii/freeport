import { handleQueue } from "./copier.js";
import { handleRequest } from "./registry.js";

export default {
  fetch: (request, env, ctx) => handleRequest(request, env, ctx),
  queue: (batch, env) => handleQueue(batch, env),
};
