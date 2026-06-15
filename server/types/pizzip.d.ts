declare module "pizzip" {
  interface PizZipObject {
    asText(): string;
    asUint8Array(): Uint8Array;
    asNodeBuffer(): Buffer;
  }

  interface GenerateOptions {
    type?: "nodebuffer" | "uint8array" | "base64" | "string";
    compression?: "STORE" | "DEFLATE";
  }

  class PizZip {
    constructor(data?: Buffer | Uint8Array | string, options?: Record<string, unknown>);
    file(name: string): PizZipObject | null;
    file(name: string, content: string | Buffer | Uint8Array): PizZip;
    generate(options?: GenerateOptions): Buffer;
  }

  export = PizZip;
}
