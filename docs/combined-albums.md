# iBroadcast multi-disc views

Tagcast supports reading both states of iBroadcast's **Combine Multi-Disc Album Sets**
preference. It never changes that account-wide preference. Turn it off and reload Tagcast
for full album editing; separate native discs can still be grouped visually in Tagcast.

## Identity and editing

A returned album is a visible container. Each track's original `album_id` identifies its
source disc, which may have no album row in the combined response. Track metadata writes
still target `file_id`, not either album ID. Reviews retain the visible container, original
disc and preference/shape snapshot. Before-values, one-album/one-album-artist scope, serialized
writes and fresh read-back remain required. A changed source, container or view cannot be
reported as confirmed. Uncertain requests are never resent automatically.

Combined track lists are separated into source-disc groups. Disc numbers come only from a
returned source row or a strictly parsed positive `disc-track` number; absent disc metadata
is unknown. Existing numeric track numbers remain supported. Complete source rows nested in
one larger container are not listed twice. Ambiguous membership is rejected rather than
choosing a container arbitrarily. Tagcast does not regroup native combined containers with
other albums by matching their titles.

While either the account setting is on or the downloaded library still has combined
membership:

- Track titles, artists, years, genres and credits can be reviewed and saved.
- Album title/artist/year/disc fields and track-number edits remain blocked.
- Splitting, merging and album-artist cleanup remain blocked.
- Missing per-disc album fields are not reconstructed from the container.
- Ratings retain the existing visible-album behavior; no separate-disc propagation guarantee
  is made. Other independently reviewed workflows keep their existing safeguards.

A combined response observed after the preference becomes off is treated as transitional.
It can be displayed, but cannot enable album edits or become a reusable final library cache.
Reload explicitly after iBroadcast has applied the change; there is no automatic polling
loop or account-preference toggle.

## Advice banner

A separate, dismissible banner below library information recommends disabling the preference
for full album editing. It uses the existing library/status response and makes no additional
account requests. Dismissal is local to the browser/profile and the existing opaque account
namespace. Observing the setting off with a separate library resets that dismissal. Demo,
disconnected and loading states do not show the advice. Hiding either banner does not hide
save-time warnings or bypass write guards. The editor retains its own explanation of the
read-only fields.

## Validation boundary

Regressions use explicit combined mock shapes with original rows present or absent, numeric
and disc-track positions, delayed preference/shape transitions, fresh before-values and
changed source ownership. The HTTP test saves a second-disc track and confirms that blocked
album edits cannot create an artist. Browser checks cover actual disabled controls and the
review payload. No real-account write tests or automatic setting changes are part of this
validation. Exact service-side grouping and rating propagation still require separate,
explicitly authorized service testing; the fixtures are not claims about those semantics.
