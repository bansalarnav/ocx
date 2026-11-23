import { hostname, platform } from "node:os"

export const deviceName = process.env.OCX_DEVICE_NAME?.trim() || (platform() === "darwin" ? "macbook" : hostname())
