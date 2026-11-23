export const authenticated = (request: Request, password?: string): boolean => {
  if (!password) return true
  const match = /^Basic\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")
  if (!match) return false
  try {
    const bytes = Uint8Array.from(atob(match[1]!), (character) => character.charCodeAt(0))
    const decoded = new TextDecoder().decode(bytes)
    const separator = decoded.indexOf(":")
    return (
      separator !== -1 &&
      decoded.slice(0, separator) === "opencode" &&
      decoded.slice(separator + 1) === password
    )
  } catch {
    return false
  }
}
