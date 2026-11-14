variable "account_id" {
  description = "Cloudflare account"
  type        = string
}

variable "zone_id" {
  description = "Cloudflare zone holding the hostname"
  type        = string
}

variable "hostname" {
  description = "Where Docker clients pull from"
  type        = string
}

variable "ecr_registry" {
  description = "The ECR registry Freeport fronts, e.g. 123456789012.dkr.ecr.us-east-1.amazonaws.com"
  type        = string
}

variable "name" {
  description = "Prefix for the Worker, bucket and queue"
  type        = string
  default     = "freeport"
}

# Copier knobs: docs/DEPLOY.md. Keep in step with wrangler.jsonc (local dev/tests).
# Memory: queue invocations can share one 128 MB isolate, so the worst case is
# copier_max_concurrency x copy_concurrency x part_size x ~2.5 (buffers) ≈ 80 MB.
variable "part_size" {
  type    = number
  default = 8388608 # 8 MiB; max layer 10,000 parts = 80 GiB
}

variable "copy_concurrency" {
  description = "Parts in flight per copy"
  type        = number
  default     = 2
}

variable "copier_max_concurrency" {
  description = "Copy jobs at once"
  type        = number
  default     = 2
}

variable "copy_slice_bytes" {
  type    = number
  default = 34359738368 # 32 GiB
}

variable "copy_budget_seconds" {
  type    = number
  default = 870
}
