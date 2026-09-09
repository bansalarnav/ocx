# Vendored OpenTunnel client

Source: https://github.com/anomalyco/opentunnel/tree/8e983e4b1eb55e2965b8694ecd2600a5e5e01783

Revision: `8e983e4b1eb55e2965b8694ecd2600a5e5e01783`. The client and protocol sources are copied unchanged, excluding upstream tests. Upstream package manifests declare MIT but the snapshot has no standalone license file. LICENSE reproduces the standard MIT terms with contributor attribution. Package manifests use exact dependency versions from the upstream catalog and are private workspaces. The client's Effect beta dependency stays separate from ocx's Effect release candidate.

Update by copying client/src and protocol/src from a reviewed upstream revision, updating dependencies from its catalog, and checking device startup, routing, and shutdown. ocx uses the Promise client inside an owned Bun child process so shutdown also closes its TLS sockets. No OpenTunnel executable or background service is installed.
