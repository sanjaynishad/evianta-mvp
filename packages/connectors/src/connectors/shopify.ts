import { productBySku, products } from "../data/business.js";
import { shopifyLineTotal, shopifyOrderLines } from "../data/sales.js";
import { createDemoConnector, CSV_MIME_TYPE, textFile, type DemoItem } from "../demo.js";
import { toCsv } from "../format.js";

const STOCK_ON_HAND: Readonly<Record<string, number>> = {
  "SHI-CNT-1000": 420,
  "SHI-CNT-SET3": 180,
  "SHI-BTL-1000": 260,
  "SHI-BTL-750": 340,
  "SHI-LBX-3C": 210,
  "SHI-LBX-INS": 95,
  "SHI-ORG-SPICE": 150,
  "SHI-ORG-TRAY": 0,
};

function ordersCsv(): string {
  return toCsv(
    [
      "Order",
      "Order Date",
      "Region",
      "Product",
      "Product Type",
      "Quantity",
      "Unit Price",
      "Discount",
      "Total",
      "Financial Status",
    ],
    shopifyOrderLines.map((line) => {
      const product = productBySku(line.sku);

      return [
        line.order,
        line.date,
        line.region,
        product.name,
        product.category,
        line.quantity,
        line.unitPrice,
        line.discount,
        shopifyLineTotal(line),
        line.status,
      ];
    }),
  );
}

function productsCsv(): string {
  return toCsv(
    ["Handle", "Title", "Product Type", "SKU", "Price", "Inventory", "Status"],
    products.map((product) => [
      product.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      product.name,
      product.category,
      product.sku,
      product.mrp,
      STOCK_ON_HAND[product.sku] ?? 0,
      "active",
    ]),
  );
}

const orderCount = new Set(shopifyOrderLines.map((line) => line.order)).size;
const refundCount = shopifyOrderLines.filter((line) => line.status === "refunded").length;

const items: Record<string, DemoItem> = {
  orders: {
    label: "Orders: Jul to Sep 2026",
    detail: `${orderCount} orders, ${shopifyOrderLines.length} lines, ${refundCount} ${refundCount === 1 ? "refund" : "refunds"}`,
    fileName: "shopify-orders-jul-sep-2026.csv",
    mimeType: CSV_MIME_TYPE,
    buildAsync: () => textFile(ordersCsv()),
  },
  products: {
    label: "Products: online store catalogue",
    detail: `${products.length} products with retail prices including GST`,
    fileName: "shopify-products-catalogue.csv",
    mimeType: CSV_MIME_TYPE,
    buildAsync: () => textFile(productsCsv()),
  },
};

export const shopifyConnector = createDemoConnector("shopify", items);
