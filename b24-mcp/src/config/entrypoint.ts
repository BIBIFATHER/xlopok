import { pathToFileURL } from 'node:url';

/**
 * True when the module is the process entry point.
 *
 * Naive `import.meta.url === 'file://' + process.argv[1]` comparison breaks on
 * paths with non-ASCII characters (this repo lives under a Cyrillic path), so
 * the argv path is converted through pathToFileURL instead.
 */
export function isEntrypoint(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return moduleUrl === pathToFileURL(entry).href;
}
