declare module "*.wasm" {
  const module: WebAssembly.Module | string
  export default module
}
