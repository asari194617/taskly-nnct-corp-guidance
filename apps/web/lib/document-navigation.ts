export function documentHref(url: string, page?: number): string {
  const destination = new URL(url);
  if (destination.protocol !== "https:" && destination.protocol !== "http:")
    throw new Error("Unsupported document URL");
  if (Number.isInteger(page) && page! > 0) destination.hash = `page=${page}`;
  return destination.href;
}

export function navigateDocument(
  url: string,
  page?: number,
  location: Pick<Location, "assign"> = window.location,
): void {
  location.assign(documentHref(url, page));
}
