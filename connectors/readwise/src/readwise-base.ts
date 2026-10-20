/**
 * The Readwise origin, in ONE place: the read tools and the sync walk both import it. There is no
 * environment or argument override — the SaaS host is fixed — so the only way to point either at
 * another host is to substitute this module in a test-only build.
 */
export const READWISE_BASE = "https://readwise.io";
