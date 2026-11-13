import type { Metadata } from "next";
import GuidanceApp from "../../components/guidance-app";

export const metadata: Metadata = {
  title: "配布資料の案内 | 企業ガイダンス | Taskly",
  alternates: { canonical: "/documents/" },
};

export default function Page() {
  return <GuidanceApp initialView="info" />;
}
