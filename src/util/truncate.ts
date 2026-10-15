/**
 * Utilities for output size limiting and safe truncation.
 */

export interface TruncatedStringResult {
  text: string;
  isTruncated: boolean;
  originalBytes: number;
  returnedBytes: number;
  excessBytes: number;
}

/**
 * Truncates text so that its UTF-8 byte length does not exceed maxBytes.
 * Appends a helpful instruction banner if truncated.
 */
export function truncateUtf8Bytes(
  text: string,
  maxBytes: number,
  narrowHint = 'narrow with `paths`'
): TruncatedStringResult {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8');
  const encoded = encoder.encode(text);
  const originalBytes = encoded.length;

  if (originalBytes <= maxBytes) {
    return {
      text,
      isTruncated: false,
      originalBytes,
      returnedBytes: originalBytes,
      excessBytes: 0,
    };
  }

  // Slice at maxBytes
  const sliced = encoded.subarray(0, maxBytes);
  // Decode ignoring any broken multibyte sequences at boundary
  const decodedSliced = decoder.decode(sliced);
  const excessBytes = originalBytes - maxBytes;
  const suffix = `\n\n[truncated: ${excessBytes} more bytes, ${narrowHint}]`;

  return {
    text: decodedSliced + suffix,
    isTruncated: true,
    originalBytes,
    returnedBytes: encoder.encode(decodedSliced + suffix).length,
    excessBytes,
  };
}
