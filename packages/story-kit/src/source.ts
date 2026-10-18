// Text edits on TypeScript sources the scaffold extends. Each edit adds and never rewrites what
// is there; prettier formats the result. An anchor that is missing is a named error, so a file
// someone has reshaped is reported for a hand edit instead of being guessed at.

export class AnchorError extends Error {
  constructor(path: string, anchor: string) {
    super(`${path}: cannot find ${anchor}; add the scaffold's code by hand`);
    this.name = 'AnchorError';
  }
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

const IMPORT = /^import\s[\s\S]*?\sfrom\s+'[^']+';$/gm;

/** Adds `names` to the file's import from `from`, or a new import after the last one. */
export function addImport(
  source: string,
  from: string,
  names: readonly string[],
  { typeOnly = false } = {},
): string {
  if (names.length === 0) return source;
  const keyword = typeOnly ? 'import type' : 'import';
  const existing = new RegExp(`^${keyword} \\{([^}]*)\\} from '${escape(from)}';$`, 'm');
  const match = existing.exec(source);
  if (match) {
    const have = (match[1] ?? '')
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean);
    const missing = names.filter((n) => !have.includes(n) && !have.includes(`type ${n}`));
    if (missing.length === 0) return source;
    const line = `${keyword} { ${[...have, ...missing].join(', ')} } from '${from}';`;
    return source.replace(existing, line);
  }
  const line = `${keyword} { ${names.join(', ')} } from '${from}';\n`;
  // Packages before relative paths, as import-x/order wants them.
  const imports = [...source.matchAll(IMPORT)];
  const relative = (i: RegExpExecArray) => /from\s+'\./.test(i[0]);
  const packages = imports.filter((i) => !relative(i));
  const last = from.startsWith('.') ? imports.at(-1) : packages.at(-1);
  if (last) {
    const end = last.index + last[0].length + 1;
    return `${source.slice(0, end)}${line}${source.slice(end)}`;
  }
  const first = imports[0];
  if (first) return `${source.slice(0, first.index)}${line}${source.slice(first.index)}`;
  // No imports yet: after the file's leading comment, if any.
  const header = /^(\/\/.*\n)*/.exec(source)?.[0] ?? '';
  return `${header}${line}\n${source.slice(header.length)}`;
}

/**
 * Adds `entry` as the last property of the object literal that `export function <name>(`
 * returns: the function's first `  return {` block, closed by `  };` at the same indent.
 */
export function addToReturnedObject(
  path: string,
  source: string,
  functionPattern: RegExp,
  entry: string,
): string {
  const fn = functionPattern.exec(source);
  if (!fn) throw new AnchorError(path, String(functionPattern));
  const open = source.indexOf('\n  return {\n', fn.index);
  const close = open < 0 ? -1 : source.indexOf('\n  };\n', open);
  if (close < 0) throw new AnchorError(path, `the object ${fn[0]} returns`);
  return `${source.slice(0, close)}\n${entry}${source.slice(close)}`;
}

/** Appends a block, separated by one blank line; a placeholder `export {};` gives way. */
export function appendBlock(source: string, block: string): string {
  const body = source.trim() === 'export {};' ? '' : source.trimEnd();
  return body === '' ? `${block}\n` : `${body}\n\n${block}\n`;
}
