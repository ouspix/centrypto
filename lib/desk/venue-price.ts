import { formatPrice } from "@nktkas/hyperliquid/utils";

// Shortest round-tripping decimal avoids toFixed introducing binary tails before
// the venue formatter truncates. Expand exponent notation without rounding.
export function decimalPrice(value: number): string {
    if (!Number.isFinite(value) || value <= 0) throw new Error("Invalid venue price.");
    const text = String(value);
    if (!/[eE]/.test(text)) return text;
    const [coefficient, exponent] = text.toLowerCase().split("e");
    const [whole, fraction = ""] = coefficient.split(".");
    const digits = whole + fraction, point = whole.length + Number(exponent);
    return point <= 0 ? "0." + "0".repeat(-point) + digits
        : point >= digits.length ? digits + "0".repeat(point - digits.length)
        : digits.slice(0, point) + "." + digits.slice(point);
}
export function venuePrice(value: number, szDecimals: number, perp: boolean): number {
    return Number(formatPrice(decimalPrice(value), szDecimals, perp));
}

// Synthetic limits round inward so quantization cannot spend more slippage
// than the caller allowed. Actual user-supplied sell limits remain validated.
export function venueLimitPrice(value:number,szDecimals:number,perp:boolean,buy:boolean):number {
  const rounded=venuePrice(value,szDecimals,perp);
  if(buy || rounded>=value)return rounded;
  const decimals=(perp?6:8)-szDecimals;
  const tick=value>=100000 ? 1 : Math.max(10**(-decimals),10**(Math.floor(Math.log10(value))-4));
  return venuePrice(Number((rounded+tick).toFixed(Math.max(0,decimals))),szDecimals,perp);
}
