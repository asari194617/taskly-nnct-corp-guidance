import type { Metadata } from "next";
import GuidanceApp from "../../components/guidance-app";

export const metadata: Metadata = {
  title: "スケジュール | 企業ガイダンス | Taskly",
  alternates: { canonical: "/schedule/" },
};

export default function Page() {
  return <GuidanceApp initialView="schedule" />;
}
