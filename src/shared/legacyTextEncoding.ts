/** Detect the unambiguous GB18030 four-byte form without decoding data. */
export function containsGb18030FourByteSequence(bytes: Uint8Array): boolean {
  for (let index = 0; index + 3 < bytes.byteLength; index += 1) {
    if (
      bytes[index] >= 0x81 &&
      bytes[index] <= 0xfe &&
      bytes[index + 1] >= 0x30 &&
      bytes[index + 1] <= 0x39 &&
      bytes[index + 2] >= 0x81 &&
      bytes[index + 2] <= 0xfe &&
      bytes[index + 3] >= 0x30 &&
      bytes[index + 3] <= 0x39
    ) {
      return true
    }
  }
  return false
}
