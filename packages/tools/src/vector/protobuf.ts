/** Minimal Protocol Buffers wire-format reading and writing, for OSM PBF and Mapbox Vector Tiles. */

/** Reads fields from a protobuf message. */
export class ProtoReader {
  pos: number;
  readonly end: number;

  constructor(
    readonly buf: Uint8Array,
    start = 0,
    end = buf.length,
  ) {
    this.pos = start;
    this.end = end;
  }

  /** Reads an unsigned varint (up to 2^53). */
  varint(): number {
    let value = 0;
    let factor = 1;
    for (;;) {
      const byte = this.buf[this.pos++] ?? 0;
      value += (byte & 0x7f) * factor;
      if (byte < 0x80) return value;
      factor *= 128;
    }
  }

  /** Reads a zigzag-encoded signed varint. */
  svarint(): number {
    const value = this.varint();
    return value % 2 === 1 ? -(value + 1) / 2 : value / 2;
  }

  /** Reads a length-delimited field as a sub-reader. */
  message(): ProtoReader {
    const length = this.varint();
    const reader = new ProtoReader(this.buf, this.pos, this.pos + length);
    this.pos += length;
    return reader;
  }

  /** Reads a length-delimited field's bytes. */
  bytes(): Uint8Array {
    const length = this.varint();
    const out = this.buf.subarray(this.pos, this.pos + length);
    this.pos += length;
    return out;
  }

  /** Reads a length-delimited UTF-8 string. */
  string(): string {
    return new TextDecoder().decode(this.bytes());
  }

  /** Reads a packed repeated varint field (zigzag when `signed`). */
  packed(signed: boolean): number[] {
    const sub = this.message();
    const out: number[] = [];
    while (sub.pos < sub.end) out.push(signed ? sub.svarint() : sub.varint());
    return out;
  }

  /** Skips a field of the given wire type. */
  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) {
      // Read the length first: `this.pos += this.varint()` would add it to the position before the varint.
      const length = this.varint();
      this.pos += length;
    } else if (wire === 5) this.pos += 4;
    else throw new Error(`protobuf: unsupported wire type ${wire}`);
  }

  /** Calls `field(tag, wire)` for every field; the callback must consume or skip the value. */
  forEach(field: (tag: number, wire: number) => void): void {
    while (this.pos < this.end) {
      const key = this.varint();
      field(Math.floor(key / 8), key & 7);
    }
  }
}

/** Builds a protobuf message. */
export class ProtoWriter {
  private readonly bytes: number[] = [];

  /** Writes an unsigned varint. */
  varint(value: number): this {
    let v = value;
    while (v >= 0x80) {
      this.bytes.push((v % 128) | 0x80);
      v = Math.floor(v / 128);
    }
    this.bytes.push(v);
    return this;
  }

  /** Writes a varint field. */
  uint(tag: number, value: number): this {
    return this.varint(tag * 8).varint(value);
  }

  /** Writes a zigzag signed varint field. */
  sint(tag: number, value: number): this {
    return this.uint(tag, value < 0 ? -value * 2 - 1 : value * 2);
  }

  /** Writes a length-delimited field. */
  raw(tag: number, data: Uint8Array): this {
    this.varint(tag * 8 + 2).varint(data.length);
    for (const byte of data) this.bytes.push(byte);
    return this;
  }

  /** Writes a string field. */
  string(tag: number, text: string): this {
    return this.raw(tag, new TextEncoder().encode(text));
  }

  /** Writes a packed repeated varint field. */
  packed(tag: number, values: number[], signed: boolean): this {
    const inner = new ProtoWriter();
    for (const v of values) inner.varint(signed ? (v < 0 ? -v * 2 - 1 : v * 2) : v);
    return this.raw(tag, inner.finish());
  }

  /** Writes a 64-bit double field. */
  double(tag: number, value: number): this {
    this.varint(tag * 8 + 1);
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value, true);
    for (let i = 0; i < 8; i++) this.bytes.push(view.getUint8(i));
    return this;
  }

  /** The encoded message. */
  finish(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}
