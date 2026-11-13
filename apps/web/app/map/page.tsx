import type { Metadata } from "next";
import GuidanceApp from "../../components/guidance-app";

export const metadata: Metadata = {
  title: "会場マップ | 企業ガイダンス | Taskly",
  alternates: { canonical: "/map/" },
};

export default function Page() {
  return <GuidanceApp initialView="map" />;
}
