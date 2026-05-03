// Vite environment type declarations for TypeScript
// See: https://vitejs.dev/guide/env-and-mode.html#env-files

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  // add additional `VITE_` env vars here as needed
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

export {};
