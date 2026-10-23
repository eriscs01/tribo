// What an upload is, decided from its bytes (Technical design, "Uploads and downloads":
// "sniffs the type against an allowlist"; decision 0021), and the name it is shown under.
// The client's Content-Type and file name are never trusted; they may only disagree and
// be refused for it.
import { Transform } from 'node:stream';
import type { ErrorCode } from '@tribo/contract';
import type { ValueOf } from '@tribo/db';
import { ApiError } from '@tribo/platform';

export type FileMime = ValueOf<'tribo.files.mime_type'>;

/** How many leading bytes the type is read from: enough for an `ftyp` box's brands. */
const HEAD_BYTES = 64;

/** HEIF brands of HEVC-coded images: what image/heic means. AVIF and other HEIFs are not it. */
const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx']);
/** Generic HEIF brands, accepted only when a HEVC brand is among the compatible ones. */
const HEIF_BRANDS = new Set(['mif1', 'msf1']);

/** The extensions a name of each type may end in, lower case. */
const EXTENSIONS: Record<FileMime, readonly string[]> = {
  'application/pdf': ['pdf'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/heic': ['heic', 'heif'],
  'image/webp': ['webp'],
};

/** Declared types that say nothing, or name an allowed type by an alias. */
const GENERIC_TYPES = new Set(['', 'application/octet-stream']);
const TYPE_ALIASES: Record<string, FileMime> = { 'image/jpg': 'image/jpeg' };

const startsWith = (head: Buffer, at: number, signature: string | readonly number[]) => {
  const expected =
    typeof signature === 'string' ? Buffer.from(signature, 'latin1') : Buffer.from(signature);
  return (
    head.length >= at + expected.length && head.subarray(at, at + expected.length).equals(expected)
  );
};

function isHeic(head: Buffer): boolean {
  if (head.length < 16 || !startsWith(head, 4, 'ftyp')) return false;
  const major = head.toString('latin1', 8, 12);
  if (HEIC_BRANDS.has(major)) return true;
  if (!HEIF_BRANDS.has(major)) return false;
  const end = Math.min(head.readUInt32BE(0), head.length);
  for (let at = 16; at + 4 <= end; at += 4) {
    if (HEIC_BRANDS.has(head.toString('latin1', at, at + 4))) return true;
  }
  return false;
}

/** The allowlisted type these leading bytes begin, or null for anything else. */
export function sniffType(head: Buffer): FileMime | null {
  if (startsWith(head, 0, '%PDF-')) return 'application/pdf';
  if (startsWith(head, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(head, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(head, 0, 'RIFF') && startsWith(head, 8, 'WEBP')) return 'image/webp';
  if (isHeic(head)) return 'image/heic';
  return null;
}

export interface Sniffer extends Transform {
  /** The type the bytes began with; only once the stream has passed them on. */
  type(): FileMime;
}

/**
 * Passes a stream through unchanged once its leading bytes are of an allowed type that
 * `refuse` has no objection to. Until then it holds them back (at most HEAD_BYTES), so not
 * a byte of a refused file reaches the blob store: an unknown or empty file fails the
 * stream with file_type_not_allowed, a refused type with refuse's code.
 */
export function sniffer(refuse: (type: FileMime) => ErrorCode | null = () => null): Sniffer {
  let held: Buffer[] = [];
  let heldBytes = 0;
  let decided: FileMime | null = null;

  const decide = (stream: Transform): Error | null => {
    const type = sniffType(Buffer.concat(held));
    const refusal = type === null ? 'file_type_not_allowed' : refuse(type);
    if (refusal !== null) return new ApiError(refusal);
    decided = type;
    for (const chunk of held) stream.push(chunk);
    held = [];
    return null;
  };

  const stream = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      if (decided !== null) {
        done(null, chunk);
        return;
      }
      held.push(chunk);
      heldBytes += chunk.length;
      done(heldBytes >= HEAD_BYTES ? decide(this) : null);
    },
    flush(done) {
      done(decided === null ? decide(this) : null);
    },
  }) as Sniffer;
  stream.type = () => {
    if (decided === null) throw new Error('the upload was not sniffed yet');
    return decided;
  };
  return stream;
}

const EXTENSION = /\.([A-Za-z0-9]{1,8})$/;

/** A name's extension in lower case, or null when it has none. */
const extensionOf = (name: string) => EXTENSION.exec(name)?.[1]?.toLowerCase() ?? null;

/** Refuses a name whose extension belongs to another type than the file's bytes. */
export function nameRefusal(name: string, type: FileMime): ErrorCode | null {
  const extension = extensionOf(name);
  return extension === null || EXTENSIONS[type].includes(extension)
    ? null
    : 'file_type_not_allowed';
}

/**
 * Refuses an upload whose declared Content-Type or file name contradicts the type its bytes
 * were recognised as. Neither is needed: a generic or missing type and a bare name pass.
 */
export function typeRefusal(
  sniffed: FileMime,
  declared: { contentType: string; filename: string },
): ErrorCode | null {
  const type = declared.contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!GENERIC_TYPES.has(type) && (TYPE_ALIASES[type] ?? type) !== sniffed) {
    return 'file_type_not_allowed';
  }
  return nameRefusal(declared.filename, sniffed);
}

/** What PostgreSQL's length() counts: code points, not UTF-16 units. */
const codePoints = (text: string) => text.match(/[\s\S]/gu)?.length ?? 0;

/** The longest run of whole graphemes from the start that is at most `max` code points. */
function cut(text: string, max: number): string {
  let out = '';
  for (const { segment } of new Intl.Segmenter().segment(text)) {
    if (codePoints(out) + codePoints(segment) > max) break;
    out += segment;
  }
  return out;
}

const MAX_NAME = 255;
// C0 and C1 controls, DEL, and the bidirectional overrides and isolates a name could hide
// its real extension behind ("photo‮gpj.exe").
// eslint-disable-next-line no-control-regex -- these are exactly the characters removed
const UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

/**
 * The name a file is shown and downloaded under: the client's last path segment only, in
 * NFC, without control or bidi override characters or leading dots, at most 255
 * characters (the stem is cut, the extension kept). A name left empty becomes
 * `upload.<extension of its type>`. It is a label, never part of a path.
 */
export function displayName(raw: string, type: FileMime): string {
  const base = raw.split(/[/\\]/).pop() ?? '';
  const name = base
    .normalize('NFC')
    .replace(UNSAFE_CHARACTERS, '')
    .trim()
    .replace(/^\.+/, '')
    .trim();
  if (name === '') return `upload.${EXTENSIONS[type][0] ?? 'bin'}`;
  if (codePoints(name) <= MAX_NAME) return name;
  const tail = extensionOf(name) === null ? '' : name.slice(name.lastIndexOf('.'));
  return cut(name.slice(0, name.length - tail.length), MAX_NAME - tail.length) + tail;
}
