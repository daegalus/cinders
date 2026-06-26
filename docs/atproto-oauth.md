# AT Protocol OAuth

Cinders uses a public native AT Protocol OAuth client for Tangled sign-in.

Host `docs/atproto-oauth-client-metadata.json` at:

```text
https://yulian.dev/cinders/atproto-oauth-client-metadata.json
```

Verify it before testing Tangled sign-in:

```sh
curl -I https://yulian.dev/cinders/atproto-oauth-client-metadata.json
```

If that URL returns `404`, the user's PDS will reject the pushed
authorization request before Cinders can open the browser sign-in flow.

The configured redirect URIs are:

```text
https://yulian.dev/cinders/oauth/callback
http://127.0.0.1:15713/oauth/callback
```

The loopback callback is preferred and lets Cinders finish Tangled sign-in
automatically. The hosted callback page remains the fallback. It can be static
and only needs to leave the final redirected URL visible so it can be pasted
back into Cinders for token exchange.

The current Tangled notification reader still calls Tangled's web notification endpoints. If Tangled does not accept DPoP bearer tokens for those endpoints, we will need either a Tangled appview API endpoint for OAuth bearer sessions or a different notification source.
