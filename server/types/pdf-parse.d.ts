declare module "pdf-parse" {
  interface PdfParseResult {
    text: string;
  }

  export default function pdfParse(data: Buffer | Uint8Array | ArrayBuffer): Promise<PdfParseResult>;
}
