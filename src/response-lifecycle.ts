type Finalizer = () => Promise<void>

/**
 * Keeps a resource alive until the response body has been consumed or cancelled.
 */
export const finalizeWithResponse = async (
  response: Response,
  finalize: Finalizer,
): Promise<Response> => {
  if (!response.body) {
    await finalize()
    return response
  }

  const stream = new TransformStream<Uint8Array, Uint8Array>()
  const completion = response.body.pipeTo(stream.writable)
  void completion.then(finalize, finalize)

  return new Response(stream.readable, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}
