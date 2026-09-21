/* The WalletConnect client and a QR encoder, and nothing of Warda's.
   /app fetches this only when somebody presses "Connect with WalletConnect";
   the console holds no key and asks for no signature either way. */
import { SignClient } from "@walletconnect/sign-client";
import QRCode from "qrcode";
export { SignClient };
export function qrSvg(text) {
  return QRCode.toString(text, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
}
