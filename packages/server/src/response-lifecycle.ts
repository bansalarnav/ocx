type Finalizer = () => Promise<void>

/** Own the host until consumption/cancellation, without delaying an async API response. */
export const finalizeWithResponse = (
  response: Response,
  finalize: Finalizer,
): Promise<Response> => {
  const finish = () => {
    void finalize().catch((error) => console.error("OpenCode host finalization failed", error))
  }
  if (!response.body) {
    finish()
    return Promise.resolve(response)
  }
  const reader = response.body.getReader()
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const next = await reader.read()
          if (next.done) {
            controller.close()
            finish()
          } else controller.enqueue(next.value)
        } catch (error) {
          controller.error(error)
          finish()
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason)
        } finally {
          finish()
        }
      },
    },
    { highWaterMark: 0 },
  )
  return Promise.resolve(
    new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
  )
}
