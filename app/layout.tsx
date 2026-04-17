import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Quantsink Pro Broadcast Zone",
  description: "Master Luxury UI for Quantsink Pro Broadcast Zone",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        {/* eslint-disable-next-line @next/next/no-page-custom-font -- loaded globally from App Router root layout */}
        <link
          href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <div className="min-h-screen bg-brand-bg text-brand-text">
          {children}
        </div>
      </body>
    </html>
  );
}
