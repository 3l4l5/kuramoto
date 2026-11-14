/**
 * ダウンロードの名前を、応答の Content-Disposition から取る(`filename*=UTF-8''…` を優先、なければ `filename="…"`、どちらも無ければ fallback)。
 * ダウンロードのリンク(<a download>)はブラウザが Authorization を付けないので、画面は fetch(Bearer など API と同じ道)で取って Blob で保存する。
 */
export function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1]!.trim());
    } catch {
      // 壊れた符号化は、ふつうの filename に進む
    }
  }
  const plain = /filename="([^"]+)"/i.exec(header);
  return plain ? plain[1]! : fallback;
}

/** 取った中身を、名前をつけて保存する(ダウンロードの印つきのリンクを、画面の外に出さずに押す)。 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  // 保存が始まる前に解放しないよう、少し待つ
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
