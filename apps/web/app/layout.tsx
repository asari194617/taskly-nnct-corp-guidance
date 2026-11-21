import type { Metadata } from "next";
import "@openameba/spindle-tokens/dist/css/spindle-tokens-animation.css";
import "@openameba/spindle-tokens/dist/css/spindle-tokens-font.css";
import "@openameba/spindle-tokens/dist/css/spindle-tokens-spacing-mobile.css";
import "@openameba/spindle-ui/index.css";
import "./globals.css";

const title = "企業ガイダンス | Taskly";
const description =
  "企業情報、見学スケジュール、指定企業、会場マップを確認できます。";
const ogImage = "/ogp.jpg";

export const metadata: Metadata = {
  metadataBase: new URL("https://nnct-corp-guidance-2026.taskly.iy0306.com"),
  title,
  description,
  alternates: { canonical: "/" },
  robots: { index: false, follow: false },
  icons: {
    icon: {
      url: "https://cdn.taskly.iy0306.com/assets/favicon.webp",
      type: "image/webp",
    },
    apple: "https://cdn.taskly.iy0306.com/assets/apple-touch-icon.png",
  },
  openGraph: {
    type: "website",
    siteName: "Taskly",
    title,
    description,
    url: "/",
    locale: "ja_JP",
    images: [{ url: ogImage, type: "image/jpeg", width: 1920, height: 1080 }],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: [{ url: ogImage, type: "image/jpeg", width: 1920, height: 1080 }],
  },
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
