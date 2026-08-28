#!/usr/bin/env node
// Legacy shim for the dsh-acp adapter entry point.
//
// Previously this file held a second, driftable copy of the adapter. To keep a
// single implementation source (REQ-07), it is now just a thin re-export of the
// repository-root `dsh-acp.mjs`, which is the only place the real logic lives.
// Relative imports inside `dsh-acp.mjs` resolve against ITS own location, so
// executing this shim behaves exactly like executing the root adapter.
await import("../dsh-acp.mjs");
