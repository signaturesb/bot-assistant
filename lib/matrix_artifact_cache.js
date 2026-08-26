'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CACHE_VERSION = 1;
const REQUEST_ID_RE = /^mx[a-f0-9]{16}$/;

function normalizeRecipient(value) {
  return String(value || '').trim().toLowerCase();
}

function recipientDigest(value) {
  return crypto.createHash('sha256').update(normalizeRecipient(value)).digest('hex');
}

function validRequestId(value) {
  return REQUEST_ID_RE.test(String(value || ''));
}

function cacheRoot(dataDir) {
  return path.join(String(dataDir || ''), 'matrix_preview_cache');
}

function requestDir(dataDir, requestId) {
  if (!validRequestId(requestId)) throw new Error('MATRIX_CACHE_REQUEST_ID_INVALID');
  return path.join(cacheRoot(dataDir), requestId);
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function safeRemoveRequest(dataDir, requestId) {
  if (!validRequestId(requestId)) return false;
  const root = cacheRoot(dataDir);
  const target = path.join(root, requestId);
  if (path.dirname(target) !== root) return false;
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function writePrivateFile(file, data) {
  fs.writeFileSync(file, data, { mode: 0o600, flag: 'wx' });
  fs.chmodSync(file, 0o600);
}

function documentHash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function writeMatrixArtifactCache({
  dataDir,
  requestId,
  num,
  filtre = '',
  fingerprint,
  recipient,
  expiresAt,
  documents,
  listing = null,
}) {
  if (!validRequestId(requestId)) throw new Error('MATRIX_CACHE_REQUEST_ID_INVALID');
  if (!/^\d{7,9}$/.test(String(num || ''))) throw new Error('MATRIX_CACHE_CENTRIS_INVALID');
  if (!/^[a-f0-9]{64}$/.test(String(fingerprint || ''))) throw new Error('MATRIX_CACHE_FINGERPRINT_INVALID');
  if (!normalizeRecipient(recipient)) throw new Error('MATRIX_CACHE_RECIPIENT_INVALID');
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('MATRIX_CACHE_EXPIRY_INVALID');
  if (!Array.isArray(documents) || documents.length === 0) throw new Error('MATRIX_CACHE_DOCUMENTS_EMPTY');

  const root = cacheRoot(dataDir);
  ensurePrivateDirectory(root);
  const finalDir = requestDir(dataDir, requestId);
  safeRemoveRequest(dataDir, requestId);
  const tempDir = path.join(root, `.partial-${requestId}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(tempDir, { mode: 0o700 });
  fs.chmodSync(tempDir, 0o700);

  try {
    const manifestDocuments = documents.map((doc, index) => {
      const buffer = Buffer.isBuffer(doc?.buffer) ? doc.buffer : Buffer.from(doc?.buffer || []);
      if (buffer.length < 5 || buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
        throw new Error(`MATRIX_CACHE_DOCUMENT_INVALID:${index}`);
      }
      const file = `document-${String(index + 1).padStart(3, '0')}.pdf`;
      writePrivateFile(path.join(tempDir, file), buffer);
      return {
        file,
        filename: String(doc.filename || `document_${index + 1}_${num}.pdf`).replace(/[\r\n\0]/g, ' '),
        label: String(doc.label || doc.filename || `Document ${index + 1}`).replace(/[\r\n\0]/g, ' '),
        size: buffer.length,
        page_count: Number.isFinite(doc.page_count) ? doc.page_count : null,
        sha256: documentHash(buffer),
        source: doc.source || 'matrix-global',
        provenance: doc.provenance || null,
        generation_method: doc.generation_method || null,
      };
    });

    const manifest = {
      version: CACHE_VERSION,
      requestId,
      num: String(num),
      filtre: String(filtre || ''),
      fingerprint: String(fingerprint),
      recipient_sha256: recipientDigest(recipient),
      expiresAt,
      createdAt: Date.now(),
      listing: listing && typeof listing === 'object' ? {
        centris_num: String(listing.centris_num || ''),
        address: String(listing.address || '').replace(/[\r\n\0]/g, ' ').substring(0, 240),
        address_complete: listing.address_complete === true,
        address_source: listing.address_source || null,
      } : null,
      documents: manifestDocuments,
    };
    writePrivateFile(path.join(tempDir, 'manifest.json'), Buffer.from(JSON.stringify(manifest), 'utf8'));
    fs.renameSync(tempDir, finalDir);
    fs.chmodSync(finalDir, 0o700);
    return { ok: true, directory: finalDir, manifest };
  } catch (error) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    safeRemoveRequest(dataDir, requestId);
    throw error;
  }
}

function loadMatrixArtifactCache({ dataDir, requestId, num, fingerprint, recipient, now = Date.now() }) {
  if (!validRequestId(requestId)) return { ok: false, code: 'MATRIX_CACHE_REQUEST_ID_INVALID' };
  const directory = requestDir(dataDir, requestId);
  const reject = (code) => {
    safeRemoveRequest(dataDir, requestId);
    return { ok: false, code };
  };
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return reject('MATRIX_CACHE_DIRECTORY_INVALID');
    const manifestPath = path.join(directory, 'manifest.json');
    const manifestStat = fs.lstatSync(manifestPath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) return reject('MATRIX_CACHE_MANIFEST_INVALID');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.version !== CACHE_VERSION || manifest.requestId !== requestId) return reject('MATRIX_CACHE_MANIFEST_MISMATCH');
    if (String(manifest.num) !== String(num || '')) return reject('MATRIX_CACHE_CENTRIS_MISMATCH');
    if (String(manifest.fingerprint) !== String(fingerprint || '')) return reject('MATRIX_CACHE_FINGERPRINT_MISMATCH');
    if (manifest.recipient_sha256 !== recipientDigest(recipient)) return reject('MATRIX_CACHE_RECIPIENT_MISMATCH');
    if (!Number.isFinite(manifest.expiresAt) || now > manifest.expiresAt) return reject('MATRIX_CACHE_EXPIRED');
    if (!Array.isArray(manifest.documents) || manifest.documents.length === 0) return reject('MATRIX_CACHE_DOCUMENTS_EMPTY');

    const documents = [];
    for (const item of manifest.documents) {
      if (!/^document-\d{3}\.pdf$/.test(String(item?.file || ''))) return reject('MATRIX_CACHE_FILENAME_INVALID');
      const file = path.join(directory, item.file);
      if (path.dirname(file) !== directory) return reject('MATRIX_CACHE_PATH_INVALID');
      const fileStat = fs.lstatSync(file);
      if (!fileStat.isFile() || fileStat.isSymbolicLink()) return reject('MATRIX_CACHE_FILE_INVALID');
      const buffer = fs.readFileSync(file);
      if (buffer.length !== Number(item.size) || documentHash(buffer) !== item.sha256) return reject('MATRIX_CACHE_DOCUMENT_CORRUPT');
      if (buffer.length < 5 || buffer.subarray(0, 5).toString('ascii') !== '%PDF-') return reject('MATRIX_CACHE_DOCUMENT_NOT_PDF');
      documents.push({
        buffer,
        filename: item.filename,
        label: item.label,
        size: item.size,
        page_count: item.page_count,
        sha256: item.sha256,
        source: item.source,
        provenance: item.provenance,
        generation_method: item.generation_method,
      });
    }
    return {
      ok: true,
      artifact: {
        requestId,
        num: String(manifest.num),
        filtre: String(manifest.filtre || ''),
        fingerprint: String(manifest.fingerprint),
        recipient: normalizeRecipient(recipient),
        documents,
        listing: manifest.listing || null,
        expiresAt: manifest.expiresAt,
        durable: true,
      },
    };
  } catch (error) {
    return reject(error?.code === 'ENOENT' ? 'MATRIX_CACHE_MISSING' : 'MATRIX_CACHE_READ_FAILED');
  }
}

function purgeExpiredMatrixArtifactCaches(dataDir, now = Date.now()) {
  const root = cacheRoot(dataDir);
  let purged = 0;
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !validRequestId(entry.name)) continue;
      const manifestPath = path.join(root, entry.name, 'manifest.json');
      let expired = true;
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        expired = !Number.isFinite(manifest.expiresAt) || now > manifest.expiresAt;
      } catch {}
      if (expired && safeRemoveRequest(dataDir, entry.name)) purged += 1;
    }
  } catch {}
  return purged;
}

module.exports = {
  CACHE_VERSION,
  cacheRoot,
  recipientDigest,
  safeRemoveRequest,
  writeMatrixArtifactCache,
  loadMatrixArtifactCache,
  purgeExpiredMatrixArtifactCaches,
};
