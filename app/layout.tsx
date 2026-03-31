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
      <body>
        <div className="min-h-screen bg-brand-bg text-brand-text">
          {children}
        </div>
      </body>
    </html>
  );
}
