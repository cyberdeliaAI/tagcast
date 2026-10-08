"""Bounded HTTP requests for iBroadcast OAuth, using its TokenSet and endpoints.

The upstream helpers have no request timeout. Keep device polling's approval
interval separate from the timeout of each individual HTTP request.
"""

import time

import requests
from ibroadcast import oauth

REQUEST_TIMEOUT = 45


def device_code_request(client_id, scopes):
    response = requests.get(oauth.DEVICE_CODE_URL,
                            params={"client_id": client_id, "scope": " ".join(scopes)},
                            timeout=REQUEST_TIMEOUT)
    if not response.ok:
        raise oauth.OAuthError(f"Device code request failed: HTTP {response.status_code}.")
    return response.json()


def _token_request(data):
    return requests.post(oauth.TOKEN_URL, data=data, timeout=REQUEST_TIMEOUT)


def _tokens(response, action):
    if not response.ok:
        raise oauth.OAuthError(f"{action} failed: HTTP {response.status_code}.")
    return oauth.TokenSet.from_response(response.json())


def poll_for_token(client_id, device_code, interval=5):
    while True:
        time.sleep(interval)
        response = _token_request({"grant_type": "device_code", "client_id": client_id,
                                   "device_code": device_code})
        data = response.json()
        if response.ok:
            return oauth.TokenSet.from_response(data)
        error = data.get("error", "")
        if error == "authorization_pending":
            continue
        if error == "slow_down":
            interval += 5
            continue
        if error == "expired_token":
            raise oauth.OAuthError("Device code expired. Please restart the authorization flow.")
        if error == "access_denied":
            raise oauth.OAuthError("Authorization was denied by the user.")
        raise oauth.OAuthError(f"Token polling failed: {error} - {data.get('error_description', '')}")


def exchange_auth_code(client_id, code, redirect_uri, code_verifier):
    return _tokens(_token_request({"grant_type": "authorization_code", "client_id": client_id,
                                   "code": code, "redirect_uri": redirect_uri,
                                   "code_verifier": code_verifier}), "Auth code exchange")


def refresh_access_token(client_id, refresh_token):
    response = _token_request({"grant_type": "refresh_token", "client_id": client_id,
                               "refresh_token": refresh_token})
    if not response.ok:
        raise oauth.OAuthError(f"Token refresh failed: HTTP {response.status_code}.")
    data = response.json()
    data.setdefault("refresh_token", refresh_token)
    return oauth.TokenSet.from_response(data)


def revoke_token(client_id, refresh_token):
    response = requests.post(oauth.REVOKE_URL,
                             data={"client_id": client_id, "refresh_token": refresh_token},
                             timeout=REQUEST_TIMEOUT)
    if not response.ok:
        raise oauth.OAuthError(f"Token revocation failed: HTTP {response.status_code}.")
