/**
 * `@naru/server` library surface — the secured local tRPC server API (plan
 * §15.3, §12.3) consumed by the CLI (`naru serve`) and the OpenCode adapter's
 * discovery.
 *
 * IMPORTANT: this barrel is LIBRARY-ONLY and has NO side effects. The runnable
 * `naru-server` entry (argv parsing + signal handling + the run-if-invoked
 * guard) lives in `./bin.ts`. Keeping it OUT of this barrel is essential: the
 * CLI bundles `createServer` from here, and a run-if-invoked guard
 * (`import.meta.url === process.argv[1]`) bundled into the CLI would misfire
 * (both resolve to the CLI's `dist/index.js`) and auto-start the server on every
 * `naru` command. See git history / bin.ts for why.
 */
export { createServer } from './server'
export type { CreateServerOptions, ServerHandle } from './server'
export {
  type ServerFile,
  type ServerOwnership,
  type WriteServerFileInput,
  acquireServerOwnership,
  isAlive,
  readServerFile,
  removeServerFile,
  serverFileName,
  serverFilePath,
  writeServerFile,
} from './discovery'
export { generateToken, tokenOk } from './auth'
