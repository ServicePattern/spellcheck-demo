import { resolveExtensionlessImportsAsTs } from '../resolve-extensionless-imports.ts';

resolveExtensionlessImportsAsTs();

const { main } = await import('./abort-check.ts');

try {
  await main(process.argv.slice(2), process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
