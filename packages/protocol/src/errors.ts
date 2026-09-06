import { Effect, Schema } from "effect"

export class OperationError extends Schema.TaggedError<OperationError>()("OperationError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  get message() {
    return `${this.operation}: ${this.cause instanceof Error ? this.cause.message : String(this.cause)}`
  }
}

/** Adapt an external Promise API at its call site. */
export const attempt = <A>(operation: string, run: (signal: AbortSignal) => PromiseLike<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new OperationError({ operation, cause }) })
export const evaluate = <A>(operation: string, run: () => A) =>
  Effect.try({ try: run, catch: (cause) => new OperationError({ operation, cause }) })
