import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { pipeline } from 'node:stream/promises';
import { ApiError } from '@tribo/platform';
import { describe, expect, it } from 'vitest';
import { displayName, nameRefusal, sniffer, sniffType, typeRefusal } from './sniff.js';

const bytes = (...parts: (string | number[])[]) =>
  Buffer.concat(
    parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))),
  );

/** An ISO base media `ftyp` box: size, 'ftyp', major brand, minor version, compatible brands. */
function ftyp(major: string, compatible: string[] = []) {
  const size = 16 + 4 * compatible.length;
  const head = Buffer.alloc(8);
  head.writeUInt32BE(size, 0);
  head.write('ftyp', 4, 'latin1');
  return bytes([...head], major, [0, 0, 0, 0], ...compatible);
}

const PDF = bytes('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n');
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], 'JFIF\0');
const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [0, 0, 0, 13], 'IHDR');
const WEBP = bytes('RIFF', [0x24, 0, 0, 0], 'WEBPVP8 ');
const HEIC = ftyp('heic', ['mif1', 'heic']);

describe('sniffType', () => {
  it.each([
    ['application/pdf', PDF],
    ['image/jpeg', JPEG],
    ['image/png', PNG],
    ['image/webp', WEBP],
    ['image/heic', HEIC],
    ['image/heic', ftyp('heix')],
    ['image/heic', ftyp('mif1', ['heic'])],
  ])('reads %s from its first bytes', (type, head) => {
    expect(sniffType(head)).toBe(type);
  });

  it.each([
    ['empty', Buffer.alloc(0)],
    ['HTML', bytes('<!doctype html><script>alert(1)</script>')],
    ['SVG', bytes('<svg xmlns="http://www.w3.org/2000/svg">')],
    ['ZIP', bytes([0x50, 0x4b, 0x03, 0x04])],
    ['a PE executable', bytes('MZ\x90\0')],
    ['GIF', bytes('GIF89a')],
    ['AVIF', ftyp('avif', ['mif1', 'avif'])],
    ['plain HEIF without a HEVC brand', ftyp('mif1', ['avif'])],
    ['a RIFF that is not WebP', bytes('RIFF', [0x24, 0, 0, 0], 'WAVEfmt ')],
    ['a PDF signature past offset 0', bytes(' %PDF-1.7')],
    ['a truncated PNG signature', bytes([0x89, 0x50, 0x4e, 0x47])],
  ])('refuses %s', (_name, head) => {
    expect(sniffType(head)).toBeNull();
  });
});

describe('sniffer', () => {
  it('passes every byte through and reports the type once the stream ends', async () => {
    const body = Buffer.concat([PNG, Buffer.alloc(100_000, 7)]);
    const sniff = sniffer();
    // Chunks smaller than the signature, so the head is assembled across them.
    const chunks = [...Array(Math.ceil(body.length / 3)).keys()].map((i) =>
      body.subarray(i * 3, i * 3 + 3),
    );
    const out = await buffer(Readable.from(chunks).pipe(sniff));
    expect(out.equals(body)).toBe(true);
    expect(sniff.type()).toBe('image/png');
  });

  it('recognises a file shorter than the bytes it looks at', async () => {
    const sniff = sniffer();
    await buffer(Readable.from([JPEG]).pipe(sniff));
    expect(sniff.type()).toBe('image/jpeg');
  });

  it('fails with file_type_not_allowed before passing on a byte of an unknown type', async () => {
    const sniff = sniffer();
    const seen: Buffer[] = [];
    const failure = pipeline(
      Readable.from([bytes('<html>'), Buffer.alloc(70_000)]),
      sniff,
      async (source: AsyncIterable<Buffer>) => {
        for await (const chunk of source) seen.push(chunk);
      },
    );
    await expect(failure).rejects.toEqual(new ApiError('file_type_not_allowed'));
    expect(seen).toEqual([]);
  });

  it('fails with the code its refusal names, before passing on a byte', async () => {
    const sniff = sniffer((type) => (type === 'image/png' ? 'file_type_not_allowed' : null));
    const seen: Buffer[] = [];
    const failure = pipeline(Readable.from([PNG]), sniff, async (source: AsyncIterable<Buffer>) => {
      for await (const chunk of source) seen.push(chunk);
    });
    await expect(failure).rejects.toEqual(new ApiError('file_type_not_allowed'));
    expect(seen).toEqual([]);
  });

  it('fails an empty file', async () => {
    await expect(pipeline(Readable.from([]), sniffer(), async () => {})).rejects.toEqual(
      new ApiError('file_type_not_allowed'),
    );
  });

  it('has no type before the stream decided one', () => {
    expect(() => sniffer().type()).toThrow(/not sniffed/);
  });
});

