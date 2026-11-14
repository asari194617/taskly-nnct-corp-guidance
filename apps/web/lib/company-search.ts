export function googleCompanySearchURL(companyName: string): string {
  const url = new URL("https://google.com/search");
  url.searchParams.set("q", companyName);
  return url.toString();
}
