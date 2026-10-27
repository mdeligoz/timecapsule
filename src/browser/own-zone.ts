// Picks the browser's own zone in a zone list. The list uses the older name of some zones (Asia/Calcutta,
// Europe/Kiev) where Firefox and Safari give the newer one (Asia/Kolkata, Europe/Kyiv); the server accepts both, so a
// name the list does not have is added to it in order.
export function pickOwnZone(zone: HTMLSelectElement): string {
  const own = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const options = [...zone.options];
  if (!options.some((option) => option.value === own)) {
    zone.add(new Option(own, own), options.find((option) => option.value > own) ?? null);
  }
  zone.value = own;
  return own;
}
