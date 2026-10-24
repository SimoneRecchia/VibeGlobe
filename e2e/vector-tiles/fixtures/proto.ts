// A minimal protocol buffers writer for the fixtures (varints, zigzag, doubles, length-delimited fields), so the
// fixture generator needs no dependency of its own (ADR 0131).

/** Writes one message's fields; nested messages are written by a callback into a fresh writer. */
export class ProtoWriter {
  private bytes: number[] = [];

  private varint(value: number): void {
    let v = value;
    while (v > 127) {
      this.bytes.push((v % 128) | 128);
      v = Math.floor(v / 128);
    }
    this.bytes.push(v);
  }

  private key(field: number, wire: number): void {
    this.varint(field * 8 + wire);
  }

  /** An unsigned varint field. */
  uint(field: number, value: number): void {
    this.key(field, 0);
    this.varint(value);
  }

  /** A signed varint field (zigzag). */
  sint(field: number, value: number): void {
    this.uint(field, value < 0 ? -2 * value - 1 : 2 * value);
  }

  /** A boolean field. */
  bool(field: number, value: boolean): void {
    this.uint(field, value ? 1 : 0);
  }

  /** A double field. */
  double(field: number, value: number): void {
    this.key(field, 1);
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value, true);
    for (let i = 0; i < 8; i++) this.bytes.push(view.getUint8(i));
  }

  /** A length-delimited field of raw bytes. */
  raw(field: number, data: ArrayLike<number>): void {
    this.key(field, 2);
    this.varint(data.length);
    for (let i = 0; i < data.length; i++) this.bytes.push(data[i] ?? 0);
  }

  /** A string field (UTF-8). */
  string(field: number, value: string): void {
    this.raw(field, new TextEncoder().encode(value));
  }

  /** A packed field of unsigned varints. */
  packed(field: number, values: readonly number[]): void {
    const inner = new ProtoWriter();
    for (const v of values) inner.varint(v);
    this.raw(field, inner.bytes);
  }

  /** A nested message. */
  message(field: number, write: (w: ProtoWriter) => void): void {
    const inner = new ProtoWriter();
    write(inner);
    this.raw(field, inner.bytes);
  }

  /** The bytes written. */
  finish(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}
