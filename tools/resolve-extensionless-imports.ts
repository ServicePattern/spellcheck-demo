import { registerHooks } from 'node:module';

export function resolveExtensionlessImportsAsTs(): void {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        const isRelativeWithoutExtension = specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier);
        if (isRelativeWithoutExtension) {
          return nextResolve(`${specifier}.ts`, context);
        }
        throw error;
      }
    },
  });
}
