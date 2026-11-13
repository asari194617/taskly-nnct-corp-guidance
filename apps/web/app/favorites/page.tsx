import type { Metadata } from "next";
import GuidanceApp from "../../components/guidance-app";

export const metadata: Metadata = {
  title: "気になる | 企業ガイダンス | Taskly",
  alternates: { canonical: "/favorites/" },
};

export default function Page() {
  return <GuidanceApp initialView="plan" />;
}
