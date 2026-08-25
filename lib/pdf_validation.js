'use strict';

const crypto = require('crypto');

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_MIN_BYTES = 64;

function error(code, detail = '') {
  const suffix = detail ? `:${detail}` : '';
  return new Error(`${code}${suffix}`);
}

function inspectPdfEnvelope(input, options = {}) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || '');
  const minBytes = Number(options.minBytes ?? DEFAULT_MIN_BYTES);
  const maxBytes = Number(options.maxBytes ?? DEFAULT_MAX_BYTES);
  if (buffer.length < minBytes) throw error('PDF_TOO_SMALL', buffer.length);
  if (buffer.length > maxBytes) throw error('PDF_TOO_LARGE', buffer.length);

  // ISO 32000 permits the header near the beginning, but accepting arbitrary
  // bytes before it lets an HTML/login response containing an embedded PDF
  // marker masquerade as a document. Only BOM/NUL/ASCII whitespace is safe.
  const scan = buffer.subarray(0, Math.min(1024, buffer.length));
  const headerOffset = scan.indexOf(Buffer.from('%PDF-'));
  if (headerOffset < 0) throw error('PDF_HEADER_MISSING');
  const prefix = buffer.subarray(0, headerOffset);
  const harmlessPrefix = /^(?:\xef\xbb\xbf)?[\x00\x09\x0a\x0c\x0d\x20]*$/.test(prefix.toString('latin1'));
  if (!harmlessPrefix) throw error('PDF_UNSAFE_PREFIX', headerOffset);

  const normalized = headerOffset ? buffer.subarray(headerOffset) : buffer;
  if (!/^%PDF-\d\.\d/.test(normalized.subarray(0, 8).toString('latin1'))) {
    throw error('PDF_HEADER_INVALID');
  }
  const tail = normalized.subarray(Math.max(0, normalized.length - 4096)).toString('latin1');
  if (!/%%EOF[\x00\x09\x0a\x0c\x0d\x20]*$/.test(tail)) throw error('PDF_EOF_MISSING');

  // Fast fail with a stable code; pdf-lib supplies the authoritative check too.
  const encrypted = /\/Encrypt\b/.test(normalized.toString('latin1', 0, Math.min(normalized.length, 1024 * 1024)));
  if (encrypted && !options.allowEncrypted) {
    throw error('PDF_ENCRYPTED');
  }
  return { buffer: normalized, bytes: normalized.length, encrypted };
}

async function validatePdfBuffer(input, options = {}) {
  const envelope = inspectPdfEnvelope(input, options);
  if (envelope.encrypted && options.allowEncrypted) {
    // Un PDF protégé provenant directement de Matrix peut interdire toute
    // lecture par une bibliothèque sans mot de passe tout en restant un vrai
    // document ouvrable et transmissible. L'enveloppe, les limites, EOF et le
    // hash restent vérifiés; le nombre de pages est seulement informatif.
    const source = envelope.buffer.toString('latin1');
    const counts = [...source.matchAll(/\/Count\s+(\d+)/g)].map((match) => Number(match[1])).filter((count) => count > 0);
    const pageObjects = (source.match(/\/Type\s*\/Page\b/g) || []).length;
    const pageCount = Math.max(1, pageObjects, ...counts);
    return {
      buffer: envelope.buffer,
      bytes: envelope.bytes,
      pageCount,
      encrypted: true,
      validationLevel: 'protected-envelope',
      sha256: crypto.createHash('sha256').update(envelope.buffer).digest('hex'),
    };
  }
  let PDFDocument;
  try {
    ({ PDFDocument } = require('pdf-lib'));
  } catch {
    throw error('PDF_PARSER_UNAVAILABLE');
  }
  let document;
  try {
    document = await PDFDocument.load(envelope.buffer, {
      // Matrix sert parfois des formulaires officiels protégés contre la
      // modification, mais parfaitement ouvrables par le destinataire. Ils
      // restent acceptables si l'appelant l'autorise explicitement.
      ignoreEncryption: Boolean(options.allowEncrypted),
      updateMetadata: false,
      throwOnInvalidObject: true,
    });
  } catch (cause) {
    const message = String(cause?.message || '');
    if (/encrypt/i.test(message)) throw error('PDF_ENCRYPTED');
    throw error('PDF_CORRUPT');
  }
  const pageCount = document.getPageCount();
  if (!Number.isInteger(pageCount) || pageCount < 1) throw error('PDF_PAGE_COUNT_INVALID');
  return {
    buffer: envelope.buffer,
    bytes: envelope.bytes,
    pageCount,
    encrypted: envelope.encrypted,
    validationLevel: 'parsed',
    sha256: crypto.createHash('sha256').update(envelope.buffer).digest('hex'),
  };
}

module.exports = { inspectPdfEnvelope, validatePdfBuffer };
