# SDCP v1 Network Plugin

The `sdcp-v1` complex plugin connects DragonFruit to printers that implement
the original SDCP v1 transport over MQTT for older printers.
Use it for v1 devices; the separate `sdcp-v3` plugin handles the WebSocket-based
v3 protocol.

## Plugin surface

The public registration and runtime implementation live in:

- `plugins/sdcp-v1/pluginDefinition.ts`: registers the `sdcp-v1` network and
  monitoring adapters.
- `plugins/sdcp-v1/pluginManifest.ts`: exposes the Saturn 3 Ultra network-mode
  override while retaining its existing CTB output profile.
- `plugins/sdcp-v1/rust/network.rs`: native UDP, MQTT and HTTP transport.
- `plugins/sdcp-v1/network/index.ts`: streams a print file to the native
  transport in bounded chunks and reports progress.
- `plugins/sdcp-v1/network/sdcpMonitoring.ts`: converts v1's integer status
  payloads to DragonFruit's monitoring contract.

The plugin ID is `sdcp-v1`; its profile network mode is also `sdcp-v1`. The
complex-plugin registry loads it from `plugins/sdcp-v1` and generates the Rust
and TypeScript registries. Do not edit generated registry files directly.

## Transport and operations

SDCP v1 uses a different connection model from SDCP v3:

1. The desktop sends `M99999` over UDP port 3000 to discover or query a printer.
2. For control, it opens a temporary local MQTT listener and sends
   `M66666 <port>` to the printer over UDP. The printer initiates the MQTT
   connection to DragonFruit.
3. MQTT request, response and status messages use
   `/sdcp/request/<MainboardID>`, `/sdcp/response/<MainboardID>` and
   `/sdcp/status/<MainboardID>`.
4. For file transfer, DragonFruit opens a temporary HTTP endpoint and issues
   command 256; the printer downloads the print file from DragonFruit. The
   command URL retains SDCP v1's `${ipaddr}` placeholder for the printer to
   resolve to the controller address.

The adapter exposes connect/discover, status, start, pause, resume, stop and
upload operations using the existing printer networking and monitoring
contracts. SDCP v1 does not provide the v3 plate listing, webcam or remote
material-profile operations, so those capabilities are unavailable.
The empty `plates/list/json` response reports `metadataReady: true`; after
command 256 confirms a file transfer, SDCP v1 has no separate plate-metadata
import step for DragonFruit to poll.

## Constraints

- The desktop and printer must be on the same reachable IPv4 LAN.
- The desktop firewall must allow incoming MQTT and HTTP connections on the
  dynamically selected local ports.
- Monitoring uses UDP status snapshots. File progress is reported while the
  printer downloads the file; v1 does not provide the v3 plate/task model.
- The native Tauri runtime is required for network operations and uploads.

## Validation

The monitoring payload mapping has focused tests in
`plugins/sdcp-v1/network/sdcpMonitoring.test.ts`. Registry and native changes
should be checked with:

```sh
npm run generate:plugin-registry
npm run check:plugin-allowlist
npm run check:generated-plugin-registry
npm run check:docs
cargo check --manifest-path src-tauri/Cargo.toml
```

## Related pages

- [Plugin Framework](plugins-framework.md)
- [Complex Plugin Contributing](plugins-complex-contributing.md)
- [Plugin format architecture](../adr/0031-plugin-format-architecture.md)
