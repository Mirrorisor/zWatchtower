// Keep secrets out of everything zWatchtower writes or posts. RPC URLs carry
// their API key in the query string (Helius: ?api-key=...), and a failed
// lookup's error message used to include the whole URL.
const PARAM = /([?&](?:api[-_]?key|apikey|key|token|access[-_]?token|secret)=)[^&\s"'\\)]+/gi;
const USERINFO = /(https?:\/\/)[^\/\s"'@]+@/gi;
export const redact = (s) => String(s).replace(PARAM, "$1[redacted]").replace(USERINFO, "$1[redacted]@");
