import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "SimWars · Adversarial tokenomics simulation",
  description:
    "Upload your tokenomics. Up to 5,000 LLM-powered adversaries trade, vote, and attack your design until it holds or speedruns a death spiral.",
  icons: {
    icon: "/logo-spiral.svg",
    shortcut: "/logo-spiral.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full bg-white text-foreground font-sans">
        {children}
      </body>
    </html>
  );
}
