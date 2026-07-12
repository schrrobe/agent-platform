// Gemeinsame Alias-Konfiguration für alle Vitest-Configs im Workspace.
// Cross-Package-Importe (@agent/*) werden in Tests auf den TypeScript-Quellcode
// aufgelöst, damit Tests ohne vorherigen Build laufen. Konvention: ausschließlich
// bare Importe wie `@agent/shared` (keine Deep-Imports).
import { fileURLToPath } from 'node:url';

const packagesDir = fileURLToPath(new URL('./packages', import.meta.url));

export const agentAlias = [
  {
    find: /^@agent\/([a-z0-9-]+)$/,
    replacement: `${packagesDir}/$1/src/index.ts`,
  },
];
