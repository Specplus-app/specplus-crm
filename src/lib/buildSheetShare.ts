// Build-sheet share links: /build/<64 hex chars>. Legacy links used the sheet's
// uuid, which was readable by anyone, so those are retired, not resolved.
export const BUILD_SHARE_TOKEN_RE = /^[0-9a-f]{64}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type BuildLinkKind = 'share' | 'retired' | 'invalid'

export function classifyBuildLink(param: string | undefined | null): BuildLinkKind {
  if (param && BUILD_SHARE_TOKEN_RE.test(param)) return 'share'
  if (param && UUID_RE.test(param)) return 'retired'
  return 'invalid'
}

export function buildSheetShareUrl(token: string, origin: string = window.location.origin): string {
  return `${origin}/build/${token}`
}
