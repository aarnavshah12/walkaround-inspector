import type { Metadata, Viewport } from "next";
import "./globals.css";
import SwRegister from "../components/sw-register";

export const metadata: Metadata = {
  title: "Walkaround Inspector",
  description:
    "Timestamped walkaround video inspections — record, hash, and prove the condition of a rental car before you drive off.",
  icons: { apple: "/icons/apple-touch-icon.png" },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Walkaround",
  },
};

export const viewport: Viewport = {
  themeColor: "#08080d",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <a href="/" className="brand">
            <span className="brand-mark" aria-hidden />
            Walkaround
          </a>
          <a href="/verify" className="topbar-link">
            Verify a report
          </a>
        </header>
        {children}
        <SwRegister />
      </body>
    </html>
  );
}
