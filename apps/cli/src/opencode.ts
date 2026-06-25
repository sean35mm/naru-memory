/**
 * Publishable OpenCode plugin entry: `@narulabs/naru/opencode`.
 *
 * OpenCode loads a NAMED exported `Plugin` const (and we also default-export it).
 * This file is a THIN re-export of the real `@opencode-ai/plugin` surface from
 * the adapter's `./plugin` subpath, which pulls ONLY the remote-only plugin path
 * (`@opencode-ai/plugin` peer + `@trpc/client` + a TYPE-ONLY `@naru/api`). It
 * deliberately does NOT touch the adapter barrel (`@naru/opencode-adapter`),
 * which re-exports the embedded client/tools/installer and would transitively
 * pull `@naru/core` / `@naru/server` (native `better-sqlite3`) into the bundle.
 *
 * tsup builds this into `dist/opencode.js` (no shebang — it is imported by
 * opencode, not executed as a bin), and `dist/opencode.js` is grepped to prove
 * it contains no `better-sqlite3`.
 */

export { NaruMemory as default, NaruMemory } from '@naru/opencode-adapter/plugin'
