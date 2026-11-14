output "registry" {
  description = "docker login / pull host"
  value       = var.hostname
}

output "upstream" {
  value = var.ecr_registry
}
