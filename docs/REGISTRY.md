# Registry Integration

Docklane resolves release image references through the OCI Distribution / Docker Registry HTTP API before a Release is persisted.

## Release identity

Clients may create a Release with either:

- `imageTag`: Docklane resolves the tag to `Docker-Content-Digest`.
- `imageDigest`: Docklane verifies that the manifest exists and that the registry returns the same digest.

The persisted Release always contains an immutable `sha256:<64 hex>` digest. A tag remains display/build metadata and is never re-resolved during deployment.

Docklane uses `HEAD /v2/<repository>/manifests/<reference>` and requires a valid `Docker-Content-Digest` response header. This is intentionally stricter than legacy registry compatibility because deployment identity must be immutable.

## Authentication

Anonymous registries work without configuration.

Bearer challenge authentication is supported. When a registry returns `401` with a Bearer challenge, Docklane requests a pull-scoped token and retries the manifest request.

Private registry credentials are runtime configuration, not persisted in the Docklane database in this phase.

`DOCKLANE_REGISTRY_AUTH_JSON` is a JSON object keyed by registry host:

```json
{
  "registry.example.com": {
    "username": "docklane",
    "password": "<secret>"
  }
}
```

Pass this value through the deployment secret mechanism. Do not commit it to source control.

## Private network registries

Registry URLs are server-side requests, so Docklane blocks loopback, link-local, private, multicast, and local-name destinations by default.

A private registry or token service must be explicitly allowlisted using an exact host or host:port entry:

```text
DOCKLANE_REGISTRY_PRIVATE_HOSTS=registry.internal:5000,auth.internal:5001
```

Public endpoints must use HTTPS. Explicitly allowlisted private endpoints may use HTTP for controlled internal environments.

Redirect destinations are validated with the same network policy. Authorization headers are removed when a redirect changes origin.

## Supported manifest types

The client advertises support for:

- OCI image index
- OCI image manifest
- Docker manifest list v2
- Docker image manifest v2

Registry credential persistence, encryption-at-rest, rotation UI, and per-application registry configuration remain follow-up work.
