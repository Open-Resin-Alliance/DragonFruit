import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { HotkeyProvider } from "@/hotkeys/HotkeyContext";
import { RendererCrashDiagnostics } from "@/components/debug/RendererCrashDiagnostics";
import { AppLogger } from "@/components/AppLogger";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "DragonFruit",
  description: "DragonFruit by Open Resin Alliance",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      style={{
        background: 'var(--background, #0b0f14)',
        color: 'var(--foreground, #e6ebf2)',
      }}
    >
      <body
        suppressHydrationWarning
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
        style={{
          background: 'var(--background, #0b0f14)',
          color: 'var(--foreground, #e6ebf2)',
        }}
      >
        <HotkeyProvider>
          <AppLogger />
          <RendererCrashDiagnostics />
          {children}
        </HotkeyProvider>
      </body>
    </html>
  );
}
