import type { Metadata } from "next";
import { Zilla_Slab, Hanken_Grotesk, Martian_Mono } from "next/font/google";
import "@cc/tokens/tokens.css";
import "./globals.css";

/*
 * Self-hosted at build. No external font request ships, which is most of the
 * LCP budget on a mid-range Android over mobile data.
 */
const display = Zilla_Slab({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-display-face",
  display: "swap",
});

const body = Hanken_Grotesk({
  subsets: ["latin"],
  variable: "--font-body-face",
  display: "swap",
});

const mono = Martian_Mono({
  subsets: ["latin"],
  weight: ["500", "600"],
  variable: "--font-mono-face",
  display: "swap",
});

export const metadata: Metadata = { title: "The Creative Current" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-ZA" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
