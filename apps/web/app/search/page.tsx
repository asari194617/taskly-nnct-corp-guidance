import type { Metadata } from "next";
import GuidanceApp from "../../components/guidance-app";

export const metadata: Metadata = {
  title: "探す | 企業ガイダンス | Taskly",
  alternates: { canonical: "/search/" },
};

export default function Page() {
  return <GuidanceApp initialView="search" />;
}
