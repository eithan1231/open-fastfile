// A private lobby's invite, as a link: this page's own address with `?join=<code>`.
//
// A query parameter and not the fragment, because the fragment is already a
// pose link (`#slug@x,y,z,...`) and the two mean different things. This module
// is the one place that spelling exists, so writing a link and reading one
// cannot disagree about it.

import { lobbyCode } from "@3d/shared/protocol/routes/matchmaking.js";

const PARAM = "join";

export function inviteUrl(code: string): string {
  const url = new URL(location.pathname, location.origin);
  url.searchParams.set(PARAM, code);
  return url.href;
}

/**
 * The code this page was opened with, if any, taken off the address bar as it
 * is read — or a reload would join the lobby again, possibly one the player has
 * since left on purpose.
 */
export function takeInviteCode(): string | undefined {
  const url = new URL(location.href);
  const code = url.searchParams.get(PARAM)?.trim().toUpperCase();
  if (code === undefined) {
    return undefined;
  }
  url.searchParams.delete(PARAM);
  history.replaceState(null, "", url.pathname + url.search + url.hash);
  return lobbyCode.safeParse(code).success ? code : undefined;
}
