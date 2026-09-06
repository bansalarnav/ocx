import { Schema } from "effect"

export const PluginManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  plugins: Schema.Array(
    Schema.Struct({
      id: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/)),
      version: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._-]{1,80}$/)),
      sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
      entrypoint: Schema.Literal("tui.tsx"),
      contentType: Schema.Literal("application/typescript"),
      opencode: Schema.Struct({ minimumVersion: Schema.String }),
      permissions: Schema.Struct({
        serverOrigins: Schema.Tuple([Schema.Literal("self")]),
        filesystem: Schema.Literal(false),
        process: Schema.Literal(false),
        network: Schema.Literal(false),
      }),
      notes: Schema.String,
    }),
  ),
})

export type TuiPluginManifest = typeof PluginManifestSchema.Type
export type TuiPluginManifestEntry = TuiPluginManifest["plugins"][number]
