terraform {
  required_version = ">= 1.14"

  # S3 state; bucket, key and region come from backend.hcl (untracked, see
  # backend.hcl.example). tf.sh passes it on init.
  backend "s3" {
    encrypt      = true
    use_lockfile = true
  }

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.28.0"
    }
  }
}

# Token from CLOUDFLARE_API_TOKEN (see tf.sh).
provider "cloudflare" {}
