import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { Providers } from "@/components/providers";
import { Analytics } from "@/components/analytics";
import { AppShell } from "@/components/shell/app-shell";
import { cn } from "@/lib/utils";
import "./globals.css";

export const metadata: Metadata = {
  referrer: "no-referrer",
  title: {
    default: "Evianta",
    template: "%s | Evianta",
  },
  description:
    "Professional work completed by coordinated specialists, with evidence you can check.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0e1116" },
  ],
};

interface RootLayoutProps {
  children: ReactNode;
  caseContext: ReactNode;
}

export default function RootLayout({ children, caseContext }: RootLayoutProps) {
  return (
    <html
      lang="en-IN"
      suppressHydrationWarning
      className={cn(GeistSans.variable, GeistMono.variable)}
    >
      <body>
        <Analytics />
        <Providers>
          <AppShell caseContext={caseContext}>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
