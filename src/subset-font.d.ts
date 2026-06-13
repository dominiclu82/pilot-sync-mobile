// subset-font 沒附型別宣告 → 補一個最小宣告（給 Logbook PDF 的中日韓字型 subset 用）。
declare module 'subset-font' {
  export default function subsetFont(
    font: Buffer | Uint8Array,
    text: string,
    options?: { targetFormat?: 'sfnt' | 'woff' | 'woff2' | 'truetype'; preserveNameIds?: number[]; variationAxes?: Record<string, number> }
  ): Promise<Buffer>;
}