describe('typeRefusal', () => {
  it('accepts a declared type that agrees, a generic one, or none', () => {
    expect(typeRefusal('image/png', { contentType: 'image/png', filename: 'a.png' })).toBeNull();
    expect(
      typeRefusal('image/png', { contentType: 'IMAGE/PNG; x=1', filename: 'a.PNG' }),
    ).toBeNull();
    expect(
      typeRefusal('image/jpeg', { contentType: 'application/octet-stream', filename: 'b.JPG' }),
    ).toBeNull();
    expect(typeRefusal('image/jpeg', { contentType: 'image/jpg', filename: 'b.jpeg' })).toBeNull();
    expect(typeRefusal('image/heic', { contentType: '', filename: 'IMG_0001.HEIF' })).toBeNull();
    expect(
      typeRefusal('application/pdf', { contentType: '', filename: 'boarding pass' }),
    ).toBeNull();
  });

  it('refuses a declared type or an extension the bytes contradict', () => {
    expect(typeRefusal('image/png', { contentType: 'application/pdf', filename: 'a.png' })).toBe(
      'file_type_not_allowed',
    );
    expect(typeRefusal('image/png', { contentType: 'image/png', filename: 'a.pdf' })).toBe(
      'file_type_not_allowed',
    );
    expect(typeRefusal('image/png', { contentType: '', filename: 'logo.png.html' })).toBe(
      'file_type_not_allowed',
    );
    expect(typeRefusal('application/pdf', { contentType: '', filename: 'ticket.exe' })).toBe(
      'file_type_not_allowed',
    );
  });
});

describe('displayName', () => {
  it('keeps an ordinary name as it is', () => {
    expect(displayName('Ferry ticket — Batanes.pdf', 'application/pdf')).toBe(
      'Ferry ticket — Batanes.pdf',
    );
  });

  it('drops any path a client sent, on either separator', () => {
    expect(displayName('../../etc/passwd.pdf', 'application/pdf')).toBe('passwd.pdf');
    expect(displayName('C:\\Users\\ana\\Desktop\\id.jpg', 'image/jpeg')).toBe('id.jpg');
    expect(displayName('/var/lib/tribo/uploads/ab/cd.png', 'image/png')).toBe('cd.png');
  });

  it('removes control and bidirectional override characters and leading dots', () => {
    expect(displayName('in\u0000voice\r\n.pdf', 'application/pdf')).toBe('invoice.pdf');
    expect(displayName('photo\u202egpj.exe.jpg', 'image/jpeg')).toBe('photogpj.exe.jpg');
    expect(displayName('...hidden.png', 'image/png')).toBe('hidden.png');
  });

  it('composes the name (NFC) and caps it at 255 characters, keeping the extension', () => {
    expect(displayName('Cafe\u0301.jpg', 'image/jpeg')).toBe('Café.jpg');
    const long = displayName(`${'a'.repeat(300)}.webp`, 'image/webp');
    expect(long).toHaveLength(255);
    expect(long.endsWith('.webp')).toBe(true);
  });

  it('names a file that has no usable name after its type', () => {
    expect(displayName('', 'image/png')).toBe('upload.png');
    expect(displayName('../', 'application/pdf')).toBe('upload.pdf');
    expect(displayName('\u0007\u0008', 'image/heic')).toBe('upload.heic');
  });
});

describe('nameRefusal', () => {
  it('lets a rename keep any extension of the file’s type, or none', () => {
    expect(nameRefusal('Passport scan.JPEG', 'image/jpeg')).toBeNull();
    expect(nameRefusal('Passport scan', 'image/jpeg')).toBeNull();
  });

  it('refuses an extension of another type', () => {
    expect(nameRefusal('passport.html', 'image/jpeg')).toBe('file_type_not_allowed');
  });
});
