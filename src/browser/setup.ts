const key = document.getElementById("letter-key") as HTMLElement;
const copy = document.getElementById("copy-key") as HTMLButtonElement;

// The Copy button needs this script, so it stays hidden without it; the key can still be selected by hand.
copy.hidden = false;
copy.addEventListener("click", async () => {
  await navigator.clipboard.writeText(key.textContent ?? "");
  copy.textContent = "Copied";
});
