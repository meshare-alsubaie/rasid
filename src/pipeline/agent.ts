/**
 * How this crawler identifies itself.
 *
 * Spec section 5.1 asks for a contact address in the User-Agent, which is the
 * polite convention: a site owner who dislikes the traffic can reach a human.
 * The address is deliberately NOT hard-coded. Baking a personal email into
 * every outbound request header publishes it to every host we touch, and that
 * is the owner's call to make, not ours. Set RASID_CONTACT to opt in:
 *
 *   RASID_CONTACT="you@example.com" npm run collect
 *
 * In CI, set it as a repository secret and pass it into the workflow env.
 */
const contact = process.env.RASID_CONTACT?.trim();

export const USER_AGENT = contact
  ? `RASID-CoopTracker/1.0 (personal student project; contact: ${contact})`
  : "RASID-CoopTracker/1.0 (personal student project; set RASID_CONTACT for a contact address)";

export const HAS_CONTACT = Boolean(contact);

/** Spec section 5.1: 20s timeout, 2 retries, 2 concurrent, 1.5s per host. */
export const TIMEOUT_MS = 20_000;
export const MAX_RETRIES = 2;
export const MAX_CONCURRENT = 2;
export const PER_HOST_GAP_MS = 1_500;
