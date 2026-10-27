import { Html, html } from "./markup";

// Counts down on the finished page, then turns Open timecapsule on. It sits inside the page: right after setup,
// Access can already catch a request for a separate script, and the button would then work at once. Counted from
// when the page loaded, so the browser's clock being off does not matter.
const COUNTDOWN = new Html(`<script>
(() => {
  const ready = document.querySelector(".ready");
  const button = ready.querySelector("a");
  const countdown = document.createElement("p");
  countdown.setAttribute("role", "status");
  ready.before(countdown);
  const end = Date.now() + Number(ready.dataset.wait);
  button.removeAttribute("href");
  button.setAttribute("aria-disabled", "true");
  const tick = () => {
    const left = Math.ceil((end - Date.now()) / 1000);
    if (left > 0) {
      countdown.textContent =
        "Your login is getting ready: " + Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0");
      return;
    }
    clearInterval(timer);
    countdown.textContent = "Your login is ready.";
    button.href = "/";
    button.removeAttribute("aria-disabled");
  };
  const timer = setInterval(tick, 1000);
  tick();
})();
</script>`);

// Open timecapsule, held for waitMs, what is left of the login's wait. Without scripts it works at once.
export function openWhenReady(waitMs: number): Html {
  return html`<p class="ready" data-wait="${waitMs}"><a class="button" href="/">Open timecapsule</a></p>
${COUNTDOWN}
<p>The login takes up to 3 minutes to start working. Until then, timecapsule can show an error or this page.</p>`;
}

// Finish setup says it is working as soon as the form is sent, and cannot send it twice. It sits inside the page for
// the same reason as the countdown: on a restore, Access can already catch a request for a separate script. A page
// shown again, by Back or a reload, starts ready to send; Firefox would otherwise keep the button switched off.
const WORKING = new Html(`<script>
(() => {
  const finish = document.getElementById("finish-setup");
  const working = document.getElementById("setup-status");
  const ready = () => {
    finish.disabled = false;
    finish.textContent = "Finish setup";
    working.textContent = "";
  };
  addEventListener("pageshow", ready);
  finish.form.addEventListener("submit", () => {
    finish.disabled = true;
    finish.textContent = "Setting up…";
    working.textContent = "Setting up your login and storage. Keep this page open until it finishes.";
  });
})();
</script>`);

// The setup form's last part: its button, the line that says setup is working, and the script behind both.
export function finishButton(): Html {
  return html`<button class="button" type="submit" id="finish-setup">Finish setup</button>
<p class="hint" id="setup-status" role="status"></p>
${WORKING}`;
}
