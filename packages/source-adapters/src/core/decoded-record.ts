/** Keep exact normalized JSON byte accounting while lending the already-decoded
 * object to the parser. The temporary encoding is released rather than parsed again. */
export function encodeRecordValue(value: Record<string, unknown>, retainRawRecords: boolean) {
  if (retainRawRecords) return { rawJson: JSON.stringify(value) };
  let bodyBytes = 0;
  // Let the native serializer own object/array/scalar semantics. Large strings
  // are counted in bounded chunks and replaced by empty strings in the skeleton.
  const skeleton = JSON.stringify(value, (_key, child: unknown) => {
    if (typeof child !== "string" || child.length < 16_384) return child;
    bodyBytes += jsonStringBytes(child) - 2;
    return "";
  });
  return { rawJson: "", parsedValue: value, rawSizeBytes: Buffer.byteLength(skeleton, "utf8") + bodyBytes };
}

function jsonStringBytes(text: string): number {
  let bytes = Buffer.byteLength(text, "utf8") + 2;
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + 16_384);
    if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!) && /[\uDC00-\uDFFF]/u.test(text[end]!)) end--;
    const part = text.slice(start, end);
    bytes += part.match(/["\\\b\t\n\f\r]/gu)?.length ?? 0;
    bytes += (part.match(/[\u0000-\u0007\u000b\u000e-\u001f]/gu)?.length ?? 0) * 5;
    // Buffer encodes an unpaired surrogate as three bytes; JSON writes six.
    bytes += (part.match(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g)?.length ?? 0) * 3;
    start = end;
  }
  return bytes;
}
