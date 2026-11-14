# Freeport on Cloudflare: one Worker (registry fetch + copier queue consumer), an R2
# bucket for blobs, a queue for copies, a custom domain. Nothing on the AWS side:
# clients bring their own ECR login. See docs/ARCH.md.

locals {
  bundle = "${path.module}/../dist/index.js" # npm run build
}

resource "cloudflare_r2_bucket" "blobs" {
  account_id = var.account_id
  name       = "${var.name}-blobs"
}

resource "cloudflare_r2_bucket_lifecycle" "blobs" {
  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.blobs.name

  rules = [
    {
      # Copies that die mid-upload leave parts behind.
      id         = "abort-stale-uploads"
      enabled    = true
      conditions = { prefix = "blobs/" }
      abort_multipart_uploads_transition = {
        condition = { type = "Age", max_age = 86400 }
      }
    },
    {
      # "Copy queued" hints.
      id                        = "expire-pending"
      enabled                   = true
      conditions                = { prefix = "pending/" }
      delete_objects_transition = { condition = { type = "Age", max_age = 86400 } }
    },
    {
      # Progress of abandoned copies (their uploads are aborted after 1 day anyway).
      id                        = "expire-progress"
      enabled                   = true
      conditions                = { prefix = "copies/" }
      delete_objects_transition = { condition = { type = "Age", max_age = 172800 } }
    },
  ]
}

resource "cloudflare_queue" "copy" {
  account_id = var.account_id
  queue_name = "${var.name}-copy"
}

resource "cloudflare_workers_script" "freeport" {
  account_id         = var.account_id
  script_name        = var.name
  main_module        = "index.js"
  content_file       = local.bundle
  content_sha256     = filesha256(local.bundle)
  compatibility_date = "2026-11-01"

  bindings = [
    { type = "r2_bucket", name = "BLOBS", bucket_name = cloudflare_r2_bucket.blobs.name },
    { type = "queue", name = "COPY", queue_name = cloudflare_queue.copy.queue_name },
    { type = "plain_text", name = "ECR_REGISTRY", text = var.ecr_registry },
    { type = "plain_text", name = "PART_SIZE", text = tostring(var.part_size) },
    { type = "plain_text", name = "COPY_CONCURRENCY", text = tostring(var.copy_concurrency) },
    { type = "plain_text", name = "COPY_SLICE_BYTES", text = tostring(var.copy_slice_bytes) },
    { type = "plain_text", name = "COPY_BUDGET_SECONDS", text = tostring(var.copy_budget_seconds) },
  ]

  # Hashing a 32 GiB slice needs more than the 30 s default.
  limits = { cpu_ms = 300000 }

  # Cloudflare's defaults, spelled out so plans stay clean.
  observability = {
    enabled            = true
    head_sampling_rate = 1
    logs               = { enabled = true, head_sampling_rate = 1, invocation_logs = true, persist = true }
    traces             = { enabled = false, head_sampling_rate = 1, persist = true }
  }
}

resource "cloudflare_queue_consumer" "copier" {
  account_id  = var.account_id
  queue_id    = cloudflare_queue.copy.queue_id
  type        = "worker"
  script_name = cloudflare_workers_script.freeport.script_name

  settings = {
    batch_size      = 1
    max_retries     = 3
    max_concurrency = var.copier_max_concurrency
  }
}

# Creates the DNS record and certificate itself.
resource "cloudflare_workers_custom_domain" "freeport" {
  account_id = var.account_id
  zone_id    = var.zone_id
  hostname   = var.hostname
  service    = cloudflare_workers_script.freeport.script_name
}
