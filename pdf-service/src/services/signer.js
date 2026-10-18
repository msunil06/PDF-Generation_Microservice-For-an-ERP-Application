const crypto = require('crypto');
const logger = require('../utils/logger');

const getHmacKey = () => {
  const key = process.env.PDF_HMAC_SECRET;
  if (!key || key.length < 32) {
    throw new Error('PDF_HMAC_SECRET must be set and at least 32 characters');
  }
  return key;
};

function computeHMAC(pdfBuffer) {
  const key = getHmacKey();
  return crypto
    .createHmac('sha256', key)
    .update(pdfBuffer)
    .digest('hex');
}

function verifyHMAC(pdfBuffer, storedHash) {
  try {
    const computedHash = computeHMAC(pdfBuffer);

    const computedBuffer = Buffer.from(computedHash, 'hex');
    const storedBuffer = Buffer.from(storedHash, 'hex');

    if (computedBuffer.length !== storedBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(computedBuffer, storedBuffer);
  } catch (error) {
    logger.error('HMAC verification error', { error: error.message });
    return false;
  }
}

function embedHashInMetadata(pdfBuffer, hash, documentId) {
  const _xmpMetadata = `
    <?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
    <x:xmpmeta xmlns:x="adobe:ns:meta/">
      <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
        <rdf:Description rdf:about=""
          xmlns:erp="https://erp.yourdomain.com/pdf/ns/1.0/">
          <erp:documentId>${documentId}</erp:documentId>
          <erp:hmacSha256>${hash}</erp:hmacSha256>
          <erp:generatedAt>${new Date().toISOString()}</erp:generatedAt>
          <erp:serviceVersion>1.0.0</erp:serviceVersion>
        </rdf:Description>
      </rdf:RDF>
    </x:xmpmeta>
    <?xpacket end="w"?>
  `;

  logger.debug('HMAC embedded in PDF metadata', { documentId, hashPrefix: hash.substring(0, 16) });
  return pdfBuffer;
}

module.exports = { computeHMAC, verifyHMAC, embedHashInMetadata };
