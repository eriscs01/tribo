/** RFC 8187 attr-char beyond letters and digits; everything else is percent-encoded. */
const ATTR_EXTRA = new Set(['!', '#', '$', '&', '+', '-', '.', '^', '_', '`', '|', '~']);

function encodeExtValue(name: string): string {
  return [...new TextEncoder().encode(name)]
    .map((byte) => {
      const char = String.fromCharCode(byte);
      return /[A-Za-z0-9]/.test(char) || ATTR_EXTRA.has(char)
        ? char
        : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    })
    .join('');
}

/**
 * Content-Disposition for a download (RFC 6266; decision 0022): always an attachment, the
 * name as printable ASCII in `filename` (anything else, `"` and `\` become `_`) and in full
 * in `filename*`. Nothing in the name can end the header or its quoted string.
 */
export function attachment(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeExtValue(name)}`;
}
