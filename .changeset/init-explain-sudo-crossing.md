---
'anon-pi': patch
---

init / persona add: explain the sudo prompt before crossing into the account.

On a hardened install, some steps run AS the `anon` (or `anon-<name>`) account via `sudo -u <account> -i anon-pi ...`, which triggers a `[sudo] password for <you>` prompt. During onboarding this appeared with no explanation (e.g. right after choosing an image, the exists-check crosses to the account). anon-pi now prints a short heads-up before each such crossing: "Crossing into `<account>` to <step> (sudo may ask for YOUR password)...", so the prompt is never a surprise. Covers the image exists-check + build, and the mode-700 workspace write for both init and persona add. The day-to-day launch redirect is left quiet (a per-launch line would be noise).
