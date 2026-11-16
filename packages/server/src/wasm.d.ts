declare module "*.wasm" {
  const module: WebAssembly.Module | string
  export default module
}

declare module "*.generated.txt" {
  const source: string
  export default source
}
