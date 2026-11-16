/** Minimal wire reader for Antigravity's recorded protobuf messages. Unknown
 * fields remain skippable; invalid tags, lengths and unsafe counters fail loudly. */
export interface ProtoField { number: number; wire: number; value: number | Buffer }

export function readVarint(bytes: Buffer, offset: number, allowWide = false): { value: number; end: number } {
  let value = 0n;
  for (let index = 0; index < 10 && offset + index < bytes.length; index++) {
    const byte = bytes[offset + index]!;
    if (index === 9 && byte > 1) throw new Error("Invalid protobuf varint");
    value |= BigInt(byte & 127) << BigInt(index * 7);
    if (byte < 128) {
      if (!allowWide && value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Unsafe protobuf integer");
      return { value: Number(value), end: offset + index + 1 };
    }
  }
  throw new Error("Truncated protobuf varint");
}

export function protobuf(bytes: Uint8Array): ProtoField[] {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fields: ProtoField[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const tag = readVarint(buffer, offset);
    offset = tag.end;
    const number = Math.floor(tag.value / 8);
    const wire = tag.value % 8;
    if (number < 1 || number > 536_870_911) throw new Error("Invalid protobuf tag");
    if (wire === 0) {
      const scalar = readVarint(buffer, offset, true);
      fields.push({ number, wire, value: scalar.value });
      offset = scalar.end;
      continue;
    }
    let length: number;
    if (wire === 2) {
      const size = readVarint(buffer, offset);
      length = size.value;
      offset = size.end;
    } else if (wire === 1 || wire === 5) {
      length = wire === 1 ? 8 : 4;
    } else throw new Error(`Unsupported protobuf wire type ${wire}`);
    if (length > buffer.length - offset) throw new Error("Truncated protobuf field");
    fields.push({ number, wire, value: buffer.subarray(offset, offset + length) });
    offset += length;
  }
  return fields;
}

export function message(fields: ProtoField[], number: number): ProtoField[] {
  // Protobuf singular messages merge across occurrences.
  return fields.filter(field => field.number === number).flatMap(field => {
    if (field.wire !== 2 || !Buffer.isBuffer(field.value)) throw new Error(`Invalid protobuf message ${number}`);
    return protobuf(field.value);
  });
}

export function scalar(fields: ProtoField[], number: number): number | undefined {
  const matches = fields.filter(field => field.number === number);
  for (const field of matches) if (field.wire !== 0 || !Number.isSafeInteger(field.value)) throw new Error(`Invalid protobuf counter ${number}`);
  return matches.at(-1)?.value as number | undefined;
}

export function string(fields: ProtoField[], number: number): string | undefined {
  const matches = fields.filter(field => field.number === number);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let result: string | undefined;
  for (const field of matches) {
    if (field.wire !== 2 || !Buffer.isBuffer(field.value)) throw new Error(`Invalid protobuf string ${number}`);
    result = decoder.decode(field.value);
  }
  return result || undefined;
}

export function timestamp(fields: ProtoField[], number: number): string | undefined {
  const nested = message(fields, number);
  const seconds = scalar(nested, 1);
  const nanos = scalar(nested, 2) ?? 0;
  if (seconds === undefined) return undefined;
  if (seconds > 253_402_300_799 || nanos > 999_999_999) throw new Error("Invalid protobuf timestamp");
  return new Date(seconds * 1000 + Math.floor(nanos / 1_000_000)).toISOString();
}

export function indices(fields: ProtoField[], number: number): number[] {
  const result: number[] = [];
  for (const field of fields.filter(field => field.number === number)) {
    if (field.wire === 0) result.push(field.value as number);
    else if (field.wire === 2 && Buffer.isBuffer(field.value)) {
      let offset = 0;
      while (offset < field.value.length) {
        const item = readVarint(field.value, offset);
        result.push(item.value);
        offset = item.end;
      }
    } else throw new Error("Invalid protobuf step indices");
  }
  return result;
}
