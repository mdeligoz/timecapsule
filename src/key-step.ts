import { type Html, html } from "./markup";

// Step 1 of the setup page: the new encryption key to save, or on a restore the saved key to paste. It has its own
// file so the browser tests can lay it out with the real stylesheet, as they do the finished page's countdown.
export function keyStep(draft: { letterKey: string; saved: boolean; restore?: boolean }): Html {
  if (draft.restore) {
    return html`<section>
<h2>1. Paste your encryption key</h2>
<p>This app was deployed again and lost its settings. Your letters are still here, locked with the encryption key you saved when you first set up timecapsule. Paste it from your password manager.</p>
<input type="hidden" name="restore" value="1">
<label>Encryption key <input name="letter_key" type="password" value="${draft.letterKey}" required autocomplete="off" spellcheck="false"></label>
</section>`;
  }
  const checked = draft.saved ? html` checked` : html``;
  return html`<section>
<h2>1. Save your encryption key</h2>
<p>Your letters are locked with this key. Save it in your password manager now: it is shown only on this page, and if the app's copy is ever lost, your letters cannot be read without it.</p>
<p class="key"><code id="letter-key">${draft.letterKey}</code> <button class="button" type="button" id="copy-key" hidden>Copy</button></p>
<input type="hidden" name="letter_key" value="${draft.letterKey}">
<label><input type="checkbox" name="saved" required${checked}> I have saved this key in my password manager</label>
</section>`;
}
