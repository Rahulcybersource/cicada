import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SOLARIUS OPS | Enterprise AIOps Observability",
  description:
    "Enterprise AIOps Observability Platform with privacy-first edge telemetry, multivariate anomaly detection, and explainable RCA.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[#F9F7F4] text-[#18181B] antialiased font-sans">
        {children}
      </body>
    </html>
  );
}
