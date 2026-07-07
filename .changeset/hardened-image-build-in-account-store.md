---
'anon-pi': minor
---

init: on a hardened install, build the image AS the `anon` account so it lands in that account's netcage store.

netcage's podman store is uid-scoped (`/var/tmp/netcage-storage-<uid>`), so an image built as the login user is invisible to the `anon` account that the hardened jail runs as. Previously init's image step ran the exists-check and the build as the login user even when hardened, so the image landed in the wrong store: the hardened launch could not see it (and the exists-check always missed, forcing a needless rebuild).

Now, on a hardened install, init crosses to the account (`sudo -u anon -i anon-pi __image-exists|__image-build ...`, the same mechanism as the launch redirect) for both the exists-check and the build, so the image is created directly in the account's own store where the jail reads it. The build streams as before. Non-hardened installs are unchanged. New internal subcommands `__image-exists`/`__image-build` and the pure `shippedImageTag`. Because each account's store is separate by design (persona isolation), a hardened persona builds its own copy; there is no shared image store.
