import type { Metadata } from "next";
import { ConvexAuthNextjsServerProvider } from "@convex-dev/auth/nextjs/server";
import { Zilla_Slab, Hanken_Grotesk, Martian_Mono } from "next/font/google";
import "@cc/tokens/tokens.css";
import "./globals.css";
import { Providers } from "@/components/Providers";

const display = Zilla_Slab({ subsets: ["latin"], weight: ["500", "600", "700"], variable: "--font-display-face", display: "swap" });
const body = Hanken_Grotesk({ subsets: ["latin"], variable: "--font-body-face", display: "swap" });
const mono = Martian_Mono({ subsets: ["latin"], weight: ["500", "600"], variable: "--font-mono-face", display: "swap" });

export const metadata: Metadata = {
  title: "Office",
  // The office is never indexed. It is not a website.
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ConvexAuthNextjsServerProvider>
      <html lang="en-ZA" className={`${display.variable} ${body.variable} ${mono.variable}`}>
        <body>
          <Providers>{children}</Providers>
        </body>
      </html>
    </ConvexAuthNextjsServerProvider>
  );
}
