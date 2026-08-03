/* QR Code do PIX — gera uma imagem (data URL) a partir do código copia e cola */
function gerarQrPix(payload, tamanho) {
  try {
    const qr = qrcode(0, 'M');
    qr.addData(String(payload || ''));
    qr.make();
    return qr.createDataURL(4, 8);
  } catch (err) {
    return '';
  }
}
