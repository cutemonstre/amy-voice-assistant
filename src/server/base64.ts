/** Base64-encode bytes with Web APIs only (btoa over 32 KB slices, so String.fromCharCode never overflows the argument limit). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const SLICE = 0x8000
  for (let i = 0; i < bytes.length; i += SLICE) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + SLICE) as unknown as number[])
  }
  return btoa(binary)
}
