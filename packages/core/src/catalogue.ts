/**
 * Starter catalogue: generic Indian-standard sizes (mm). Brand catalogues come later.
 * `width` runs along the item's front, `depth` front to back.
 * `frontClearance` is the free space needed in front for use.
 */
import type { FurnitureItem, Mm } from './model';
import type { Rect } from './geometry';

export interface CatalogueItem {
  id: string;
  name: string;
  category: 'furniture' | 'appliance' | 'sanitary' | 'vehicle';
  width: Mm;
  depth: Mm;
  height: Mm;
  frontClearance: Mm;
  /** Has a left/right variant (e.g. sofa with chaise). */
  handed?: boolean;
  aliases: string[];
  priceInr?: [number, number];
}

export const CATALOGUE: CatalogueItem[] = [
  { id: 'sofa-3-chaise', name: '3-seater sofa with chaise', category: 'furniture', width: 2400, depth: 1600, height: 850, frontClearance: 750, handed: true, aliases: ['sofa with chaise', 'l sofa', 'l-shaped sofa', 'chaise sofa'], priceInr: [45000, 120000] },
  { id: 'sofa-3', name: '3-seater sofa', category: 'furniture', width: 2100, depth: 900, height: 850, frontClearance: 750, aliases: ['sofa', '3 seater', 'three seater'], priceInr: [30000, 90000] },
  { id: 'bed-queen', name: 'Queen bed', category: 'furniture', width: 1650, depth: 2100, height: 450, frontClearance: 600, aliases: ['bed', 'queen bed', 'double bed'], priceInr: [25000, 70000] },
  { id: 'bed-king', name: 'King bed', category: 'furniture', width: 1950, depth: 2100, height: 450, frontClearance: 600, aliases: ['king bed', 'king size bed'], priceInr: [35000, 90000] },
  { id: 'wardrobe-3', name: '3-door wardrobe', category: 'furniture', width: 1800, depth: 600, height: 2100, frontClearance: 600, aliases: ['wardrobe', 'cupboard', 'almirah'], priceInr: [40000, 110000] },
  { id: 'dining-6', name: '6-seater dining', category: 'furniture', width: 1800, depth: 900, height: 750, frontClearance: 750, aliases: ['dining table', 'dining', '6 seater dining'], priceInr: [30000, 90000] },
  { id: 'dining-4', name: '4-seater dining', category: 'furniture', width: 1200, depth: 800, height: 750, frontClearance: 750, aliases: ['4 seater dining', 'small dining'], priceInr: [18000, 50000] },
  { id: 'tv-unit', name: 'TV unit', category: 'furniture', width: 1800, depth: 400, height: 500, frontClearance: 900, aliases: ['tv unit', 'tv console'], priceInr: [15000, 50000] },
  { id: 'oonjal', name: 'Oonjal (swing)', category: 'furniture', width: 1500, depth: 600, height: 450, frontClearance: 900, aliases: ['oonjal', 'swing', 'jhula'], priceInr: [20000, 80000] },
  { id: 'fridge-dd', name: 'Double-door fridge', category: 'appliance', width: 700, depth: 700, height: 1750, frontClearance: 900, aliases: ['fridge', 'refrigerator'], priceInr: [30000, 80000] },
  { id: 'washing-machine', name: 'Front-load washing machine', category: 'appliance', width: 600, depth: 600, height: 850, frontClearance: 700, aliases: ['washing machine', 'wm'], priceInr: [25000, 60000] },
  { id: 'wc-floor', name: 'Floor-mounted WC', category: 'sanitary', width: 380, depth: 700, height: 400, frontClearance: 600, aliases: ['wc', 'commode', 'toilet seat'], priceInr: [6000, 25000] },
  { id: 'wash-basin', name: 'Wash basin', category: 'sanitary', width: 500, depth: 420, height: 850, frontClearance: 500, aliases: ['basin', 'wash basin', 'sink in toilet', 'lavatory'], priceInr: [2500, 15000] },
  { id: 'shower', name: 'Shower area', category: 'sanitary', width: 900, depth: 900, height: 2100, frontClearance: 0, aliases: ['shower', 'shower area', 'bath area'], priceInr: [3000, 20000] },
  { id: 'kitchen-counter', name: 'Kitchen counter with sink and hob', category: 'sanitary', width: 2400, depth: 600, height: 850, frontClearance: 900, aliases: ['kitchen counter', 'counter', 'platform', 'kitchen platform', 'cooking platform'], priceInr: [40000, 200000] },
  { id: 'car-sedan', name: 'Sedan', category: 'vehicle', width: 1750, depth: 4500, height: 1500, frontClearance: 0, aliases: ['sedan', 'car'], priceInr: undefined },
  { id: 'car-suv', name: 'Compact SUV', category: 'vehicle', width: 1800, depth: 4000, height: 1650, frontClearance: 0, aliases: ['suv', 'compact suv'], priceInr: undefined },
];

export function getCatalogueItem(id: string): CatalogueItem | undefined {
  return CATALOGUE.find((c) => c.id === id);
}

/** Best catalogue match for free text like "sofa with chaise". */
export function matchCatalogue(text: string): CatalogueItem | undefined {
  const t = text.toLowerCase();
  let best: { item: CatalogueItem; score: number } | undefined;
  for (const item of CATALOGUE) {
    for (const phrase of [item.name.toLowerCase(), ...item.aliases]) {
      if (t.includes(phrase)) {
        const score = phrase.length;
        if (!best || score > best.score) best = { item, score };
      }
    }
  }
  return best?.item;
}

/** Axis-aligned footprint of a placed item (rotation in multiples of 90°). */
export function itemFootprint(f: FurnitureItem): Rect {
  const c = getCatalogueItem(f.catalogueId);
  const w = f.size?.width ?? c?.width ?? 1000;
  const d = f.size?.depth ?? c?.depth ?? 600;
  const quarter = (((Math.round(f.rotation / 90) % 4) + 4) % 4);
  const [sx, sy] = quarter % 2 === 0 ? [w, d] : [d, w];
  return { x0: f.at.x - sx / 2, x1: f.at.x + sx / 2, y0: f.at.y - sy / 2, y1: f.at.y + sy / 2 };
}
