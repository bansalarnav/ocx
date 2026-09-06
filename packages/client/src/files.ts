import { Context, Effect, FileSystem, Layer } from "effect"
import { dirname } from "node:path"
import { evaluate } from "@ocx/protocol/errors"

export class Files extends Context.Service<
  Files,
  {
    readonly json: <A>(
      path: string,
      fallback: A,
    ) => Effect.Effect<
      A,
      import("effect/PlatformError").PlatformError | import("@ocx/protocol/errors").OperationError
    >
    readonly write: (
      path: string,
      content: string | Uint8Array,
    ) => Effect.Effect<void, import("effect/PlatformError").PlatformError>
  }
>()("ocx/Files") {
  static layer = Layer.effect(
    Files,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      return Files.of({
        json: Effect.fn("Files.json")(function* <A>(path: string, fallback: A) {
          if (!(yield* fs.exists(path))) return fallback
          const content = yield* fs.readFileString(path)
          return yield* evaluate(`Parse ${path}`, () => JSON.parse(content) as A)
        }),
        write: Effect.fn("Files.write")(function* (path: string, content: string | Uint8Array) {
          yield* fs.makeDirectory(dirname(path), { recursive: true, mode: 0o700 })
          const temporary = `${path}.tmp-${crypto.randomUUID()}`
          yield* (
            typeof content === "string"
              ? fs.writeFileString(temporary, content, { mode: 0o600 })
              : fs.writeFile(temporary, content, { mode: 0o600 })
          ).pipe(
            Effect.andThen(fs.rename(temporary, path)),
            Effect.andThen(fs.chmod(path, 0o600)),
            Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.orDie)),
          )
        }),
      })
    }),
  )
}
