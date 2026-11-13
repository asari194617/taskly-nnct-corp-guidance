import type { Metadata } from "next";
import "@openameba/spindle-tokens/spindle-tokens.css";
import "@openameba/spindle-ui/index.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "企業ガイダンス | Taskly",
  description:
    "企業との出会いを、次の一歩へ。企業検索・見学スケジュール・会場案内をひとつに。",
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
