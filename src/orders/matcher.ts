/**
 * Maps what the buyer wrote ("boat smart watches") to catalog SKUs.
 * Returns ambiguous when several products fit equally well, so the bot asks
 * which one instead of guessing.
 */
import { all, json } from "../db.ts";

export interface Product {
  sku: string;
  name: string;
  brand: string;
  category: string;
  aliases: string[];
  unit: string;
  unit_price: number;
  gst_rate: number;
  hsn: string;
  on_hand: number;
}

export type MatchResult =
  | { status: "matched"; product: Product }
  | { status: "ambiguous"; candidates: Product[] }
  | { status: "none" };

export async function allProducts(): Promise<Product[]> {
  return (await all("SELECT * FROM products ORDER BY category, name")).map((r) => ({
    ...(r as unknown as Product),
    aliases: json.parse<string[]>(r.aliases, []),
  }));
}

export async function getProduct(sku: string): Promise<Product> {
  const p = (await allProducts()).find((x) => x.sku === sku);
  if (!p) throw new Error(`Unknown SKU ${sku}`);
  return p;
}

function singular(w: string): string {
  if (/(ches|shes|xes|sses)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

function tokens(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter(Boolean).map(singular);
}

const compact = (s: string) => tokens(s).join("");

export function matchProduct(productText: string, brand: string | null, products: Product[]): MatchResult {
  const query = tokens(`${brand ?? ""} ${productText}`);
  if (!query.length) return { status: "none" };
  const queryCompact = query.join("");

  const scored = products.map((p) => {
    const brandToks = tokens(p.brand);
    const vocab = new Set([...tokens(p.name), ...tokens(p.category), ...p.aliases.flatMap(tokens), ...brandToks]);
    const phrases = [p.name, p.category, ...p.aliases].map(compact);
    let score = 0;
    let brandHit = false;
    for (const q of query) {
      if (brandToks.includes(q) || compact(p.brand) === q) {
        score += 3;
        brandHit = true;
      } else if (vocab.has(q)) {
        score += 1;
      }
    }
    // "smartwatch" vs "smart watch", "powerbank" vs "power bank"
    if (phrases.some((ph) => ph.length > 3 && (queryCompact.includes(ph) || ph.includes(queryCompact)))) score += 1;
    return { p, score, brandHit };
  });

  // A brand alone ("100 boAt") is not enough to pick a product unless the brand has only one.
  const relevant = scored.filter((s) => s.score > 0 && (s.score > 3 || !s.brandHit)).sort((a, b) => b.score - a.score);
  if (!relevant.length) {
    const brandOnly = scored.filter((s) => s.brandHit).map((s) => s.p);
    if (brandOnly.length === 1) return { status: "matched", product: brandOnly[0] };
    if (brandOnly.length > 1) return { status: "ambiguous", candidates: brandOnly };
    return { status: "none" };
  }
  const top = relevant[0].score;
  const best = relevant.filter((s) => s.score === top);
  if (best.length === 1) return { status: "matched", product: best[0].p };
  return { status: "ambiguous", candidates: best.map((s) => s.p) };
}
