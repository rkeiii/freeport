# Deploying Freeport

Terraform (`terraform/`) owns everything deployed: the Worker (code, bindings, limits),
R2 bucket and lifecycle rules, queue, queue consumer, custom domain. `wrangler.jsonc` is
for local dev and tests only.

Nothing is created in AWS. Clients bring their own ECR login.

## Config (untracked)

```bash
cp terraform/terraform.tfvars.example terraform/terraform.tfvars   # account, zone, hostname, ECR registry
cp terraform/backend.hcl.example terraform/backend.hcl             # S3 bucket/key/region for state
```

## Credentials

`terraform/tf.sh` wraps terraform with:

- Cloudflare: a scoped account token in `~/.cloudflare/freeport-deploy-token` (`API_TOKEN=...`;
  override the path with `FREEPORT_TOKEN_FILE`). Permissions: Workers Scripts, R2, Queues: write;
  Account Settings, Workers Tail: read; your zone: read.
- AWS: only for the state bucket. `FREEPORT_AWS_PROFILE`, or your default credentials.

The account needs R2 enabled and the Workers Paid plan (queues; 5 min CPU for hashing).

## Deploy

```bash
npm ci
npm test
terraform/tf.sh init
terraform/tf.sh plan -out=freeport.tfplan   # also runs npm run build (bundles to dist/)
terraform/tf.sh apply freeport.tfplan
```

Code changes: `npm test && terraform/tf.sh apply` (the bundle's sha256 is in the plan).

## Try it

The first pull costs ECR egress twice (client + copier); the second should cost none.

```bash
H=freeport.example.com
IMG=$H/<repo>:<tag>
curl -si https://$H/v2/ | head -3                       # 401, realm="https://$H/"
aws ecr get-login-password --region <region> | docker login -u AWS --password-stdin $H

docker pull $IMG                                       # 1st: misses, S3 redirects, copies queued
npx wrangler tail freeport                             # watch QUEUE freeport-copy ...
aws ecr get-login-password --region <region> \
  | node scripts/warm.mjs $IMG --platform linux/amd64 --wait   # returns when all cached

docker rmi $IMG && docker pull $IMG                    # 2nd: every layer from R2
```

## Using it

No IAM changes: Freeport holds no AWS credentials.

- **CI:** after `docker push`, add the warm step (e.g. `docs/buildspec-warm.yml` for CodeBuild).
- **Pulling hosts:** same login, aimed at Freeport, and image refs pointed at it:

  ```bash
  aws ecr get-login-password --region <region> | docker login -u AWS --password-stdin freeport.example.com
  docker pull freeport.example.com/<repo>:<tag>   # was <account>.dkr.ecr.<region>.amazonaws.com/<repo>:<tag>
  ```

  The ECR credential helper only matches `*.dkr.ecr.*` hosts, so hosts that use it need the
  `docker login` above instead.

## Rollout

Repoint one pool first. Compare the ECR egress charge (Cost Explorer: DataTransfer-Out for
the registry region) and the R2 hit rate (`wrangler tail`, `X-Freeport-Cache`) before the rest.

Rollback: point image refs back at ECR. Freeport keeps nothing that ECR doesn't have.

## Knobs (`terraform/variables.tf`)

| var | default | |
|---|---|---|
| `part_size` | 16 MiB | multipart part size; max layer = 10,000 parts |
| `copy_concurrency` | 3 | parts in flight per copy; `part_size × this` must fit in 128 MB |
| `copy_slice_bytes` | 32 GiB | bytes per queue invocation before saving progress and re-queuing |
| `copy_budget_seconds` | 870 | a timer aborts in-flight fetches here; finished parts are saved, then re-queue |

Big layers copy in slices: each queue invocation copies up to a slice, saves progress
(`copies/<digest>` in R2: upload id, part etags, hash state) and re-queues itself. A layer's
size is limited only by R2's 10,000 parts (160 GB at 16 MiB parts; raise `part_size` for more).

ECR's S3 URL lasts 1 hour. A copy still running after that stops with its progress saved;
the next pull's miss brings a fresh URL and the copy resumes where it stopped.

## Note

`cloudflare_r2_bucket_lifecycle` can't be destroyed by Terraform (provider limitation); a
`destroy` leaves the rules on the bucket until removed in the dashboard.
