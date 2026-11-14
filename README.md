# Freeport

**Stop paying the AWS exit tax on big ECR images.**

Freeport is a pull-through cache for AWS ECR that runs on Cloudflare Workers and stores
layers in R2. R2 has zero egress fees, so after the first pull, nothing more is billed by AWS.

## Who it's for

You keep large images (GBs to tens of GBs) in **ECR** and pull them **outside AWS**:
GPU clouds, on-prem, other clouds, CI runners, edge boxes.
Every one of those pulls is AWS data egress, at about $0.09/GB.

| Example | Egress from ECR | With Freeport |
|---|---|---|
| 10 GB image, 100 pulls/day | ~30 TB/mo, about **$2,600/mo** | each layer's egress paid **once** |

## How it works

```
docker pull ──► Freeport Worker ── manifests ──► ECR (source of truth)
                     │
               layer in R2? ── yes ──► served from R2 (no AWS bill)
                            └─ no ───► redirect to ECR + copy into R2 in the background
```

- **Your ECR login still works.** `aws ecr get-login-password | docker login <freeport-host>`.
  Freeport holds no AWS credentials. Every request is authorized by ECR/IAM, cache hits included.
- **Push to ECR the way you do today.** Only pull refs change: `<freeport-host>/<repo>:<tag>`.
- **Optional warm step** after `docker push` puts the layers in R2 before the first pull.

Design: [docs/ARCH.md](docs/ARCH.md) · Deploy: [docs/DEPLOY.md](docs/DEPLOY.md)

## Requirements

Cloudflare account with R2 and Workers Paid (queues). Terraform. Nothing is created in AWS.

## Layout

```
src/index.js      Worker entry: fetch + queue handlers
src/registry.js   /v2/* — auth relay, manifest proxy, blob hit/miss
src/auth.js       hit-path credential check, verdict cache
src/copier.js     queue consumer: S3 → R2 multipart, sha256-checked
src/warm.js       warm an image (used by scripts/warm.mjs in CodeBuild)
test/             vitest in the Workers runtime; fake ECR + S3 in test/fakes.js
terraform/        everything deployed (Cloudflare); tf.sh supplies credentials
```

## Commands

```bash
npm test                       # all tests, in workerd
npx wrangler dev               # local registry on :8787 (local R2 + queue)
terraform/tf.sh plan|apply     # deploy (bundles first)
aws ecr get-login-password | npm run warm -- <host>/<repo>:<tag> [--platform linux/amd64] [--wait]
```
