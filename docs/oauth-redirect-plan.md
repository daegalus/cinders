# OAuth Redirect Handling Plan

Cinders should support clean browser-return flows without relying on users to copy a final redirect URL from a web page. The implementation should still degrade cleanly when a provider or desktop environment cannot use the preferred callback style.

## Goals

- Use short-lived callback handlers that exist only while an OAuth flow is active.
- Show a real browser confirmation response after callback capture instead of a `404` or blank page.
- Prefer redirect methods that do not require provider secrets in the app.
- Keep manual paste as a fallback until every provider path is proven.
- Avoid globally binding a long-lived HTTP server in the background.

## Redirect Options

### Loopback HTTP Callback

Use this for providers that support native app loopback redirects.

- Default address: `http://127.0.0.1:15713/oauth/callback`
- If port `15713` is unavailable, fall back to an OS-assigned high port for that flow.
- Start the local HTTP server only after the user starts the OAuth flow.
- Shut the server down immediately after one terminal outcome:
  - authorization code captured,
  - OAuth error captured,
  - dialog closed or flow reset,
  - timeout reached.
- Return a small HTML response to the browser:
  - success: "Cinders received the authorization response. You can return to the app."
  - error: "Cinders received an OAuth error. Return to the app for details."
- Continue token exchange inside Cinders after the callback is captured.

### Desktop URI Scheme Callback

Use this where providers accept custom URI schemes, or as a future alternative to loopback.

Preferred scheme:

```text
dev.yulian.cinders://oauth/<provider>/callback?code=...&state=...
```

Optional friendly alias:

```text
cinders://oauth/<provider>/callback?code=...&state=...
```

The reverse-domain scheme should be the primary OAuth scheme because it is less collision-prone than plain `cinders://`.

Implementation notes:

- Add desktop MIME handlers:

```ini
MimeType=x-scheme-handler/dev.yulian.cinders;x-scheme-handler/cinders;
```

- Run the application with `Gio.ApplicationFlags.HANDLES_OPEN`.
- Implement `Application.vfunc_open()` to receive callback URIs.
- Route callback URIs to the active OAuth request by matching `state`.
- Auto-exchange the authorization code after a matching callback.
- Keep manual paste available if URI dispatch is unavailable or untrusted.

## Provider Strategy

### GitHub

Keep device flow.

- No redirect callback needed.
- Device code polling should remain visible in the UI.

### GitLab

Keep device flow for now.

- No redirect callback needed.
- If we later add PKCE for GitLab, use loopback first.

### Codeberg

Use loopback callback first.

- Current Codeberg OAuth client must include the loopback redirect URI.
- If Codeberg accepts custom schemes, add `dev.yulian.cinders://oauth/codeberg/callback` as an additional redirect.
- Keep manual paste until loopback has been tested.

### Forgejo and Gitea

Use provider-configurable redirect support.

- For known/default instances, prefer loopback.
- For arbitrary self-hosted instances, allow the UI/config to surface the required redirect URI so users can register it in that instance.
- Custom scheme support may vary by instance, so treat it as optional.

### Tangled / AT Protocol

Keep the hosted callback until client metadata is updated.

- Current metadata uses:

```text
https://yulian.dev/cinders/oauth/callback
```

- To support loopback or custom schemes, add those redirect URIs to the hosted AT Protocol client metadata first.
- Candidate future redirects:

```text
http://127.0.0.1:15713/oauth/callback
dev.yulian.cinders://oauth/tangled/callback
```

- After metadata changes are hosted and verified, Cinders can choose the best redirect at runtime.

## Implementation Tasks

- Add a small loopback callback helper in OAuth plumbing.
- Add an active OAuth callback registry keyed by `state`.
- Wire PKCE browser flows to start the loopback server before opening the browser.
- Auto-exchange the code on callback capture.
- Add browser confirmation HTML for success and error callbacks.
- Add timeout and cleanup paths for active callback servers.
- Register desktop URI schemes in the desktop file.
- Add application URI handling with `Gio.ApplicationFlags.HANDLES_OPEN`.
- Route custom-scheme callbacks through the same active OAuth callback registry.
- Preserve manual paste fields as a fallback path.
- Update provider docs with exact redirect URIs to register.

## Validation

- Build with `flatpak-builder --force-clean build-dir dev.yulian.CindersDevel.json`.
- Install the local Flatpak and verify desktop URI registration.
- Test Codeberg OAuth using loopback callback.
- Test one self-hosted Forgejo or Gitea instance using loopback callback.
- Re-test Tangled after hosted metadata includes any new redirect URI.
- Verify each flow shuts down its temporary listener after completion or cancellation.
