// Synthetic demo world: every business, PAN, GSTIN, TAN, Udyam number, and address is invented.

export const company = {
  name: "Sharma Homeware Industries",
  constitution: "Partnership firm",
  addressLines: ["Plot 14, MIDC Bhosari", "Pune 411026, Maharashtra"],
  pan: "AAQFS5521K",
  gstin: "27AAQFS5521K1Z3",
  udyamNumber: "UDYAM-MH-26-0048213",
  partner: "Rakesh Sharma",
  accountsEmail: "accounts@sharmahomeware.example",
  salesEmail: "sales@sharmahomeware.example",
  bankLine: "Konkan Mercantile Bank Ltd, Bhosari branch, A/c 004211700048213, IFSC KONK0000417",
} as const;

export const buyer = {
  name: "Apex Retail Pvt Ltd",
  addressLines: ["Unit 302, Marol Industrial Estate", "Andheri East, Mumbai 400059"],
  warehouse: "Apex Retail Pvt Ltd warehouse, Bhiwandi, Thane 421302",
  gstin: "27AAJCA4417R1ZQ",
  purchaseContact: "Neha Kulkarni",
  purchaseEmail: "purchase@apexretail.example",
  payablesContact: "Vikram Shah",
  payablesEmail: "payables@apexretail.example",
  storesContact: "Sanjay More",
  storesEmail: "stores@apexretail.example",
} as const;

export type Region = "North" | "South" | "East" | "West";

export const regions: readonly Region[] = ["North", "South", "East", "West"];

export interface Product {
  sku: string;
  name: string;
  category: string;
  /** Distributor price per unit before GST, in rupees. */
  rate: number;
  /** Maximum retail price per unit including GST, in rupees. */
  mrp: number;
  hsn: string;
}

export const GST_RATE_PERCENT = 18;

export const products: readonly Product[] = [
  {
    sku: "SHI-CNT-1000",
    name: "Airtight Container 1 L",
    category: "Storage Containers",
    rate: 95,
    mrp: 199,
    hsn: "3924",
  },
  {
    sku: "SHI-CNT-SET3",
    name: "Airtight Container Set of 3",
    category: "Storage Containers",
    rate: 240,
    mrp: 499,
    hsn: "3924",
  },
  {
    sku: "SHI-BTL-1000",
    name: "Insulated Water Bottle 1 L",
    category: "Bottles",
    rate: 210,
    mrp: 449,
    hsn: "3924",
  },
  {
    sku: "SHI-BTL-750",
    name: "Sports Bottle 750 ml",
    category: "Bottles",
    rate: 85,
    mrp: 179,
    hsn: "3924",
  },
  {
    sku: "SHI-LBX-3C",
    name: "Lunch Box 3 Compartment",
    category: "Lunch Boxes",
    rate: 165,
    mrp: 349,
    hsn: "3924",
  },
  {
    sku: "SHI-LBX-INS",
    name: "Insulated Lunch Box",
    category: "Lunch Boxes",
    rate: 290,
    mrp: 599,
    hsn: "3924",
  },
  {
    sku: "SHI-ORG-SPICE",
    name: "Spice Rack Organiser",
    category: "Kitchen Organisers",
    rate: 140,
    mrp: 299,
    hsn: "3924",
  },
  {
    sku: "SHI-ORG-TRAY",
    name: "Drawer Organiser Tray",
    category: "Kitchen Organisers",
    rate: 110,
    mrp: 229,
    hsn: "3924",
  },
];

export function productBySku(sku: string): Product {
  const product = products.find((candidate) => candidate.sku === sku);

  if (!product) {
    throw new Error(`Unknown demo product "${sku}".`);
  }

  return product;
}

export function productCategories(): string[] {
  return [...new Set(products.map((product) => product.category))];
}
