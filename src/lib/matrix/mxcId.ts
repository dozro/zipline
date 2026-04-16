/**
 * helper function to convert to base64
 *
 * @param {string} value the string
 * @return {*}  {string} the url-safe-base64 encoded string
 */
function toBase64Url(value: string): string {
  if (typeof btoa === 'function') {
    const bytes = new TextEncoder().encode(value);
    let binary = '';

    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }

    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  if (typeof Buffer !== 'undefined') {
    return Buffer.from(value).toString('base64url');
  }

  throw new Error('No base64 encoder available in this runtime');
}

/**
 * helper function to convert from base 64 to a string
 *
 * @param {string} value the base64 encoded url
 * @return {*}  {string} the usable string
 */
function fromBase64Url(value: string): string {
  if (typeof atob === 'function') {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  if (typeof Buffer !== 'undefined') {
    return Buffer.from(value, 'base64url').toString();
  }

  throw new Error('No base64 decoder available in this runtime');
}

/**
 * convert a file name to a mxc safe id
 *
 * @export
 * @param {string} fname the file name
 * @return {*} {string} the mxc id
 */
export function toMatrixID(fname: string): string {
  const prefix = 'zipline_';
  const base64 = toBase64Url(fname);
  return prefix + base64;
}

/**
 * convert a mxc id to a file name we can actually use
 *
 * @export
 * @param {string} mxcID the matrix mxc id
 * @return {*}  {string} the file name we can actually use and resolve
 */
export function fromMatrixID(mxcID: string): string {
  if (!mxcID.startsWith('zipline_')) {
    throw new Error('Invalid custom format');
  }
  const base64 = mxcID.slice(8);
  return fromBase64Url(base64);
}
