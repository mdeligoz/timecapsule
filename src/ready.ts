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
